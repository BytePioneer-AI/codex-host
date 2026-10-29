//! Windows handoff owns the existing operation lock before acknowledging exit.

use std::error::Error;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;

use codexhost_platform::{atomic_replace_file, process_snapshot};
use serde::{Deserialize, Serialize};

use crate::operation_guard::OperationGuard;
use crate::request::UpdateRequest;
use crate::windows_installation::same_path;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Record {
    owner_pid: u32,
    status_path: PathBuf,
    operation_id: String,
    owner_started_at_micros: String,
    installation_started: bool,
}

#[derive(Debug)]
pub(crate) struct OperationLock {
    path: PathBuf,
    record: Record,
    finished: bool,
}

fn read(path: &std::path::Path) -> Result<Record, Box<dyn Error>> {
    let info = fs::symlink_metadata(path)?;
    if !info.is_file() || info.file_type().is_symlink() || info.len() > 4096 {
        return Err("update operation lock is not a bounded regular file".into());
    }
    Ok(serde_json::from_slice(&fs::read(path)?)?)
}

impl OperationLock {
    pub(crate) fn take(request: &UpdateRequest) -> Result<Self, Box<dyn Error>> {
        let operation = request
            .status_path
            .parent()
            .ok_or("missing operation directory")?;
        if request.status_path.file_name().and_then(|x| x.to_str()) != Some("status-v1.json")
            || !operation
                .file_name()
                .and_then(|x| x.to_str())
                .is_some_and(|x| x.starts_with("update-"))
        {
            return Err("invalid update operation path".into());
        }
        let path = operation
            .parent()
            .ok_or("missing update state directory")?
            .join("active-update-v1.lock");
        let _guard = OperationGuard::acquire(path.parent().ok_or("missing lock directory")?)?;
        let mut record = read(&path)?;
        if !same_path(
            &record.status_path.canonicalize()?,
            &request.status_path.canonicalize()?,
        ) || record.operation_id.is_empty()
            || record.installation_started
        {
            return Err("update operation lock does not match this unwritten request".into());
        }
        let owner = process_snapshot(record.owner_pid)?;
        if owner.started_at_micros.to_string() != record.owner_started_at_micros {
            return Err("update lock owner PID was reused".into());
        }
        let updater = process_snapshot(std::process::id())?;
        record.owner_pid = updater.id;
        record.owner_started_at_micros = updater.started_at_micros.to_string();
        let mut lock = Self {
            path,
            record,
            finished: true,
        };
        lock.write()?;
        lock.finished = false;
        Ok(lock)
    }

    fn write(&self) -> Result<(), Box<dyn Error>> {
        let temporary = self
            .path
            .with_file_name(format!(".active-update-{}.tmp", std::process::id()));
        let result = (|| -> Result<(), Box<dyn Error>> {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)?;
            serde_json::to_writer(&mut file, &self.record)?;
            file.write_all(b"\n")?;
            file.sync_all()?;
            atomic_replace_file(&temporary, &self.path)?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(temporary);
        }
        result
    }

    fn still_owned(&self) -> Result<bool, Box<dyn Error>> {
        let current = read(&self.path)?;
        Ok(current.owner_pid == self.record.owner_pid
            && current.owner_started_at_micros == self.record.owner_started_at_micros
            && current.operation_id == self.record.operation_id
            && same_path(&current.status_path, &self.record.status_path))
    }

    pub(crate) fn mark_installing(&mut self) -> Result<(), Box<dyn Error>> {
        let _guard = OperationGuard::acquire(self.path.parent().ok_or("missing lock directory")?)?;
        if !self.still_owned()? {
            return Err("update operation ownership changed before install".into());
        }
        self.record.installation_started = true;
        self.write()
    }

    pub(crate) fn finish(&mut self) -> Result<(), Box<dyn Error>> {
        let _guard = OperationGuard::acquire(self.path.parent().ok_or("missing lock directory")?)?;
        if !self.still_owned()? {
            return Err("update operation ownership changed before release".into());
        }
        fs::remove_file(&self.path)?;
        self.finished = true;
        Ok(())
    }
}

impl Drop for OperationLock {
    fn drop(&mut self) {
        // An interrupted/failed replacement must keep its materials and exclusion.
        if self.finished || self.record.installation_started {
            return;
        }
        let Some(parent) = self.path.parent() else {
            return;
        };
        let Ok(_guard) = OperationGuard::acquire(parent) else {
            return;
        };
        if self.still_owned().unwrap_or(false) {
            let _ = fs::remove_file(&self.path);
        }
    }
}

#[cfg(test)]
#[path = "operation_lock_tests.rs"]
mod tests;
