use std::error::Error;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::time::{SystemTime, UNIX_EPOCH};

use codexhost_platform::atomic_replace_file;
use serde::Serialize;

use crate::request::UpdateRequest;

const STATUS_SCHEMA_VERSION: u8 = 1;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateStatus<'a> {
    schema_version: u8,
    version: &'a str,
    installation: &'a str,
    phase: &'a str,
    updated_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<&'a str>,
}

pub(crate) fn unix_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

pub(crate) fn write_status(
    request: &UpdateRequest,
    phase: &str,
    error: Option<&str>,
) -> Result<(), Box<dyn Error>> {
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
    let status = UpdateStatus {
        schema_version: STATUS_SCHEMA_VERSION,
        version: &request.version,
        installation: request.installation.name(),
        phase,
        updated_at: unix_seconds(),
        error,
    };
    let result = (|| -> Result<(), Box<dyn Error>> {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)?;
        serde_json::to_writer(&mut file, &status)?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        atomic_replace_file(&temporary, &request.status_path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}
