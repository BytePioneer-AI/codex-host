//! Confirm ownership before a service update can stop its native supervisor.
use std::error::Error;
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant};

use serde::Deserialize;

const ACTIVE_UPDATE_LOCK_FILE: &str = "active-update-v1.lock";
const MAX_LOCK_BYTES: u64 = 4 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ActiveUpdateLock {
    owner_pid: u32,
    status_path: PathBuf,
}

fn read_lock(path: &Path) -> Result<Option<ActiveUpdateLock>, Box<dyn Error>> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > MAX_LOCK_BYTES {
        return Err("active update lock is not a bounded regular file".into());
    }
    let mut bytes = Vec::new();
    fs::File::open(path)?
        .take(MAX_LOCK_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_LOCK_BYTES {
        return Err("active update lock exceeds its size limit".into());
    }
    let lock: ActiveUpdateLock = serde_json::from_slice(&bytes)?;
    if lock.owner_pid == 0 || !lock.status_path.is_absolute() {
        return Err("active update lock identity is invalid".into());
    }
    Ok(Some(lock))
}

pub(crate) fn wait_for_ownership(
    status_path: &Path,
    timeout: Duration,
) -> Result<(), Box<dyn Error>> {
    let state_directory = status_path
        .parent()
        .and_then(Path::parent)
        .ok_or("update status path has no state directory")?;
    let lock_path = state_directory.join(ACTIVE_UPDATE_LOCK_FILE);
    let expected_status = status_path.canonicalize()?;
    let started = Instant::now();
    loop {
        if let Some(lock) = read_lock(&lock_path)? {
            if lock.status_path.canonicalize().ok().as_ref() != Some(&expected_status) {
                return Err("active update lock belongs to a different update operation".into());
            }
            if lock.owner_pid == std::process::id() {
                return Ok(());
            }
        }
        if started.elapsed() >= timeout {
            return Err(
                "active update lock was not transferred to the Updater before timeout".into(),
            );
        }
        thread::sleep(Duration::from_millis(20).min(timeout.saturating_sub(started.elapsed())));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture {
        root: PathBuf,
        status: PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "codexhost-update-lock-{}-{:?}",
                std::process::id(),
                thread::current().id()
            ));
            let status = root.join("update-fixture/status-v1.json");
            fs::create_dir_all(status.parent().unwrap()).unwrap();
            fs::write(&status, "waiting-for-exit").unwrap();
            Self { root, status }
        }
        fn write_lock(&self, owner: u32, status: &Path) {
            fs::write(
                self.root.join(ACTIVE_UPDATE_LOCK_FILE),
                serde_json::to_vec(&serde_json::json!({"ownerPid":owner,"statusPath":status}))
                    .unwrap(),
            )
            .unwrap();
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn accepts_only_ownership_of_this_operation() {
        let fixture = Fixture::new();
        fixture.write_lock(std::process::id(), &fixture.status);
        wait_for_ownership(&fixture.status, Duration::ZERO).unwrap();
        fixture.write_lock(std::process::id(), &fixture.root.join("other-status.json"));
        assert!(
            wait_for_ownership(&fixture.status, Duration::ZERO)
                .unwrap_err()
                .to_string()
                .contains("different update operation")
        );
    }

    #[test]
    fn missing_or_different_owner_times_out_without_modifying_the_lock() {
        let fixture = Fixture::new();
        assert!(
            wait_for_ownership(&fixture.status, Duration::from_millis(10))
                .unwrap_err()
                .to_string()
                .contains("timeout")
        );
        let owner = if std::process::id() == 1 { 2 } else { 1 };
        fixture.write_lock(owner, &fixture.status);
        let before = fs::read(fixture.root.join(ACTIVE_UPDATE_LOCK_FILE)).unwrap();
        assert!(
            wait_for_ownership(&fixture.status, Duration::from_millis(10))
                .unwrap_err()
                .to_string()
                .contains("timeout")
        );
        assert_eq!(
            fs::read(fixture.root.join(ACTIVE_UPDATE_LOCK_FILE)).unwrap(),
            before
        );
    }

    #[test]
    fn rejects_oversized_and_non_regular_locks() {
        let fixture = Fixture::new();
        let lock_path = fixture.root.join(ACTIVE_UPDATE_LOCK_FILE);
        fs::write(&lock_path, vec![b' '; MAX_LOCK_BYTES as usize + 1]).unwrap();
        assert!(wait_for_ownership(&fixture.status, Duration::ZERO).is_err());
        fs::remove_file(&lock_path).unwrap();
        fs::create_dir(&lock_path).unwrap();
        assert!(wait_for_ownership(&fixture.status, Duration::ZERO).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_a_symlinked_lock() {
        let fixture = Fixture::new();
        std::os::unix::fs::symlink(&fixture.status, fixture.root.join(ACTIVE_UPDATE_LOCK_FILE))
            .unwrap();
        assert!(wait_for_ownership(&fixture.status, Duration::ZERO).is_err());
    }
}
