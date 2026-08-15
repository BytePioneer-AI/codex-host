#[cfg(target_os = "linux")]
use std::env;
#[cfg(target_os = "linux")]
use std::fs::{self, File};
#[cfg(target_os = "linux")]
use std::io;
#[cfg(target_os = "linux")]
use std::path::{Path, PathBuf};

#[cfg(target_os = "linux")]
const CODEXHOST_DIRECTORY: &str = "codexhost";

#[cfg(target_os = "linux")]
#[derive(Clone, Copy)]
pub(crate) enum SecureFileOpen {
    ReadExisting,
    ReadWriteCreate,
    WriteNew,
}

#[cfg(target_os = "linux")]
fn user_state_base() -> io::Result<PathBuf> {
    if let Some(root) = env::var_os("XDG_STATE_HOME") {
        return Ok(PathBuf::from(root));
    }
    env::var_os("HOME")
        .map(PathBuf::from)
        .map(|home| home.join(".local").join("state"))
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "HOME is unavailable"))
}

#[cfg(target_os = "linux")]
fn permission_denied(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, message)
}

#[cfg(target_os = "linux")]
fn rustix_error(error: rustix::io::Errno) -> io::Error {
    io::Error::from_raw_os_error(error.raw_os_error())
}

#[cfg(target_os = "linux")]
fn open_directory(path: &Path) -> io::Result<File> {
    use rustix::fs::{Mode, OFlags};

    let descriptor = rustix::fs::open(
        path,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .map_err(rustix_error)?;
    Ok(File::from(descriptor))
}

#[cfg(target_os = "linux")]
fn verify_owned_directory(directory: &File) -> io::Result<()> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    let metadata = directory.metadata()?;
    if !metadata.file_type().is_dir() || metadata.uid() != rustix::process::geteuid().as_raw() {
        return Err(permission_denied(
            "codexhost storage directory is not an owned directory",
        ));
    }
    if metadata.permissions().mode() & 0o777 != 0o700 {
        directory.set_permissions(fs::Permissions::from_mode(0o700))?;
    }
    let metadata = directory.metadata()?;
    if !metadata.file_type().is_dir()
        || metadata.uid() != rustix::process::geteuid().as_raw()
        || metadata.permissions().mode() & 0o777 != 0o700
    {
        return Err(permission_denied(
            "codexhost storage directory is not an owned 0700 directory",
        ));
    }
    Ok(())
}

/// Creates or verifies codexhost's own directory, not its user-controlled
/// parent. The final component is created as `0700` in the `mkdirat` call and
/// then opened relative to the parent descriptor with `O_NOFOLLOW`; an
/// inheriting permissive umask or a symlinked runtime/state root is never
/// accepted.
#[cfg(target_os = "linux")]
pub(crate) fn secure_user_directory(path: &Path) -> io::Result<()> {
    use rustix::fs::{Mode, OFlags};

    let parent = path.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "codexhost storage directory has no parent",
        )
    })?;
    let name = path.file_name().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "codexhost storage directory has no name",
        )
    })?;
    let parent = open_directory(parent)?;
    match rustix::fs::mkdirat(&parent, name, Mode::from_raw_mode(0o700)) {
        Ok(()) => {}
        Err(error) if error == rustix::io::Errno::EXIST => {}
        Err(error) => return Err(rustix_error(error)),
    }
    let directory = rustix::fs::openat(
        &parent,
        name,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .map_err(rustix_error)?;
    verify_owned_directory(&File::from(directory))
}

#[cfg(target_os = "linux")]
fn secure_child_directory(base: PathBuf, create_base: bool) -> io::Result<PathBuf> {
    if create_base {
        fs::create_dir_all(&base)?;
        // `base` may be an existing XDG state root. Do not tighten its mode:
        // it belongs to the user, while codexhost owns only the child below.
        let base_descriptor = open_directory(&base)?;
        let base_metadata = base_descriptor.metadata()?;
        use std::os::unix::fs::MetadataExt;
        if !base_metadata.file_type().is_dir()
            || base_metadata.uid() != rustix::process::geteuid().as_raw()
        {
            return Err(permission_denied(
                "codexhost state base is not an owned directory",
            ));
        }
    } else {
        let directory = open_directory(&base)?;
        verify_owned_directory(&directory)?;
    }
    let directory = base.join(CODEXHOST_DIRECTORY);
    secure_user_directory(&directory)?;
    Ok(directory)
}

#[cfg(target_os = "linux")]
pub(crate) fn runtime_directory() -> io::Result<PathBuf> {
    if let Some(root) = env::var_os("XDG_RUNTIME_DIR") {
        return secure_child_directory(PathBuf::from(root), false);
    }
    secure_child_directory(user_state_base()?, true)
}

/// Durable user state for explicit compatibility acknowledgements. Unlike a
/// runtime descriptor, this survives an XDG runtime-directory cleanup.
#[cfg(target_os = "linux")]
pub(crate) fn state_directory() -> io::Result<PathBuf> {
    secure_child_directory(user_state_base()?, true)
}

#[cfg(target_os = "linux")]
fn verify_private_file(file: &File, repair_mode: bool) -> io::Result<()> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    let metadata = file.metadata()?;
    if !metadata.file_type().is_file() || metadata.uid() != rustix::process::geteuid().as_raw() {
        return Err(permission_denied(
            "codexhost storage file is not an owned regular file",
        ));
    }
    if repair_mode {
        file.set_permissions(fs::Permissions::from_mode(0o600))?;
    }
    let metadata = file.metadata()?;
    if !metadata.file_type().is_file()
        || metadata.uid() != rustix::process::geteuid().as_raw()
        || metadata.permissions().mode() & 0o777 != 0o600
    {
        return Err(permission_denied(
            "codexhost storage file is not an owned 0600 regular file",
        ));
    }
    Ok(())
}

/// Opens a guard, descriptor, acknowledgement, or replacement file only after
/// its parent is an owned `0700` directory. The final name is resolved relative
/// to that opened directory with `O_NOFOLLOW`, so symlinks are never accepted.
#[cfg(target_os = "linux")]
pub(crate) fn open_secure_file(path: &Path, how: SecureFileOpen) -> io::Result<File> {
    use rustix::fs::{Mode, OFlags};

    let parent = path.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "codexhost storage path has no parent",
        )
    })?;
    secure_user_directory(parent)?;
    let directory = open_directory(parent)?;
    let name = path.file_name().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "codexhost storage path has no file name",
        )
    })?;
    let (flags, repair_mode) = match how {
        SecureFileOpen::ReadExisting => (OFlags::RDONLY | OFlags::CLOEXEC, false),
        SecureFileOpen::ReadWriteCreate => (OFlags::RDWR | OFlags::CREATE | OFlags::CLOEXEC, true),
        SecureFileOpen::WriteNew => (
            OFlags::RDWR | OFlags::CREATE | OFlags::EXCL | OFlags::CLOEXEC,
            true,
        ),
    };
    let descriptor = rustix::fs::openat(
        &directory,
        name,
        flags | OFlags::NOFOLLOW,
        Mode::from_raw_mode(0o600),
    )
    .map_err(rustix_error)?;
    let file = File::from(descriptor);
    verify_private_file(&file, repair_mode)?;
    Ok(file)
}

/// Removes the exact owned private regular file that was just read through an
/// already-open descriptor. The directory entry's device and inode must still
/// match that descriptor before `unlinkat`, so a pathname replacement is never
/// deleted by mistake.
#[cfg(target_os = "linux")]
pub(crate) fn remove_secure_file(path: &Path, expected: &File) -> io::Result<()> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    use rustix::fs::AtFlags;

    let expected_metadata = expected.metadata()?;
    if !expected_metadata.file_type().is_file()
        || expected_metadata.uid() != rustix::process::geteuid().as_raw()
        || expected_metadata.permissions().mode() & 0o777 != 0o600
    {
        return Err(permission_denied(
            "codexhost storage file is not an owned 0600 regular file",
        ));
    }
    let parent = path.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "codexhost storage path has no parent",
        )
    })?;
    secure_user_directory(parent)?;
    let directory = open_directory(parent)?;
    let name = path.file_name().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "codexhost storage path has no file name",
        )
    })?;
    let current =
        rustix::fs::statat(&directory, name, AtFlags::SYMLINK_NOFOLLOW).map_err(rustix_error)?;
    if rustix::fs::FileType::from_raw_mode(current.st_mode) != rustix::fs::FileType::RegularFile
        || current.st_uid != expected_metadata.uid()
        || current.st_mode & 0o777 != 0o600
        || current.st_dev != expected_metadata.dev()
        || current.st_ino != expected_metadata.ino()
    {
        return Err(permission_denied(
            "codexhost storage file changed before secure removal",
        ));
    }
    rustix::fs::unlinkat(&directory, name, AtFlags::empty()).map_err(rustix_error)
}

/// Replaces a private file using two names resolved through one verified,
/// non-symlink parent descriptor. Both components are checked before rename so
/// an attacker cannot redirect the final write through a pathname swap.
#[cfg(target_os = "linux")]
pub(crate) fn replace_secure_file(temporary: &Path, target: &Path) -> io::Result<()> {
    use rustix::fs::AtFlags;

    let parent = target.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "codexhost storage target has no parent",
        )
    })?;
    if temporary.parent() != Some(parent) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "codexhost storage replacement crosses directories",
        ));
    }
    secure_user_directory(parent)?;
    let directory = open_directory(parent)?;
    let temporary_name = temporary.file_name().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "codexhost storage temporary path has no file name",
        )
    })?;
    let target_name = target.file_name().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "codexhost storage target path has no file name",
        )
    })?;
    let temporary_metadata =
        rustix::fs::statat(&directory, temporary_name, AtFlags::SYMLINK_NOFOLLOW)
            .map_err(rustix_error)?;
    if rustix::fs::FileType::from_raw_mode(temporary_metadata.st_mode)
        != rustix::fs::FileType::RegularFile
        || temporary_metadata.st_uid != rustix::process::geteuid().as_raw()
        || temporary_metadata.st_mode & 0o777 != 0o600
    {
        return Err(permission_denied(
            "codexhost storage temporary file changed before replacement",
        ));
    }
    let target_is_unsafe = rustix::fs::statat(&directory, target_name, AtFlags::SYMLINK_NOFOLLOW)
        .is_ok_and(|target_metadata| {
            rustix::fs::FileType::from_raw_mode(target_metadata.st_mode)
                != rustix::fs::FileType::RegularFile
                || target_metadata.st_uid != rustix::process::geteuid().as_raw()
                || target_metadata.st_mode & 0o777 != 0o600
        });
    if target_is_unsafe {
        return Err(permission_denied(
            "codexhost storage target changed before replacement",
        ));
    }
    let temporary_reopened =
        rustix::fs::statat(&directory, temporary_name, AtFlags::SYMLINK_NOFOLLOW)
            .map_err(rustix_error)?;
    if temporary_reopened.st_dev != temporary_metadata.st_dev
        || temporary_reopened.st_ino != temporary_metadata.st_ino
        || temporary_reopened.st_uid != temporary_metadata.st_uid
        || temporary_reopened.st_mode != temporary_metadata.st_mode
    {
        return Err(permission_denied(
            "codexhost storage temporary file changed before replacement",
        ));
    }
    rustix::fs::renameat(&directory, temporary_name, &directory, target_name).map_err(rustix_error)
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::os::unix::fs::{MetadataExt, PermissionsExt, symlink};

    use super::{SecureFileOpen, open_secure_file, secure_user_directory};

    fn fixture(label: &str) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!(
            "codexhost-secure-storage-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system clock")
                .as_nanos()
        ));
        fs::create_dir(&path).expect("create fixture directory");
        path
    }

    #[test]
    fn makes_only_the_codexhost_directory_private() {
        let base = fixture("private");
        fs::set_permissions(&base, fs::Permissions::from_mode(0o755)).expect("set base mode");
        let directory = base.join("codexhost");
        let previous_umask = rustix::process::umask(rustix::fs::Mode::empty());
        secure_user_directory(&directory).expect("secure child");
        rustix::process::umask(previous_umask);
        assert_eq!(
            fs::metadata(&base)
                .expect("base metadata")
                .permissions()
                .mode()
                & 0o777,
            0o755
        );
        assert_eq!(
            fs::metadata(&directory)
                .expect("child metadata")
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        fs::remove_dir_all(base).expect("remove fixture");
    }

    #[test]
    fn rejects_a_symlinked_storage_file() {
        let directory = fixture("symlink");
        let target = directory.join("target");
        fs::write(&target, b"target").expect("write target");
        let path = directory.join("descriptor");
        symlink(&target, &path).expect("create symlink");
        assert!(open_secure_file(&path, SecureFileOpen::ReadExisting).is_err());
        fs::remove_dir_all(directory).expect("remove fixture");
    }

    #[test]
    fn opened_file_is_owned_private_regular_file() {
        let directory = fixture("file");
        let path = directory.join("descriptor");
        let file = open_secure_file(&path, SecureFileOpen::WriteNew).expect("open private file");
        let metadata = file.metadata().expect("metadata");
        assert!(metadata.file_type().is_file());
        assert_eq!(metadata.uid(), rustix::process::geteuid().as_raw());
        assert_eq!(metadata.permissions().mode() & 0o777, 0o600);
        drop(file);
        fs::remove_dir_all(directory).expect("remove fixture");
    }
}
