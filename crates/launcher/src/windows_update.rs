//! Windows Desktop helpers must be spawned by the Launcher, outside its
//! Desktop/Host Job. Node's detached flag does not provide Job breakaway.
use super::*;
use codexhost_platform::{WindowsLaunchJob, configure_background_command, process_snapshot};
use std::io::Write;
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

pub(crate) fn start_pending_update(
    started_request: &mut Option<PathBuf>,
    desktop_job: Option<&WindowsLaunchJob>,
) -> io::Result<()> {
    start_at(
        &update_state_directory()?,
        started_request,
        desktop_job,
        |pending| {
            let mut command = Command::new(&pending.helper_path);
            command
                .args([
                    std::ffi::OsStr::new("apply"),
                    std::ffi::OsStr::new("--request"),
                    pending.request_path.as_os_str(),
                ])
                .env_remove(codexhost_platform::DESKTOP_LAUNCH_JOB_ENV)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            configure_background_command(&mut command);
            command.spawn()
        },
    )
}

pub(crate) fn waiting_outside_desktop_job(job: &WindowsLaunchJob) -> io::Result<bool> {
    let Some((phase, pending)) = pending_update_at(
        &update_state_directory()?,
        std::process::id(),
        &std::env::current_exe()?,
    )?
    else {
        return Ok(false);
    };
    if phase != "waiting-for-exit" {
        return Ok(false);
    }
    if job
        .contains_pid(record(&pending)?.owner_pid)
        .map_err(io::Error::other)?
    {
        return Err(invalid(
            "waiting Updater is inside the Desktop Job; cleanup refused",
        ));
    }
    Ok(true)
}

fn record(pending: &PendingUpdate) -> io::Result<ActiveUpdateLock> {
    serde_json::from_slice(
        &read_bounded_regular_file(&pending.lock_path)?
            .ok_or_else(|| invalid("active update lock is missing"))?,
    )
    .map_err(io::Error::other)
}

fn start_at(
    directory: &Path,
    started_request: &mut Option<PathBuf>,
    desktop_job: Option<&WindowsLaunchJob>,
    spawn: impl FnOnce(&PendingUpdate) -> io::Result<Child>,
) -> io::Result<()> {
    if started_request.is_some() {
        return Ok(());
    }
    let Some((phase, pending)) =
        pending_update_at(directory, std::process::id(), &std::env::current_exe()?)?
    else {
        return Ok(());
    };
    if phase != "prepared" {
        return Ok(());
    }
    let initial = record(&pending)?;
    if initial.operation_id.as_deref().is_none_or(str::is_empty)
        || initial.installation_started != Some(false)
    {
        return Err(invalid(
            "Launcher delegation requires an unwritten operation identity",
        ));
    }
    let result = (|| {
        if let Some(key) = std::env::var_os(codexhost_platform::DESKTOP_LAUNCH_JOB_ENV) {
            match WindowsLaunchJob::open(&key.to_string_lossy()) {
                Ok(job)
                    if job
                        .contains_pid(std::process::id())
                        .map_err(io::Error::other)? =>
                {
                    return Err(invalid(
                        "Launcher inherited a Desktop Job and cannot own an update helper",
                    ));
                }
                Ok(_) => {}
                Err(codexhost_platform::PlatformError::Io(error))
                    if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(io::Error::other(error)),
            }
        }
        if let Some(job) = desktop_job
            && job
                .contains_pid(std::process::id())
                .map_err(io::Error::other)?
        {
            return Err(invalid(
                "Launcher cannot spawn an Updater from inside its Desktop Job",
            ));
        }
        let mut child = spawn(&pending)?;
        let ready = (|| {
            if let Some(job) = desktop_job
                && job.contains_pid(child.id()).map_err(io::Error::other)?
            {
                return Err(invalid("Updater inherited the old Desktop Job"));
            }
            let deadline = Instant::now() + Duration::from_secs(10);
            loop {
                if let Some(status) = child.try_wait()? {
                    return Err(invalid(format!("Updater exited before handoff: {status}")));
                }
                match pending_update_at(directory, std::process::id(), &std::env::current_exe()?)? {
                    Some((phase, current)) if current == pending && phase == "waiting-for-exit" => {
                        let lock = record(&pending)?;
                        let instance = process_snapshot(child.id()).map_err(io::Error::other)?;
                        if lock.operation_id != initial.operation_id
                            || lock.owner_pid != child.id()
                            || lock.owner_started_at_micros.as_deref()
                                != Some(instance.started_at_micros.to_string().as_str())
                        {
                            return Err(invalid("Updater did not take this operation's lock"));
                        }
                        return Ok(());
                    }
                    Some((phase, current)) if current == pending && phase == "prepared" => {}
                    _ => return Err(invalid("update request changed or failed during handoff")),
                }
                if Instant::now() >= deadline {
                    return Err(invalid("Updater did not confirm handoff before timeout"));
                }
                thread::sleep(Duration::from_millis(20));
            }
        })();
        if ready.is_err() {
            let _ = child.kill();
            let _ = child.wait();
        }
        ready
    })();
    if let Err(error) = result {
        // Never stop the old Job on a failed handoff; leave a bounded failure
        // in the existing status rather than retrying spawn on each poll.
        let status = (|| -> io::Result<()> {
            let bytes = read_bounded_regular_file(&pending.status_path)?
                .ok_or_else(|| invalid("missing status"))?;
            let mut value: serde_json::Value = serde_json::from_slice(&bytes)?;
            value["phase"] = "failed".into();
            value["error"] = error
                .to_string()
                .chars()
                .take(500)
                .collect::<String>()
                .into();
            value["updatedAt"] = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(io::Error::other)?
                .as_secs()
                .into();
            let temporary = pending
                .status_path
                .with_file_name(format!(".launcher-failed-{}.tmp", std::process::id()));
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)?;
            let result = (|| {
                file.write_all(&serde_json::to_vec(&value)?)?;
                file.sync_all()?;
                drop(file);
                codexhost_platform::atomic_replace_file(&temporary, &pending.status_path)
                    .map_err(io::Error::other)
            })();
            if result.is_err() {
                let _ = fs::remove_file(temporary);
            }
            result
        })();
        if let Err(write_error) = status {
            eprintln!("codexhost launcher: cannot record handoff failure: {write_error}");
        }
        return Err(error);
    }
    *started_request = Some(pending.request_path);
    Ok(())
}

#[cfg(test)]
#[path = "windows_update_tests.rs"]
mod tests;
