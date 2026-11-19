//! Bind a prepared update to the installation and services owned by this supervisor.
use std::fs;
use std::io;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::Value;

fn invalid(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.into())
}

fn bind_request(request: &mut Value, data: &Path, desktop_running: bool) -> io::Result<()> {
    if request["service_managed"] != true {
        return Err(invalid(
            "The Host supervisor requires a service-managed update",
        ));
    }
    let requested_data = request["data_directory"]
        .as_str()
        .map(Path::new)
        .filter(|path| path.is_absolute())
        .ok_or_else(|| invalid("The update data directory must be absolute"))?;
    if requested_data.canonicalize()? != data.canonicalize()? {
        return Err(invalid(
            "The update belongs to a different Host data directory",
        ));
    }
    request["restart_target"] =
        Value::String(if desktop_running { "desktop" } else { "web" }.into());
    Ok(())
}

pub(super) fn prepare_request(path: &Path, data: &Path) -> io::Result<()> {
    let mut request: Value = serde_json::from_slice(&fs::read(path)?)?;
    let desktop = crate::desktop_attachment::managed_processes(data)
        .map_err(|error| invalid(error.to_string()))?;
    if let Some((launcher, _)) = &desktop
        && launcher.executable.canonicalize()? != std::env::current_exe()?.canonicalize()?
    {
        return Err(invalid(
            "The running Desktop belongs to a different installation",
        ));
    }
    bind_request(&mut request, data, desktop.is_some())?;
    crate::host_service::publish_status(path, &format!("{}\n", serde_json::to_string(&request)?))
        .map_err(|error| invalid(error.to_string()))
}

pub(super) fn record_failure(path: &Path, error: &io::Error) -> io::Result<()> {
    let mut status: Value = serde_json::from_slice(&fs::read(path)?)?;
    status["phase"] = Value::String("failed".into());
    status["error"] = Value::String(error.to_string().chars().take(500).collect());
    status["updatedAt"] = Value::from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(io::Error::other)?
            .as_secs(),
    );
    crate::host_service::publish_status(path, &format!("{}\n", serde_json::to_string(&status)?))
        .map_err(|error| invalid(error.to_string()))
}

fn read_state(path: &Path) -> io::Result<Option<Value>> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
        Ok(metadata)
            if metadata.is_file()
                && !metadata.file_type().is_symlink()
                && metadata.len() <= 16 * 1024 =>
        {
            Ok(Some(serde_json::from_slice(&fs::read(path)?)?))
        }
        Ok(_) => Err(invalid("Update state must be a bounded regular file")),
    }
}

// The Updater restores its own services. Other clients must wait until installation ends.
pub(super) fn ensure_start_allowed(data: &Path) -> io::Result<()> {
    let directory = crate::active_update::update_state_directory()?;
    let Some(lock) = read_state(&directory.join("active-update-v1.lock"))? else {
        return Ok(());
    };
    let Some(status_path) = lock["statusPath"].as_str().map(Path::new) else {
        return Ok(());
    };
    let Some(status) = read_state(status_path)? else {
        return Ok(());
    };
    if !matches!(
        status["phase"].as_str(),
        Some("waiting-for-exit" | "installing" | "restarting")
    ) {
        return Ok(());
    }
    let Some(operation) = status_path.parent() else {
        return Ok(());
    };
    let Some(request) = read_state(&operation.join("request-v1.json"))? else {
        return Ok(());
    };
    if let Some(request_data) = request["data_directory"].as_str()
        && Path::new(request_data).canonicalize()? != data.canonicalize()?
    {
        return Ok(());
    }
    let Some(owner) = lock["ownerPid"]
        .as_u64()
        .and_then(|pid| u32::try_from(pid).ok())
    else {
        return Ok(());
    };
    let Ok(owner_process) = codexhost_platform::process_snapshot(owner) else {
        return Ok(());
    };
    let helper = operation.join(format!("codexhost-updater{}", std::env::consts::EXE_SUFFIX));
    if owner_process.executable.canonicalize()? == helper.canonicalize()? {
        let mut current = std::process::id();
        for _ in 0..16 {
            if current == owner {
                return Ok(());
            }
            let Ok(process) = codexhost_platform::process_snapshot(current) else {
                break;
            };
            if process.parent_id <= 1 || process.parent_id == current {
                break;
            }
            current = process.parent_id;
        }
    }
    Err(io::Error::new(
        io::ErrorKind::WouldBlock,
        "An update is installing; wait for it to restore the services",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn service_request_keeps_its_operation_and_uses_the_actual_desktop_state() {
        let data = std::env::temp_dir().canonicalize().unwrap();
        for (running, target) in [(true, "desktop"), (false, "web")] {
            let mut request = json!({"service_managed":true,"data_directory":data,"restart_target":"desktop","status_path":"original-status"});
            bind_request(&mut request, &data, running).unwrap();
            assert_eq!(request["restart_target"], target);
            assert_eq!(request["status_path"], "original-status");
        }
    }

    #[test]
    fn service_request_rejects_a_different_owner_or_data_directory() {
        let data = std::env::temp_dir().canonicalize().unwrap();
        let mut request = json!({"data_directory":data});
        assert!(bind_request(&mut request, &data, false).is_err());
        request["service_managed"] = Value::Bool(true);
        request["data_directory"] = Value::String("relative".into());
        assert!(bind_request(&mut request, &data, false).is_err());
        request["data_directory"] = Value::String(data.to_string_lossy().into_owned());
        assert!(bind_request(&mut request, data.parent().unwrap(), false).is_err());
    }
}
