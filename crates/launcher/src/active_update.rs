use std::fs;
#[cfg(any(target_os = "macos", target_os = "windows"))]
use std::fs::OpenOptions;
use std::io;
#[cfg(any(target_os = "macos", target_os = "windows"))]
use std::io::Write;
#[cfg(target_os = "macos")]
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
#[cfg(any(target_os = "macos", target_os = "windows"))]
use std::process::{Child, Command, Stdio};
#[cfg(any(target_os = "macos", target_os = "windows"))]
use std::thread;
#[cfg(any(target_os = "macos", target_os = "windows"))]
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[cfg(any(target_os = "macos", target_os = "windows"))]
use codexhost_platform::atomic_replace_file;
use serde::{Deserialize, Serialize};

use crate::runtime_instance::default_descriptor_path;

const ACTIVE_UPDATE_LOCK_FILE: &str = "active-update-v1.lock";
const STATUS_FILE: &str = "status-v1.json";
const REQUEST_FILE: &str = "request-v1.json";
#[cfg(target_os = "windows")]
const UPDATER_FILE: &str = "codexhost-updater.exe";
#[cfg(not(target_os = "windows"))]
const UPDATER_FILE: &str = "codexhost-updater";
const MAX_STATE_FILE_BYTES: u64 = 4 * 1024;
#[cfg(any(target_os = "macos", target_os = "windows"))]
const UPDATER_READY_TIMEOUT: Duration = Duration::from_secs(10);
#[cfg(any(target_os = "macos", target_os = "windows"))]
const UPDATER_READY_POLL: Duration = Duration::from_millis(20);

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ActiveUpdateLock {
    owner_pid: u32,
    status_path: PathBuf,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateStatusProbe {
    schema_version: u8,
    version: String,
    installation: String,
    phase: String,
    updated_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    downloaded_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    total_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
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

#[cfg(any(target_os = "macos", target_os = "windows"))]
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

#[cfg(any(target_os = "macos", target_os = "windows"))]
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

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn wait_for_updater_ready(child: &mut Child, status_path: &Path) -> io::Result<()> {
    let started = Instant::now();
    loop {
        let phase = read_update_phase(status_path)?;
        if let Some(status) = child.try_wait()? {
            return Err(invalid(format!(
                "background Updater exited before waiting for Launcher exit: {status}"
            )));
        }
        match phase.as_deref() {
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
        if started.elapsed() >= UPDATER_READY_TIMEOUT {
            return Err(invalid(
                "background Updater did not reach waiting-for-exit before the startup timeout",
            ));
        }
        thread::sleep(UPDATER_READY_POLL);
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
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
        drop(file);
        atomic_replace_file(&temporary, &pending.lock_path).map_err(io::Error::other)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn record_updater_start_failure(pending: &PendingUpdate, error: &io::Error) -> io::Result<()> {
    let status_bytes = read_bounded_regular_file(&pending.status_path)?
        .ok_or_else(|| invalid("active update status is missing"))?;
    let mut status = serde_json::from_slice::<UpdateStatusProbe>(&status_bytes)
        .map_err(|parse_error| invalid(format!("invalid active update status: {parse_error}")))?;
    if status.schema_version != 1 {
        return Err(invalid("active update status schema is unsupported"));
    }
    if status.phase == "failed" {
        return Ok(());
    }
    if status.phase != "prepared" && status.phase != "waiting-for-exit" {
        return Err(invalid(
            "active update status changed before startup failure",
        ));
    }
    status.phase = "failed".into();
    status.updated_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    status.downloaded_bytes = None;
    status.total_bytes = None;
    status.error = Some(error.to_string().chars().take(500).collect());
    let parent = pending
        .status_path
        .parent()
        .ok_or_else(|| invalid("active update status has no parent directory"))?;
    let temporary = parent.join(format!(".{STATUS_FILE}.{}.tmp", std::process::id()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        serde_json::to_writer(&mut file, &status)?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        drop(file);
        atomic_replace_file(&temporary, &pending.status_path).map_err(io::Error::other)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn spawn_updater(pending: &PendingUpdate) -> io::Result<Child> {
    let mut command = Command::new(&pending.helper_path);
    command
        .arg("apply")
        .arg("--request")
        .arg(&pending.request_path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(target_os = "macos")]
    {
        command.process_group(0);
    }
    #[cfg(target_os = "windows")]
    codexhost_platform::configure_background_command(&mut command);
    command.spawn()
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn start_pending_update_at(
    state_directory: &Path,
    launcher_pid: u32,
    launcher_executable: &Path,
    started_request: &mut Option<PathBuf>,
) -> io::Result<()> {
    if let Some(previous) = started_request.as_ref() {
        match read_update_phase(&previous.with_file_name(STATUS_FILE))?.as_deref() {
            Some("failed" | "succeeded") | None => *started_request = None,
            Some(_) => return Ok(()),
        }
    }
    let Some(pending) =
        pending_startable_update_at(state_directory, launcher_pid, launcher_executable)?
    else {
        return Ok(());
    };
    let result = (|| {
        let mut child = spawn_updater(&pending)?;
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
        Ok(())
    })();
    if let Err(error) = result {
        if let Err(status_error) = record_updater_start_failure(&pending, &error) {
            return Err(io::Error::other(format!(
                "{error}; additionally could not record update failure: {status_error}"
            )));
        }
        return Err(error);
    }
    *started_request = Some(pending.request_path);
    Ok(())
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
pub(crate) fn start_pending_update(started_request: &mut Option<PathBuf>) -> io::Result<()> {
    start_pending_update_at(
        &update_state_directory()?,
        std::process::id(),
        &std::env::current_exe()?,
        started_request,
    )
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    use serde_json::json;

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    use super::STATUS_FILE;
    use super::{ACTIVE_UPDATE_LOCK_FILE, PendingUpdate, waiting_for_launcher_exit_at};
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    use super::{
        atomic_replace_file, pending_startable_update_at, pending_update_at,
        record_updater_start_failure, start_pending_update_at, transfer_lock_to_updater,
        wait_for_updater_ready,
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
        let helper_path = operation.join(super::UPDATER_FILE);
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

    #[cfg(any(target_os = "macos", target_os = "windows"))]
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

    #[cfg(any(target_os = "macos", target_os = "windows"))]
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
        let mut command = std::process::Command::new(if cfg!(target_os = "windows") {
            "ping"
        } else {
            "/bin/sleep"
        });
        if cfg!(target_os = "windows") {
            command.args(["-n", "4", "127.0.0.1"]);
        } else {
            command.arg("2");
        }
        let mut child = command
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

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    #[test]
    fn does_not_accept_a_waiting_status_from_an_exited_updater() {
        let fixture = fixture_directory("exited-updater");
        let status_path = fixture.join(STATUS_FILE);
        fs::write(
            &status_path,
            format!(
                "{}\n",
                json!({
                    "schemaVersion": 1,
                    "version": "1.2.3",
                    "installation": "npm",
                    "phase": "waiting-for-exit",
                    "updatedAt": 1,
                })
            ),
        )
        .expect("write stale waiting status");
        let mut command = std::process::Command::new(if cfg!(target_os = "windows") {
            "cmd.exe"
        } else {
            "/usr/bin/true"
        });
        if cfg!(target_os = "windows") {
            command.args(["/d", "/c", "exit", "0"]);
        }
        let mut child = command.spawn().expect("spawn exiting updater fixture");
        child.wait().expect("reap exiting updater fixture");

        assert!(wait_for_updater_ready(&mut child, &status_path).is_err());
        fs::remove_dir_all(fixture).expect("remove exited updater fixture");
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
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

    #[cfg(any(target_os = "macos", target_os = "windows"))]
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

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    #[test]
    fn records_a_failed_helper_launch_without_retrying_the_prepared_request() {
        let fixture = fixture_directory("helper-start-failure");
        let root = fixture.join("updates");
        fs::create_dir(&root).expect("create update root");
        let launcher = fixture.join("codexhost");
        fs::write(&launcher, b"launcher").expect("write Launcher fixture");
        let pending = write_pending_update(&root, &launcher, 42);
        let mut started_request = None;

        assert!(start_pending_update_at(&root, 42, &launcher, &mut started_request).is_err());
        assert!(started_request.is_none());
        let status = serde_json::from_slice::<serde_json::Value>(
            &fs::read(&pending.status_path).expect("read failed update status"),
        )
        .expect("parse failed update status");
        assert_eq!(status["phase"], "failed");
        assert!(
            status["error"]
                .as_str()
                .is_some_and(|error| !error.is_empty())
        );
        assert_eq!(
            pending_startable_update_at(&root, 42, &launcher).expect("ignore failed operation"),
            None
        );
        fs::remove_dir_all(fixture).expect("remove failed update fixture");
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    #[test]
    fn preserves_a_failure_reported_by_the_helper() {
        let fixture = fixture_directory("helper-reported-failure");
        let root = fixture.join("updates");
        fs::create_dir(&root).expect("create update root");
        let launcher = fixture.join("codexhost");
        fs::write(&launcher, b"launcher").expect("write Launcher fixture");
        let pending = write_pending_update(&root, &launcher, 42);
        let original = json!({
            "schemaVersion": 1,
            "version": "1.2.3",
            "installation": "macos-dmg",
            "phase": "failed",
            "updatedAt": 2,
            "error": "Helper rejected the request",
        });
        fs::write(&pending.status_path, format!("{original}\n"))
            .expect("write Helper failure status");

        record_updater_start_failure(&pending, &std::io::Error::other("Launcher timeout"))
            .expect("preserve Helper failure");
        let status = serde_json::from_slice::<serde_json::Value>(
            &fs::read(&pending.status_path).expect("read Helper failure status"),
        )
        .expect("parse Helper failure status");
        assert_eq!(status, original);
        fs::remove_dir_all(fixture).expect("remove Helper failure fixture");
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    #[test]
    fn clears_a_completed_helper_before_considering_another_request() {
        let fixture = fixture_directory("completed-helper");
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
                    "installation": "npm",
                    "phase": "failed",
                    "updatedAt": 2,
                    "error": "Helper exited",
                })
            ),
        )
        .expect("write terminal status");
        let mut started_request = Some(pending.request_path);

        start_pending_update_at(&root, 42, &launcher, &mut started_request)
            .expect("ignore terminal operation");
        assert!(started_request.is_none());
        fs::remove_dir_all(fixture).expect("remove completed Helper fixture");
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

        #[cfg(any(target_os = "macos", target_os = "windows"))]
        assert_eq!(
            pending_startable_update_at(&root, 42, &launcher).expect("do not restart Helper"),
            None
        );
        assert!(waiting_for_launcher_exit_at(&root, 42, &launcher).expect("detect waiting update"));
        assert!(waiting_for_launcher_exit_at(&root, 43, &launcher).is_err());
        fs::remove_dir_all(fixture).expect("remove waiting update fixture");
    }
}
