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

#[cfg(any(target_os = "macos", target_os = "windows"))]
pub(crate) struct StartedUpdate {
    child: Child,
    pending: PendingUpdate,
    abort_reason: Option<String>,
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
impl StartedUpdate {
    fn stop_helper(&mut self) -> io::Result<()> {
        if self.child.try_wait()?.is_some() {
            return Ok(());
        }
        if let Err(error) = self.child.kill() {
            // The process may have exited between try_wait and kill. Otherwise
            // retain the Child so the caller can retry termination safely.
            if self.child.try_wait()?.is_none() {
                return Err(error);
            }
        }
        self.child.wait()?;
        Ok(())
    }

    pub(crate) fn abort(&mut self, error: &io::Error) -> io::Result<()> {
        let reason = self
            .abort_reason
            .get_or_insert_with(|| error.to_string())
            .clone();
        self.stop_helper()?;
        record_updater_start_failure(&self.pending, &io::Error::other(reason))
    }

    fn waiting_for_launcher_exit_at(
        &mut self,
        launcher_pid: u32,
        launcher_executable: &Path,
    ) -> io::Result<bool> {
        if let Some(reason) = self.abort_reason.clone() {
            self.abort(&io::Error::other(reason))?;
            return Ok(false);
        }
        let phase = read_update_phase(&self.pending.status_path)?;
        if matches!(phase.as_deref(), Some("failed" | "succeeded") | None) {
            self.stop_helper()?;
            return Ok(false);
        }
        let state_directory = self
            .pending
            .lock_path
            .parent()
            .ok_or_else(|| invalid("active update lock has no parent directory"))?;
        let current = pending_update_at(state_directory, launcher_pid, launcher_executable)?;
        if self.child.try_wait()?.is_some() {
            record_updater_start_failure(
                &self.pending,
                &invalid("background Updater exited after becoming ready for Launcher exit"),
            )?;
            return Ok(false);
        }
        if matches!(current, Some((phase, pending)) if phase == "waiting-for-exit" && pending == self.pending)
        {
            return Ok(true);
        }
        self.abort(&invalid(
            "active update request changed while the background Updater was waiting",
        ))?;
        Ok(false)
    }

    pub(crate) fn waiting_for_launcher_exit(&mut self) -> io::Result<bool> {
        self.waiting_for_launcher_exit_at(std::process::id(), &std::env::current_exe()?)
    }
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

#[cfg(any(target_os = "linux", test))]
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

#[cfg(target_os = "linux")]
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
    started_update: &mut Option<StartedUpdate>,
) -> io::Result<()> {
    if let Some(previous) = started_update.as_mut() {
        match previous.waiting_for_launcher_exit_at(launcher_pid, launcher_executable) {
            Ok(true) => return Ok(()),
            Ok(false) => *started_update = None,
            Err(error) => {
                if let Err(abort_error) = previous.abort(&error) {
                    return Err(io::Error::other(format!(
                        "{error}; additionally could not abort update: {abort_error}"
                    )));
                }
                *started_update = None;
                return Err(error);
            }
        }
    }
    let Some(pending) =
        pending_startable_update_at(state_directory, launcher_pid, launcher_executable)?
    else {
        return Ok(());
    };
    let child = match spawn_updater(&pending) {
        Ok(child) => child,
        Err(error) => {
            if let Err(status_error) = record_updater_start_failure(&pending, &error) {
                return Err(io::Error::other(format!(
                    "{error}; additionally could not record update failure: {status_error}"
                )));
            }
            return Err(error);
        }
    };
    // Store the Child before any fallible handoff: a failed termination must
    // never release the only handle for an Updater that could still install.
    let started = started_update.insert(StartedUpdate {
        child,
        pending,
        abort_reason: None,
    });
    let result = transfer_lock_to_updater(&started.pending, started.child.id()).and_then(|()| {
        // Keep the old Launcher alive until the Updater has taken its wait position.
        wait_for_updater_ready(&mut started.child, &started.pending.status_path)
    });
    if let Err(error) = result {
        if let Err(abort_error) = started.abort(&error) {
            return Err(io::Error::other(format!(
                "{error}; additionally could not abort update: {abort_error}"
            )));
        }
        *started_update = None;
        return Err(error);
    }
    Ok(())
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
pub(crate) fn start_pending_update(started_update: &mut Option<StartedUpdate>) -> io::Result<()> {
    start_pending_update_at(
        &update_state_directory()?,
        std::process::id(),
        &std::env::current_exe()?,
        started_update,
    )
}

#[cfg(test)]
mod tests;
