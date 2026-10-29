use crate::request::UpdateRequest;
use codexhost_platform::atomic_replace_file;
use serde::{Deserialize, Serialize};
use std::error::Error;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum Outcome {
    Updated,
    Restored,
    RecoveryFailed,
    Unknown,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Restart {
    installation_root: PathBuf,
    launcher_pid: u32,
    launcher_started_at_micros: String,
    version: String,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateStatus {
    schema_version: u8,
    version: String,
    installation: String,
    phase: String,
    updated_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    outcome: Option<Outcome>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    restart: Option<Restart>,
}
pub(crate) fn unix_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn existing(request: &UpdateRequest) -> Option<UpdateStatus> {
    let metadata = fs::symlink_metadata(&request.status_path).ok()?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 64 * 1024 {
        return None;
    }
    let status: UpdateStatus =
        serde_json::from_slice(&fs::read(&request.status_path).ok()?).ok()?;
    (status.schema_version == 1 && status.installation == request.installation.name())
        .then_some(status)
}
fn save(request: &UpdateRequest, status: &UpdateStatus) -> Result<(), Box<dyn Error>> {
    let parent = request
        .status_path
        .parent()
        .ok_or("update status path has no parent directory")?;
    fs::create_dir_all(parent)?;
    let temporary = parent.join(format!(
        ".update-status-{}-{}.tmp",
        std::process::id(),
        unix_seconds()
    ));
    let result = (|| -> Result<(), Box<dyn Error>> {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)?;
        serde_json::to_writer(&mut file, status)?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        atomic_replace_file(&temporary, &request.status_path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}
pub(crate) fn write_status(
    request: &UpdateRequest,
    phase: &str,
    error: Option<&str>,
) -> Result<(), Box<dyn Error>> {
    write(request, phase, error, None)
}
fn write(
    request: &UpdateRequest,
    phase: &str,
    error: Option<&str>,
    outcome: Option<Outcome>,
) -> Result<(), Box<dyn Error>> {
    let old = existing(request);
    let status = UpdateStatus {
        schema_version: 1,
        version: request.version.clone(),
        installation: request.installation.name().into(),
        phase: phase.into(),
        updated_at: unix_seconds(),
        error: error.map(|e| e.chars().take(500).collect()),
        outcome: outcome.or_else(|| old.as_ref().and_then(|s| s.outcome)),
        restart: old.and_then(|s| s.restart),
    };
    save(request, &status)
}
#[cfg(any(target_os = "windows", test))]
pub(crate) fn write_result(
    request: &UpdateRequest,
    phase: &str,
    error: Option<&str>,
    outcome: Outcome,
) -> Result<(), Box<dyn Error>> {
    write(request, phase, error, Some(outcome))
}
#[cfg(any(target_os = "windows", test))]
pub(crate) fn write_failure(request: &UpdateRequest, error: &str) -> Result<(), Box<dyn Error>> {
    let outcome = match existing(request).and_then(|s| s.outcome) {
        Some(Outcome::Restored) => Outcome::Restored,
        Some(Outcome::RecoveryFailed) => Outcome::RecoveryFailed,
        _ => Outcome::Unknown,
    };
    write_result(request, "failed", Some(error), outcome)
}
#[cfg(target_os = "windows")]
pub(crate) fn bind_restart(
    request: &UpdateRequest,
    launcher: &codexhost_platform::ProcessSnapshot,
) -> Result<(), Box<dyn Error>> {
    let root = match &request.installation {
        crate::request::Installation::Npm(npm) => {
            npm.prefix.as_ref().ok_or("missing original npm prefix")?
        }
        crate::request::Installation::WindowsInstaller(w) => &w.install_root,
        _ => return Err("restart result binding requires a Windows installation".into()),
    };
    let mut status = existing(request).ok_or("missing operation status for restart binding")?;
    status.restart = Some(Restart {
        installation_root: root.canonicalize()?,
        launcher_pid: launcher.id,
        launcher_started_at_micros: launcher.started_at_micros.to_string(),
        version: request.version.clone(),
    });
    save(request, &status)
}
