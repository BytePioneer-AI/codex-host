//! Generic user-private storage. No authentication or Host protocol semantics.
//! Callers must hold their writer lease and stop native writers before replacement.
use std::fs::File;
use std::io::{self, Read, Write};
use std::path::{Component, Path};
use std::sync::atomic::{AtomicU64, Ordering};

use sha2::{Digest, Sha256};

#[cfg(target_os = "windows")]
#[allow(unsafe_code)]
#[path = "private_files_windows.rs"]
mod native;
#[cfg(unix)]
#[path = "private_files_unix.rs"]
mod native;

pub const PRIVATE_FILE_LIMIT: usize = 262_144;

pub(crate) fn denied() -> io::Error {
    io::Error::new(
        io::ErrorKind::PermissionDenied,
        "private file access rejected",
    )
}

fn check_name(name: &str) -> io::Result<()> {
    let mut components = Path::new(name).components();
    if !matches!(components.next(), Some(Component::Normal(_)))
        || components.next().is_some()
        || name.contains(['/', '\\', ':', '\0'])
        || name.ends_with(['.', ' '])
    {
        return Err(denied());
    }
    Ok(())
}

#[must_use]
pub fn private_file_digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

/// Keeps directory handles open for the operation; refuses links and broad ACLs.
/// Existing user directories are never silently chmod'ed or stripped of ACLs.
pub struct PrivateDirectory {
    native: native::Directory,
}

impl PrivateDirectory {
    pub fn open(path: &Path, create: bool) -> io::Result<Self> {
        Self::open_with_read_only_directory_access(path, create, false)
    }

    /// Codex may grant its designated sandbox group read/traverse access to the native home,
    /// including a read-only ACE inherited by native auth.json on Windows. Host-owned secrets
    /// use a separate strict directory; sandbox write/delete/ownership/ACL rights are rejected.
    pub fn open_with_read_only_directory_access(
        path: &Path,
        create: bool,
        allow_read_only_directory_access: bool,
    ) -> io::Result<Self> {
        if !path.is_absolute() || path.components().any(|c| matches!(c, Component::ParentDir)) {
            return Err(denied());
        }
        Ok(Self {
            native: native::Directory::open(path, create, allow_read_only_directory_access)?,
        })
    }

    pub fn read(&self, name: &str) -> io::Result<Option<Vec<u8>>> {
        check_name(name)?;
        let Some(file) = self.native.read(name)? else {
            return Ok(None);
        };
        if file.metadata()?.len() > PRIVATE_FILE_LIMIT as u64 {
            return Err(denied());
        }
        let mut bytes = Vec::new();
        file.take((PRIVATE_FILE_LIMIT + 1) as u64)
            .read_to_end(&mut bytes)?;
        if bytes.len() > PRIVATE_FILE_LIMIT {
            return Err(denied());
        }
        Ok(Some(bytes))
    }

    /// `expected` is None for absent, or a digest of the last observed contents.
    /// This detects stale observations; it is not a lock against arbitrary writers.
    pub fn replace(&self, name: &str, bytes: &[u8], expected: Option<&str>) -> io::Result<()> {
        check_name(name)?;
        if bytes.len() > PRIVATE_FILE_LIMIT {
            return Err(denied());
        }
        self.check_expected(name, expected)?;
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let temporary = format!(
            ".private-{}-{}-{}.tmp",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|_| denied())?
                .as_nanos(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        );
        let mut file = self.native.create(&temporary)?;
        let prepared = (|| {
            file.write_all(bytes)?;
            file.sync_all()?;
            self.check_expected(name, expected)
        })();
        drop(file);
        if let Err(error) = prepared {
            let _ = self.native.remove(&temporary);
            return Err(error);
        }
        if let Err(error) = self.native.replace(&temporary, name) {
            let _ = self.native.remove(&temporary);
            return Err(error);
        }
        self.native.sync()
    }

    pub fn remove(&self, name: &str, expected: &str) -> io::Result<()> {
        check_name(name)?;
        self.check_expected(name, Some(expected))?;
        self.native.remove(name)?;
        self.native.sync()
    }

    /// The caller retains this descriptor and its advisory lock for its entire lifetime.
    pub fn lock(&self, name: &str) -> io::Result<File> {
        check_name(name)?;
        let file = self.native.lock_file(name)?;
        file.try_lock().map_err(io::Error::from)?;
        Ok(file)
    }

    fn check_expected(&self, name: &str, expected: Option<&str>) -> io::Result<()> {
        let actual = self.read(name)?;
        if actual.as_deref().map(private_file_digest).as_deref() != expected {
            return Err(io::Error::new(
                io::ErrorKind::WouldBlock,
                "private file changed",
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn private_roundtrip_and_conditional_replacement() {
        let base = crate::temporary_directory("private-files");
        let directory = PrivateDirectory::open(&base.join("private"), true).unwrap();
        directory.replace("sample", b"synthetic-one", None).unwrap();
        assert_eq!(directory.read("sample").unwrap().unwrap(), b"synthetic-one");
        assert!(directory.replace("sample", b"wrong", None).is_err());
        let first = private_file_digest(b"synthetic-one");
        directory
            .replace("sample", b"synthetic-two", Some(&first))
            .unwrap();
        assert!(directory.remove("sample", &first).is_err());
        directory
            .remove("sample", &private_file_digest(b"synthetic-two"))
            .unwrap();
        assert!(directory.read("sample").unwrap().is_none());
        assert!(
            directory
                .replace("../escape", b"never-written", None)
                .is_err()
        );
        assert!(
            directory
                .replace("sample:stream", b"never-written", None)
                .is_err()
        );
        assert_eq!(std::fs::read_dir(base.join("private")).unwrap().count(), 0);
        drop(directory);
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn writer_lease_is_exclusive_and_released_by_drop() {
        let base = crate::temporary_directory("private-lock");
        let directory = PrivateDirectory::open(&base.join("private"), true).unwrap();
        let lease = directory.lock("writer.lock").unwrap();
        assert!(directory.lock("writer.lock").is_err());
        drop(lease);
        drop(directory.lock("writer.lock").unwrap());
        drop(directory);
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn refuses_hardlinked_files_and_oversized_writes() {
        let base = crate::temporary_directory("private-invalid");
        let directory = PrivateDirectory::open(&base.join("private"), true).unwrap();
        directory.replace("sample", b"synthetic", None).unwrap();
        std::fs::hard_link(base.join("private/sample"), base.join("alias")).unwrap();
        assert!(directory.read("sample").is_err());
        assert!(
            directory
                .replace("large", &vec![0; PRIVATE_FILE_LIMIT + 1], None)
                .is_err()
        );
        drop(directory);
        std::fs::remove_dir_all(base).unwrap();
    }
}
