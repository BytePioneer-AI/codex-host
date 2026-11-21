use rustix::fs::{AtFlags, Mode, OFlags, mkdirat, openat};
#[cfg(target_os = "linux")]
use std::fs;
use std::fs::{File, Permissions};
use std::io::{self, Read, Write};
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::Path;
#[cfg(target_os = "linux")]
use std::{env, path::PathBuf};

const DIRECTORY_FLAGS: OFlags = OFlags::RDONLY
    .union(OFlags::DIRECTORY)
    .union(OFlags::NOFOLLOW)
    .union(OFlags::CLOEXEC);

fn denied() -> io::Error {
    io::Error::new(
        io::ErrorKind::PermissionDenied,
        "codexhost storage is not private and owned",
    )
}

pub(super) fn open_directory(path: &Path) -> io::Result<File> {
    Ok(File::from(rustix::fs::open(
        path,
        DIRECTORY_FLAGS,
        Mode::empty(),
    )?))
}

pub(super) fn open_child(
    directory: &File,
    name: impl rustix::path::Arg + Copy,
    create: bool,
) -> io::Result<File> {
    if create {
        match mkdirat(directory, name, Mode::from_raw_mode(0o700)) {
            Ok(()) | Err(rustix::io::Errno::EXIST) => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(File::from(openat(
        directory,
        name,
        DIRECTORY_FLAGS,
        Mode::empty(),
    )?))
}

pub(super) fn verify_directory(directory: &File, forbidden: u32) -> io::Result<()> {
    let metadata = directory.metadata()?;
    if metadata.uid() != rustix::process::geteuid().as_raw() || metadata.mode() & forbidden != 0 {
        return Err(denied());
    }
    Ok(())
}

pub(super) fn open_private_at(
    directory: &File,
    name: impl rustix::path::Arg,
    flags: OFlags,
) -> io::Result<File> {
    let file = File::from(openat(
        directory,
        name,
        flags | OFlags::NOFOLLOW | OFlags::CLOEXEC | OFlags::NONBLOCK,
        Mode::from_raw_mode(0o600),
    )?);
    let metadata = file.metadata()?;
    if !metadata.is_file()
        || metadata.uid() != rustix::process::geteuid().as_raw()
        || metadata.nlink() != 1
    {
        return Err(denied());
    }
    if flags.contains(OFlags::CREATE) {
        file.set_permissions(Permissions::from_mode(0o600))?;
    } else if metadata.mode() & 0o7777 != 0o600 {
        return Err(denied());
    }
    Ok(file)
}

pub(super) fn read_bounded(file: &File, limit: usize) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    file.take((limit + 1) as u64).read_to_end(&mut bytes)?;
    if bytes.len() > limit {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "oversized codexhost storage file",
        ));
    }
    Ok(bytes)
}

pub(super) fn publish_private_at(
    directory: &File,
    name: impl rustix::path::Arg + Copy,
    bytes: &[u8],
) -> io::Result<()> {
    match open_private_at(directory, name, OFlags::RDONLY) {
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    let temporary = format!(".{}.tmp", crate::runtime_instance::random_nonce()?);
    let mut file = open_private_at(
        directory,
        temporary.as_str(),
        OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL,
    )?;
    let result = (|| {
        file.write_all(bytes)?;
        file.sync_all()?;
        rustix::fs::renameat(directory, temporary.as_str(), directory, name)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = unlink_private_at(directory, &temporary);
    }
    result
}

pub(super) fn unlink_private_at(directory: &File, name: &str) -> io::Result<()> {
    match rustix::fs::unlinkat(directory, name, AtFlags::empty()) {
        Ok(()) | Err(rustix::io::Errno::NOENT) => Ok(()),
        Err(error) => Err(error.into()),
    }
}

#[cfg(target_os = "linux")]
#[derive(Clone, Copy)]
pub(crate) enum SecureFileOpen {
    ReadExisting,
    ReadWriteCreate,
}

#[cfg(target_os = "linux")]
fn parent_and_name(path: &Path) -> io::Result<(&Path, &std::ffi::OsStr)> {
    path.parent().zip(path.file_name()).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid codexhost storage path",
        )
    })
}

/// Creates or verifies the owned child, without changing its parent's mode.
#[cfg(target_os = "linux")]
pub(crate) fn secure_user_directory(path: &Path) -> io::Result<()> {
    let (parent, name) = parent_and_name(path)?;
    tighten_directory(&open_child(&open_directory(parent)?, name, true)?)
}

#[cfg(target_os = "linux")]
fn tighten_directory(directory: &File) -> io::Result<()> {
    verify_directory(directory, 0)?;
    if directory.metadata()?.mode() & 0o7777 != 0o700 {
        directory.set_permissions(Permissions::from_mode(0o700))?;
    }
    Ok(())
}

#[cfg(target_os = "linux")]
pub(crate) fn runtime_directory() -> io::Result<PathBuf> {
    runtime_path(true)
}

#[cfg(target_os = "linux")]
pub(crate) fn runtime_path(create: bool) -> io::Result<PathBuf> {
    let runtime = env::var_os("XDG_RUNTIME_DIR");
    let base = runtime
        .clone()
        .map(PathBuf::from)
        .or_else(|| env::var_os("XDG_STATE_HOME").map(PathBuf::from))
        .or_else(|| env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/state")))
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "HOME is unavailable"))?;
    let path = base.join("codexhost");
    if create {
        if runtime.is_some() {
            tighten_directory(&open_directory(&base)?)?;
        } else {
            fs::create_dir_all(&base)?;
            verify_directory(&open_directory(&base)?, 0)?;
        }
        secure_user_directory(&path)?;
    }
    Ok(path)
}

#[cfg(target_os = "linux")]
fn secure_file_parent(path: &Path, create: bool) -> io::Result<(File, &std::ffi::OsStr)> {
    let (parent, name) = parent_and_name(path)?;
    if create {
        secure_user_directory(parent)?;
    }
    let directory = open_directory(parent)?;
    verify_directory(&directory, 0o7077)?;
    Ok((directory, name))
}

#[cfg(target_os = "linux")]
pub(crate) fn open_secure_file(path: &Path, how: SecureFileOpen) -> io::Result<File> {
    let create = matches!(how, SecureFileOpen::ReadWriteCreate);
    let (directory, name) = secure_file_parent(path, create)?;
    open_private_at(
        &directory,
        name,
        if create {
            OFlags::RDWR | OFlags::CREATE
        } else {
            OFlags::RDONLY
        },
    )
}

#[cfg(target_os = "linux")]
pub(crate) fn publish_private(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let (directory, name) = secure_file_parent(path, true)?;
    publish_private_at(&directory, name, bytes)
}

/// Compare with the already-open descriptor before unlinking the name.
#[cfg(target_os = "linux")]
pub(crate) fn remove_secure_file(path: &Path, expected: &File) -> io::Result<()> {
    let (directory, name) = secure_file_parent(path, false)?;
    let expected = expected.metadata()?;
    let current = open_private_at(&directory, name, OFlags::RDONLY)?.metadata()?;
    if (current.dev(), current.ino()) != (expected.dev(), expected.ino()) {
        return Err(denied());
    }
    Ok(rustix::fs::unlinkat(&directory, name, AtFlags::empty())?)
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    #[test]
    fn private_storage_rejects_symlinks_hardlinks_and_fifos() {
        let base = env::temp_dir().join(crate::runtime_instance::random_nonce().unwrap());
        fs::create_dir(&base).unwrap();
        fs::set_permissions(&base, Permissions::from_mode(0o755)).unwrap();
        let directory = base.join("codexhost");
        secure_user_directory(&directory).unwrap();
        let file = directory.join("file");
        publish_private(&file, b"private").unwrap();
        assert_eq!(fs::metadata(&base).unwrap().mode() & 0o777, 0o755);
        assert_eq!(fs::metadata(&directory).unwrap().mode() & 0o777, 0o700);
        assert_eq!(fs::metadata(&file).unwrap().mode() & 0o777, 0o600);
        let dir = open_directory(&directory).unwrap();
        symlink(&file, directory.join("symlink")).unwrap();
        fs::hard_link(&file, directory.join("hardlink")).unwrap();
        rustix::fs::mknodat(
            &dir,
            "fifo",
            rustix::fs::FileType::Fifo,
            Mode::from_raw_mode(0o600),
            0,
        )
        .unwrap();
        for name in ["symlink", "hardlink", "fifo"] {
            assert!(open_private_at(&dir, name, OFlags::RDONLY).is_err());
            assert!(publish_private_at(&dir, name, b"replacement").is_err());
        }
        fs::remove_dir_all(base).unwrap();
    }
}
