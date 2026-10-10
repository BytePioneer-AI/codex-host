//! Explicit ownership transfer for native services launched from a supervised Desktop tree.
//! Records describe process instances, never sessions, credentials or Harness state.
use crate::{PlatformError, ProcessSnapshot, process_snapshot};
use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;

#[derive(Deserialize, Serialize)]
struct Record {
    pid: u32,
    started_at_micros: u64,
    executable: PathBuf,
}

fn directory() -> Option<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(|home| PathBuf::from(home).join(".codexhost/independent-processes"))
}

pub struct IndependentServiceRegistration {
    file: PathBuf,
}
impl Drop for IndependentServiceRegistration {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.file);
    }
}

/// Must be called by the detached native supervisor before it spawns any managed children.
pub fn register_independent_service() -> Result<IndependentServiceRegistration, PlatformError> {
    let root = process_snapshot(std::process::id())?;
    let directory =
        directory().ok_or_else(|| PlatformError::Invalid("User home is unavailable".into()))?;
    fs::create_dir_all(&directory)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))?;
    }
    let file = directory.join(format!("{}-{}.json", root.id, root.started_at_micros));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut handle = options.open(&file)?;
    let record = Record {
        pid: root.id,
        started_at_micros: root.started_at_micros,
        executable: root.executable,
    };
    handle.write_all(
        &serde_json::to_vec(&record).map_err(|e| PlatformError::Invalid(e.to_string()))?,
    )?;
    handle.sync_all()?;
    Ok(IndependentServiceRegistration { file })
}

#[cfg(test)]
#[path = "independent_service_tests.rs"]
mod tests;

#[cfg(any(target_os = "macos", target_os = "linux"))]
pub(crate) fn transferred_processes(root: &ProcessSnapshot, owned: &[ProcessSnapshot]) -> Vec<u32> {
    use std::os::unix::fs::MetadataExt;
    let Some(directory) = directory() else {
        return Vec::new();
    };
    let Ok(files) = fs::read_dir(directory) else {
        return Vec::new();
    };
    let mut excluded = Vec::new();
    for file in files.flatten().take(256) {
        let Ok(metadata) = fs::symlink_metadata(file.path()) else {
            continue;
        };
        if !metadata.is_file()
            || metadata.len() > 4096
            || metadata.mode() & 0o077 != 0
            || metadata.uid() != nix::unistd::getuid().as_raw()
        {
            continue;
        }
        let Some(record) = fs::read(file.path())
            .ok()
            .and_then(|data| serde_json::from_slice::<Record>(&data).ok())
        else {
            continue;
        };
        // This is a same-user ownership declaration, not an execution sandbox.
        // Web and Desktop may ship identical Launchers at different paths.
        if record.pid == root.id {
            continue;
        }
        if owned.iter().any(|live| {
            live.id == record.pid
                && live.started_at_micros == record.started_at_micros
                && live.executable == record.executable
                && live.process_group_id == live.id
        }) {
            excluded.push(record.pid);
        }
    }
    loop {
        let previous = excluded.len();
        for process in owned {
            if !excluded.contains(&process.id) && excluded.contains(&process.parent_id) {
                excluded.push(process.id);
            }
        }
        if previous == excluded.len() {
            return excluded;
        }
    }
}
