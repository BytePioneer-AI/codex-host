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
#[cfg(target_os = "macos")]
#[allow(unsafe_code)]
#[path = "private_files_unix.rs"]
mod native;
#[cfg(all(unix, not(target_os = "macos")))]
#[path = "private_files_unix.rs"]
mod native;

/// Maximum encrypted Vault, Journal, or native credential file size.
/// IPC framing budgets account for JSON's worst-case byte-array expansion.
pub const PRIVATE_FILE_LIMIT: usize = 20 * 1024 * 1024;

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

    /// Confirms that the original directory and lock handles still match their pathnames.
    /// Callers must check immediately before and after every operation under the lease.
    pub fn assert_lock(&self, name: &str, lock: &File) -> io::Result<()> {
        check_name(name)?;
        self.native.assert_lock(name, lock)
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
        let base = std::fs::canonicalize(crate::temporary_directory("private-files")).unwrap();
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
        const HELPER: &str = "CODEXHOST_PRIVATE_LEASE_HELPER";
        const TEST_NAME: &str =
            "private_files::tests::writer_lease_is_exclusive_and_released_by_drop";

        if std::env::var(HELPER).as_deref() != Ok("1") {
            // Other parallel tests spawn processes. A fork can transiently inherit this lock
            // before CLOEXEC takes effect at exec, so run the lifecycle assertion alone.
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", TEST_NAME])
                .env(HELPER, "1")
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "lease helper failed:\nstdout:\n{}\nstderr:\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            return;
        }

        let base = std::fs::canonicalize(crate::temporary_directory("private-lock")).unwrap();
        let directory = PrivateDirectory::open(&base.join("private"), true).unwrap();
        let lease = directory.lock("writer.lock").unwrap();
        directory.assert_lock("writer.lock", &lease).unwrap();
        assert!(directory.lock("writer.lock").is_err());
        drop(lease);
        drop(directory.lock("writer.lock").unwrap());
        drop(directory);
        std::fs::remove_dir_all(base).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn writer_lease_rejects_a_replaced_lock_inode() {
        let base =
            std::fs::canonicalize(crate::temporary_directory("private-stable-lock")).unwrap();
        let path = base.join("private");
        let directory = PrivateDirectory::open(&path, true).unwrap();
        let lease = directory.lock("writer.lock").unwrap();
        directory.assert_lock("writer.lock", &lease).unwrap();

        std::fs::remove_file(path.join("writer.lock")).unwrap();
        std::fs::write(path.join("writer.lock"), b"replacement").unwrap();
        std::fs::set_permissions(
            path.join("writer.lock"),
            std::os::unix::fs::PermissionsExt::from_mode(0o600),
        )
        .unwrap();
        assert!(directory.assert_lock("writer.lock", &lease).is_err());
        drop(lease);
        drop(directory);
        std::fs::remove_dir_all(base).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn writer_lease_rejects_a_replaced_root_path() {
        let base =
            std::fs::canonicalize(crate::temporary_directory("private-stable-root")).unwrap();
        let path = base.join("private");
        let moved = base.join("moved-private");
        let directory = PrivateDirectory::open(&path, true).unwrap();
        let lease = directory.lock("writer.lock").unwrap();
        directory.assert_lock("writer.lock", &lease).unwrap();
        std::fs::rename(&path, &moved).unwrap();
        std::fs::create_dir(&path).unwrap();
        std::fs::set_permissions(&path, std::os::unix::fs::PermissionsExt::from_mode(0o700))
            .unwrap();
        assert!(directory.assert_lock("writer.lock", &lease).is_err());
        drop(lease);
        drop(directory);
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn refuses_hardlinked_files_and_oversized_writes() {
        let base = std::fs::canonicalize(crate::temporary_directory("private-invalid")).unwrap();
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

    #[test]
    fn accepts_the_full_private_file_capacity() {
        let base = std::fs::canonicalize(crate::temporary_directory("private-capacity")).unwrap();
        let directory = PrivateDirectory::open(&base.join("private"), true).unwrap();
        let content = vec![0x5a; PRIVATE_FILE_LIMIT];
        directory.replace("capacity", &content, None).unwrap();
        assert_eq!(directory.read("capacity").unwrap().unwrap(), content);
        drop(directory);
        std::fs::remove_dir_all(base).unwrap();
    }
}
