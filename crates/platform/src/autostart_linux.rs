use std::fs;
use std::path::PathBuf;
use std::process::Command;

use super::{home, read_file, remove_file, systemd_arguments, systemd_unit, validate_arguments};
use crate::PlatformError;

const UNIT: &str = "codexhost-autostart.service";

fn path() -> Result<PathBuf, PlatformError> {
    let config = match std::env::var_os("XDG_CONFIG_HOME") {
        Some(path) => PathBuf::from(path),
        None => home()?.join(".config"),
    };
    Ok(config.join("systemd/user").join(UNIT))
}

fn systemctl(arguments: &[&str]) -> Result<(), PlatformError> {
    let output = Command::new("systemctl")
        .arg("--user")
        .args(arguments)
        .output()
        .map_err(|error| {
            PlatformError::Invalid(format!("systemd user service unavailable: {error}"))
        })?;
    if !output.status.success() {
        return Err(PlatformError::Invalid(format!(
            "systemd user service unavailable (systemctl {}): {}",
            arguments.join(" "),
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    Ok(())
}

pub(super) fn read() -> Result<Option<String>, PlatformError> {
    read_file(&path()?)
}

pub(super) fn validate(content: &str) -> Result<(), PlatformError> {
    validate_arguments(&systemd_arguments(content)?)
}

pub(super) fn render(arguments: &[String]) -> Result<String, PlatformError> {
    Ok(systemd_unit(arguments))
}

pub(super) fn write(content: &str) -> Result<(), PlatformError> {
    systemctl(&["show-environment"])?;
    let path = path()?;
    fs::create_dir_all(path.parent().expect("systemd user directory"))?;
    fs::write(path, content)?;
    // No --now: enabling login startup must not start or stop current services.
    systemctl(&["enable", UNIT])
}

pub(super) fn remove() -> Result<(), PlatformError> {
    let path = path()?;
    if read_file(&path)?.is_some() {
        systemctl(&["show-environment"])?;
        systemctl(&["disable", UNIT])?;
        remove_file(&path)?;
    }
    Ok(())
}
