use std::fs::File;
use std::io;
use std::os::unix::fs::MetadataExt;
use std::path::{Component, Path, PathBuf};

use nix::fcntl::{OFlag, openat, renameat};
use nix::sys::stat::{Mode, mkdirat};
use nix::unistd::{UnlinkatFlags, geteuid, unlinkat};

use super::denied;

pub(super) struct Directory {
    file: File,
    path: PathBuf,
    allow_read_only_directory_access: bool,
}

fn verify(file: &File, directory: bool, allow_read_only_directory_access: bool) -> io::Result<()> {
    let metadata = file.metadata()?;
    let mode = metadata.mode() & 0o7777;
    let mode_is_safe = if directory && allow_read_only_directory_access {
        mode & 0o022 == 0
    } else {
        mode == if directory { 0o700 } else { 0o600 }
    };
    if metadata.uid() != geteuid().as_raw()
        || !mode_is_safe
        || if directory {
            !metadata.is_dir()
        } else {
            !metadata.is_file() || metadata.nlink() != 1
        }
    {
        return Err(denied());
    }
    #[cfg(target_os = "macos")]
    verify_no_extended_acl(file)?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn verify_no_extended_acl(file: &File) -> io::Result<()> {
    use std::os::fd::AsRawFd;

    const ACL_FIRST_ENTRY: i32 = 0;
    const ACL_TYPE_EXTENDED: i32 = 0x0000_0100;
    unsafe extern "C" {
        fn acl_free(object: *mut core::ffi::c_void) -> i32;
        fn acl_get_entry(
            acl: *mut core::ffi::c_void,
            entry_id: i32,
            entry: *mut *mut core::ffi::c_void,
        ) -> i32;
        fn acl_get_fd_np(fd: i32, acl_type: i32) -> *mut core::ffi::c_void;
        fn acl_valid(acl: *mut core::ffi::c_void) -> i32;
    }

    struct Acl(*mut core::ffi::c_void);
    impl Drop for Acl {
        fn drop(&mut self) {
            unsafe {
                let _ = acl_free(self.0);
            }
        }
    }

    let acl = unsafe { acl_get_fd_np(file.as_raw_fd(), ACL_TYPE_EXTENDED) };
    if acl.is_null() {
        return if std::io::Error::last_os_error().kind() == io::ErrorKind::NotFound {
            Ok(())
        } else {
            Err(denied())
        };
    }
    let acl = Acl(acl);
    if unsafe { acl_valid(acl.0) } != 0 {
        return Err(denied());
    }
    let mut entry = std::ptr::null_mut();
    let status = unsafe { acl_get_entry(acl.0, ACL_FIRST_ENTRY, &mut entry) };
    if status == 0 {
        return Err(denied());
    }
    if status != 1 {
        return Err(denied());
    }
    Ok(())
}

fn same_file(left: &File, right: &File) -> io::Result<bool> {
    let left = left.metadata()?;
    let right = right.metadata()?;
    Ok(left.dev() == right.dev() && left.ino() == right.ino())
}

impl Directory {
    pub(super) fn open(
        path: &Path,
        create: bool,
        allow_read_only_directory_access: bool,
    ) -> io::Result<Self> {
        let mut directory = File::open("/")?;
        let names = path
            .components()
            .filter_map(|part| match part {
                Component::Normal(name) => Some(name),
                _ => None,
            })
            .collect::<Vec<_>>();
        if names.is_empty() {
            return Err(denied());
        }
        for (index, name) in names.iter().enumerate() {
            let flags = OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC;
            let opened = openat(&directory, *name, flags, Mode::empty());
            let descriptor = match opened {
                Err(nix::errno::Errno::ENOENT) if create && index == names.len() - 1 => {
                    match mkdirat(&directory, *name, Mode::from_bits_truncate(0o700)) {
                        Ok(()) | Err(nix::errno::Errno::EEXIST) => {}
                        Err(error) => return Err(error.into()),
                    }
                    openat(&directory, *name, flags, Mode::empty())?
                }
                other => other?,
            };
            directory = File::from(descriptor);
        }
        verify(&directory, true, allow_read_only_directory_access)?;
        Ok(Self {
            file: directory,
            path: path.to_path_buf(),
            allow_read_only_directory_access,
        })
    }

    fn open_file(&self, name: &str, flags: OFlag) -> io::Result<File> {
        let file = File::from(openat(
            &self.file,
            name,
            flags | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC | OFlag::O_NONBLOCK,
            Mode::from_bits_truncate(0o600),
        )?);
        verify(&file, false, false)?;
        Ok(file)
    }

    pub(super) fn read(&self, name: &str) -> io::Result<Option<File>> {
        match self.open_file(name, OFlag::O_RDONLY) {
            Ok(file) => Ok(Some(file)),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error),
        }
    }
    pub(super) fn create(&self, name: &str) -> io::Result<File> {
        self.open_file(name, OFlag::O_RDWR | OFlag::O_CREAT | OFlag::O_EXCL)
    }
    pub(super) fn lock_file(&self, name: &str) -> io::Result<File> {
        self.open_file(name, OFlag::O_RDWR | OFlag::O_CREAT)
    }
    pub(super) fn assert_lock(&self, name: &str, lock: &File) -> io::Result<()> {
        verify(&self.file, true, self.allow_read_only_directory_access)?;
        verify(lock, false, false)?;
        let resolved = Self::open(&self.path, false, self.allow_read_only_directory_access)?;
        let named_lock = self.open_file(name, OFlag::O_RDONLY)?;
        if !same_file(&self.file, &resolved.file)? || !same_file(lock, &named_lock)? {
            return Err(denied());
        }
        Ok(())
    }
    pub(super) fn replace(&self, source: &str, target: &str) -> io::Result<()> {
        renameat(&self.file, source, &self.file, target).map_err(Into::into)
    }
    pub(super) fn remove(&self, name: &str) -> io::Result<()> {
        unlinkat(&self.file, name, UnlinkatFlags::NoRemoveDir).map_err(Into::into)
    }
    pub(super) fn sync(&self) -> io::Result<()> {
        self.file.sync_all()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{PermissionsExt, symlink};
    #[test]
    fn refuses_broad_modes_and_symlinks() {
        let root = std::fs::canonicalize(crate::temporary_directory("private-unix")).unwrap();
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(Directory::open(&root, false, false).is_err());
        let private = root.join("private");
        drop(Directory::open(&private, true, false).unwrap());
        symlink(&private, root.join("alias")).unwrap();
        assert!(Directory::open(&root.join("alias"), false, false).is_err());
        let directory = Directory::open(&private, false, false).unwrap();
        symlink(root.join("missing"), private.join("redirect")).unwrap();
        assert!(directory.read("redirect").is_err());
        drop(directory);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn refuses_nonempty_extended_acls() {
        use std::process::Command;

        let root = std::fs::canonicalize(crate::temporary_directory("private-macos-acl")).unwrap();
        let private = root.join("private");
        let directory = Directory::open(&private, true, false).unwrap();
        std::fs::write(private.join("value"), b"synthetic").unwrap();
        std::fs::set_permissions(
            private.join("value"),
            std::fs::Permissions::from_mode(0o600),
        )
        .unwrap();
        assert!(
            Command::new("/bin/chmod")
                .args(["+a", "everyone allow read", "value"])
                .current_dir(&private)
                .status()
                .unwrap()
                .success()
        );
        assert!(directory.read("value").is_err());
        drop(directory);
        assert!(
            Command::new("/bin/chmod")
                .args(["+a", "everyone allow read,write", "private"])
                .current_dir(&root)
                .status()
                .unwrap()
                .success()
        );
        assert!(Directory::open(&private, false, false).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}
