use std::fs;
#[cfg(target_os = "macos")]
use std::fs::OpenOptions;
use std::io;
#[cfg(target_os = "macos")]
use std::io::Write;
#[cfg(target_os = "macos")]
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
#[cfg(target_os = "macos")]
use std::process::{Child, Command, Stdio};

#[cfg(target_os = "macos")]
use codexhost_platform::atomic_replace_file;
use serde::{Deserialize, Serialize};
#[cfg(target_os = "macos")]
use std::thread;
#[cfg(target_os = "macos")]
use std::time::{Duration, Instant};

use crate::runtime_instance::default_descriptor_path;

const ACTIVE_UPDATE_LOCK_FILE: &str = "active-update-v1.lock";
const STATUS_FILE: &str = "status-v1.json";
const REQUEST_FILE: &str = "request-v1.json";
const UPDATER_FILE: &str = "codexhost-updater";
const MAX_STATE_FILE_BYTES: u64 = 4 * 1024;
#[cfg(target_os = "macos")]
const UPDATER_READY_TIMEOUT: Duration = Duration::from_secs(10);
#[cfg(target_os = "macos")]
const UPDATER_READY_POLL: Duration = Duration::from_millis(20);

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ActiveUpdateLock {
    owner_pid: u32,
    status_path: PathBuf,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateStatusProbe {
    schema_version: u8,
    phase: String,
}

#[derive(Deserialize)]
struct UpdateRequestProbe {
    schema_version: u8,
    wait_pid: u32,
    wait_executable: PathBuf,
    status_path: PathBuf,
}

#[derive(Debug, PartialEq, Eq)]
struct PendingUpdate {
    lock_path: PathBuf,
    status_path: PathBuf,
    helper_path: PathBuf,
    request_path: PathBuf,
}

fn invalid(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.into())
}

fn read_bounded_regular_file(path: &Path) -> io::Result<Option<Vec<u8>>> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(invalid(format!(
            "update state is not a regular file: {}",
            path.display()
        )));
    }
    if metadata.len() > MAX_STATE_FILE_BYTES {
        return Err(invalid(format!(
            "update state exceeds its size limit: {}",
            path.display()
        )));
    }
    fs::read(path).map(Some)
}

fn pending_update_at(
    state_directory: &Path,
    launcher_pid: u32,
    launcher_executable: &Path,
) -> io::Result<Option<(String, PendingUpdate)>> {
    let Some(lock_bytes) =
        read_bounded_regular_file(&state_directory.join(ACTIVE_UPDATE_LOCK_FILE))?
    else {
        return Ok(None);
    };
    let lock = serde_json::from_slice::<ActiveUpdateLock>(&lock_bytes)
        .map_err(|error| invalid(format!("invalid active update lock: {error}")))?;
    if lock.owner_pid == 0 || !lock.status_path.is_absolute() {
        return Err(invalid("active update lock identity is invalid"));
    }
    if lock.status_path.file_name().and_then(|name| name.to_str()) != Some(STATUS_FILE) {
        return Err(invalid("active update status has an unexpected file name"));
    }

    let Some(status_bytes) = read_bounded_regular_file(&lock.status_path)? else {
        return Err(invalid("active update status is missing"));
    };
    let status = serde_json::from_slice::<UpdateStatusProbe>(&status_bytes)
        .map_err(|error| invalid(format!("invalid active update status: {error}")))?;
    if status.schema_version != 1 {
        return Err(invalid("active update status schema is unsupported"));
    }
    match status.phase.as_str() {
        "prepared" | "waiting-for-exit" => {}
        "downloading" | "installing" | "restarting" | "succeeded" | "failed" => return Ok(None),
        _ => return Err(invalid("active update status phase is invalid")),
    }

    let canonical_state = state_directory.canonicalize()?;
    let canonical_status = lock.status_path.canonicalize()?;
    let operation_directory = canonical_status
        .parent()
        .ok_or_else(|| invalid("active update status has no operation directory"))?;
    if operation_directory.parent() != Some(canonical_state.as_path())
        || !operation_directory
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("update-"))
    {
        return Err(invalid(
            "active update status is outside the update state directory",
        ));
    }

    let request_path = operation_directory.join(REQUEST_FILE);
    let Some(request_bytes) = read_bounded_regular_file(&request_path)? else {
        return Ok(None);
    };
    let request = serde_json::from_slice::<UpdateRequestProbe>(&request_bytes)
        .map_err(|error| invalid(format!("invalid active update request: {error}")))?;
    if request.schema_version != 1
        || request.wait_pid != launcher_pid
        || request.status_path.canonicalize()? != canonical_status
        || request.wait_executable.canonicalize()? != launcher_executable.canonicalize()?
    {
        return Err(invalid(
            "active update request does not target this Launcher",
        ));
    }

    let helper_path = operation_directory.join(UPDATER_FILE);
    let helper_metadata = fs::symlink_metadata(&helper_path)?;
    if !helper_metadata.is_file() || helper_metadata.file_type().is_symlink() {
        return Err(invalid("active update Helper is not a regular file"));
    }
    Ok(Some((
        status.phase,
        PendingUpdate {
            lock_path: state_directory.join(ACTIVE_UPDATE_LOCK_FILE),
            status_path: canonical_status,
            helper_path: helper_path.canonicalize()?,
            request_path: request_path.canonicalize()?,
        },
    )))
}

#[cfg(target_os = "macos")]
fn pending_startable_update_at(
    state_directory: &Path,
    launcher_pid: u32,
    launcher_executable: &Path,
) -> io::Result<Option<PendingUpdate>> {
    match pending_update_at(state_directory, launcher_pid, launcher_executable)? {
        Some((phase, pending)) if phase == "prepared" => Ok(Some(pending)),
        _ => Ok(None),
    }
}

fn waiting_for_launcher_exit_at(
    state_directory: &Path,
    launcher_pid: u32,
    launcher_executable: &Path,
) -> io::Result<bool> {
    Ok(matches!(
        pending_update_at(state_directory, launcher_pid, launcher_executable)?,
        Some((phase, _)) if phase == "waiting-for-exit"
    ))
}

fn update_state_directory() -> io::Result<PathBuf> {
    let descriptor = default_descriptor_path()?;
    descriptor
        .parent()
        .ok_or_else(|| invalid("runtime descriptor has no state directory"))
        .map(|parent| parent.join("updates"))
}

pub(crate) fn update_waiting_for_launcher_exit() -> io::Result<bool> {
    waiting_for_launcher_exit_at(
        &update_state_directory()?,
        std::process::id(),
        &std::env::current_exe()?,
    )
}

#[cfg(target_os = "macos")]
fn read_update_phase(status_path: &Path) -> io::Result<Option<String>> {
    let Some(status_bytes) = read_bounded_regular_file(status_path)? else {
        return Ok(None);
    };
    let status = serde_json::from_slice::<UpdateStatusProbe>(&status_bytes)
        .map_err(|error| invalid(format!("invalid active update status: {error}")))?;
    if status.schema_version != 1 {
        return Err(invalid("active update status schema is unsupported"));
    }
    Ok(Some(status.phase))
}

#[cfg(target_os = "macos")]
fn wait_for_updater_ready(child: &mut Child, status_path: &Path) -> io::Result<()> {
    let started = Instant::now();
    loop {
        match read_update_phase(status_path)?.as_deref() {
            Some("waiting-for-exit") => return Ok(()),
            Some("prepared") | None => {}
            Some("failed") => {
                return Err(invalid(
                    "background Updater failed before waiting for Launcher exit",
                ));
            }
            Some(phase) => {
                return Err(invalid(format!(
                    "background Updater reported unexpected phase {phase} before waiting for Launcher exit"
                )));
            }
        }
        if let Some(status) = child.try_wait()? {
            return Err(invalid(format!(
                "background Updater exited before waiting for Launcher exit: {status}"
            )));
        }
        if started.elapsed() >= UPDATER_READY_TIMEOUT {
            return Err(invalid(
                "background Updater did not reach waiting-for-exit before the startup timeout",
            ));
        }
        thread::sleep(UPDATER_READY_POLL);
    }
}

#[cfg(target_os = "macos")]
fn transfer_lock_to_updater(pending: &PendingUpdate, updater_pid: u32) -> io::Result<()> {
    let parent = pending
        .lock_path
        .parent()
        .ok_or_else(|| invalid("active update lock has no parent directory"))?;
    let temporary = parent.join(format!(
        ".{ACTIVE_UPDATE_LOCK_FILE}.{}.tmp",
        std::process::id()
    ));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        serde_json::to_writer(
            &mut file,
            &ActiveUpdateLock {
                owner_pid: updater_pid,
                status_path: pending.status_path.clone(),
            },
        )?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        atomic_replace_file(&temporary, &pending.lock_path).map_err(io::Error::other)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(target_os = "macos")]
pub(crate) fn start_pending_update(started_request: &mut Option<PathBuf>) -> io::Result<()> {
    if started_request.is_some() {
        return Ok(());
    }
    let Some(pending) = pending_startable_update_at(
        &update_state_directory()?,
        std::process::id(),
        &std::env::current_exe()?,
    )?
    else {
        return Ok(());
    };
    let mut child = Command::new(&pending.helper_path)
        .arg("apply")
        .arg("--request")
        .arg(&pending.request_path)
        .process_group(0)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    if let Err(error) = transfer_lock_to_updater(&pending, child.id()) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }
    // Keep the old Launcher alive until the Updater has taken its wait position.
    if let Err(error) = wait_for_updater_ready(&mut child, &pending.status_path) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }
    *started_request = Some(pending.request_path);
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    use serde_json::json;

    #[cfg(target_os = "macos")]
    use super::STATUS_FILE;
    use super::{ACTIVE_UPDATE_LOCK_FILE, PendingUpdate, waiting_for_launcher_exit_at};
    #[cfg(target_os = "macos")]
    use super::{
        atomic_replace_file, pending_startable_update_at, pending_update_at,
        transfer_lock_to_updater, wait_for_updater_ready,
    };

    fn fixture_directory(label: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_nanos();
        let path =
            std::env::temp_dir().join(format!("codexhost-{label}-{}-{unique}", std::process::id()));
        fs::create_dir(&path).expect("create active update fixture");
        path
    }

    fn write_pending_update(root: &Path, launcher: &Path, launcher_pid: u32) -> PendingUpdate {
        let operation = root.join("update-1.2.3-fixture");
        fs::create_dir_all(&operation).expect("create update operation fixture");
        let helper_path = operation.join("codexhost-updater");
        fs::write(&helper_path, b"helper").expect("write Helper fixture");
        let status_path = operation.join("status-v1.json");
        fs::write(
            &status_path,
            format!(
                "{}\n",
                json!({
                    "schemaVersion": 1,
                    "version": "1.2.3",
                    "installation": "macos-dmg",
                    "phase": "prepared",
                    "updatedAt": 1,
                })
            ),
        )
        .expect("write update status fixture");
        let request_path = operation.join("request-v1.json");
        fs::write(
            &request_path,
            format!(
                "{}\n",
                json!({
                    "schema_version": 1,
                    "version": "1.2.3",
                    "wait_pid": launcher_pid,
                    "wait_executable": launcher,
                    "status_path": status_path,
                    "installation": { "kind": "macos-dmg" },
                })
            ),
        )
        .expect("write update request fixture");
        fs::write(
            root.join(ACTIVE_UPDATE_LOCK_FILE),
            format!("{}\n", json!({ "ownerPid": 42, "statusPath": status_path })),
        )
        .expect("write active update lock fixture");
        PendingUpdate {
            lock_path: root.join(ACTIVE_UPDATE_LOCK_FILE),
            status_path: status_path
                .canonicalize()
                .expect("canonical status fixture"),
            helper_path: helper_path
                .canonicalize()
                .expect("canonical Helper fixture"),
            request_path: request_path
                .canonicalize()
                .expect("canonical request fixture"),
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn resolves_only_a_request_for_the_current_launcher() {
        let fixture = fixture_directory("pending-update");
        let root = fixture.join("updates");
        fs::create_dir(&root).expect("create update root");
        let launcher = fixture.join("codexhost");
        fs::write(&launcher, b"launcher").expect("write Launcher fixture");
        let expected = write_pending_update(&root, &launcher, 42);

        assert_eq!(
            pending_startable_update_at(&root, 42, &launcher).expect("resolve pending update"),
            Some(expected)
        );
        assert!(pending_update_at(&root, 43, &launcher).is_err());
        fs::remove_dir_all(fixture).expect("remove pending update fixture");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn waits_for_the_updater_ready_handshake_before_returning() {
        let fixture = fixture_directory("updater-ready");
        let status_path = fixture.join(STATUS_FILE);
        fs::write(
            &status_path,
            format!(
                "{}\n",
                json!({
                    "schemaVersion": 1,
                    "version": "1.2.3",
                    "installation": "macos-dmg",
                    "phase": "prepared",
                    "updatedAt": 1,
                })
            ),
        )
        .expect("write prepared status fixture");
        let mut child = std::process::Command::new("/bin/sleep")
            .arg("2")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("spawn updater fixture");
        let ready_status_path = status_path.clone();
        let writer = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(50));
            let temporary_status_path = ready_status_path
                .with_file_name(format!(".{STATUS_FILE}.{}.tmp", std::process::id()));
            fs::write(
                &temporary_status_path,
                format!(
                    "{}\n",
                    json!({
                        "schemaVersion": 1,
                        "version": "1.2.3",
                        "installation": "macos-dmg",
                        "phase": "waiting-for-exit",
                        "updatedAt": 2,
                    })
                ),
            )
            .expect("write waiting status fixture");
            atomic_replace_file(&temporary_status_path, &ready_status_path)
                .expect("publish waiting status fixture");
        });
        let started = std::time::Instant::now();
        wait_for_updater_ready(&mut child, &status_path).expect("wait for updater readiness");
        assert!(started.elapsed() >= std::time::Duration::from_millis(40));
        writer.join().expect("join status writer");
        child.kill().expect("stop updater fixture");
        let _ = child.wait().expect("reap updater fixture");
        fs::remove_dir_all(fixture).expect("remove updater ready fixture");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn transfers_the_active_lock_to_the_updater_process() {
        let fixture = fixture_directory("update-owner");
        let root = fixture.join("updates");
        fs::create_dir(&root).expect("create update root");
        let launcher = fixture.join("codexhost");
        fs::write(&launcher, b"launcher").expect("write Launcher fixture");
        let pending = write_pending_update(&root, &launcher, 42);

        transfer_lock_to_updater(&pending, 99).expect("transfer update lock");
        let lock = serde_json::from_slice::<serde_json::Value>(
            &fs::read(root.join(ACTIVE_UPDATE_LOCK_FILE)).expect("read transferred lock"),
        )
        .expect("parse transferred lock");
        assert_eq!(lock["ownerPid"], 99);
        assert_eq!(lock["statusPath"].as_str(), pending.status_path.to_str());
        fs::remove_dir_all(fixture).expect("remove transferred lock fixture");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn waits_until_the_final_request_exists() {
        let fixture = fixture_directory("incomplete-update");
        let root = fixture.join("updates");
        fs::create_dir(&root).expect("create update root");
        let launcher = fixture.join("codexhost");
        fs::write(&launcher, b"launcher").expect("write Launcher fixture");
        let expected = write_pending_update(&root, &launcher, 42);
        fs::remove_file(expected.request_path).expect("remove incomplete request");

        assert_eq!(
            pending_startable_update_at(&root, 42, &launcher).expect("ignore incomplete update"),
            None
        );
        fs::remove_dir_all(fixture).expect("remove incomplete update fixture");
    }

    #[test]
    fn treats_waiting_for_exit_as_a_managed_desktop_stop() {
        let fixture = fixture_directory("waiting-update");
        let root = fixture.join("updates");
        fs::create_dir(&root).expect("create update root");
        let launcher = fixture.join("codexhost");
        fs::write(&launcher, b"launcher").expect("write Launcher fixture");
        let pending = write_pending_update(&root, &launcher, 42);
        fs::write(
            &pending.status_path,
            format!(
                "{}\n",
                json!({
                    "schemaVersion": 1,
                    "version": "1.2.3",
                    "installation": "macos-dmg",
                    "phase": "waiting-for-exit",
                    "updatedAt": 2,
                })
            ),
        )
        .expect("write waiting status fixture");

        #[cfg(target_os = "macos")]
        assert_eq!(
            pending_startable_update_at(&root, 42, &launcher).expect("do not restart Helper"),
            None
        );
        assert!(waiting_for_launcher_exit_at(&root, 42, &launcher).expect("detect waiting update"));
        assert!(waiting_for_launcher_exit_at(&root, 43, &launcher).is_err());
        fs::remove_dir_all(fixture).expect("remove waiting update fixture");
    }
}
