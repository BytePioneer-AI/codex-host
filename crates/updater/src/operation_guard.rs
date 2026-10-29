//! Process-lifetime exclusion for mutations of the long-lived update record.

#[cfg(any(not(target_os = "windows"), test))]
use std::fs;
use std::fs::{File, OpenOptions};
use std::io;
use std::path::Path;
use std::time::{Duration, Instant};

pub(crate) struct OperationGuard {
    _file: File,
}
impl OperationGuard {
    pub(crate) fn acquire(state_directory: &Path) -> io::Result<Self> {
        // Keep the inode stable: file existence is not ownership, and it is never
        // unlinked on release. The kernel releases the handle on process death.
        let path = state_directory.join(".active-update-mutation.lock");
        let started = Instant::now();
        loop {
            let mut options = OpenOptions::new();
            options.read(true).write(true).create(true).truncate(false);
            #[cfg(target_os = "windows")]
            let attempt = {
                use std::os::windows::fs::OpenOptionsExt;
                // Matches Node/libuv UV_FS_O_EXLOCK, including delete exclusion.
                options.share_mode(0).open(&path)
            };
            #[cfg(not(target_os = "windows"))]
            let attempt = options.open(&path).and_then(|file| {
                file.try_lock().map_err(|error| match error {
                    fs::TryLockError::WouldBlock => io::Error::from(io::ErrorKind::WouldBlock),
                    fs::TryLockError::Error(error) => error,
                })?;
                Ok(file)
            });
            match attempt {
                Ok(file) => return Ok(Self { _file: file }),
                Err(error)
                    if error.kind() == io::ErrorKind::WouldBlock
                        || (cfg!(target_os = "windows")
                            && matches!(error.raw_os_error(), Some(32 | 33))) =>
                {
                    if started.elapsed() >= Duration::from_secs(5) {
                        return Err(io::Error::new(
                            io::ErrorKind::WouldBlock,
                            "update lock metadata is busy",
                        ));
                    }
                    std::thread::sleep(Duration::from_millis(20));
                }
                Err(error) => return Err(error),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn root(label: &str) -> std::path::PathBuf {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root =
            std::env::temp_dir().join(format!("codexhost-{label}-{}-{unique}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn serializes_native_metadata_mutations_without_breaking_a_held_guard() {
        let root = root("mutation");
        let first = OperationGuard::acquire(&root).unwrap();
        let other_root = root.clone();
        let (sender, receiver) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            let _second = OperationGuard::acquire(&other_root).unwrap();
            sender.send(()).unwrap();
        });
        assert!(receiver.recv_timeout(Duration::from_millis(40)).is_err());
        drop(first);
        receiver.recv_timeout(Duration::from_secs(2)).unwrap();
        worker.join().unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn child_exits_without_dropping_the_guard() {
        let Some(root) = std::env::var_os("CODEXHOST_TEST_GUARD_CRASH_ROOT") else {
            return;
        };
        let _guard = OperationGuard::acquire(Path::new(&root)).unwrap();
        std::process::exit(23);
    }

    #[test]
    fn abrupt_child_exit_releases_the_kernel_guard_without_unlink_or_manual_repair() {
        let root = root("mutation-crash");
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "operation_guard::tests::child_exits_without_dropping_the_guard",
            ])
            .env("CODEXHOST_TEST_GUARD_CRASH_ROOT", &root)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap();
        assert_eq!(status.code(), Some(23));
        assert!(root.join(".active-update-mutation.lock").is_file());
        let next = OperationGuard::acquire(&root).unwrap();
        drop(next);
        fs::remove_dir_all(root).unwrap();
    }
}
