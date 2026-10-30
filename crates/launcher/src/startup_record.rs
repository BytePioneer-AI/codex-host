//! Structured record of recent Launcher startups.
//!
//! The Launcher's stderr is lost once it detaches (and was never visible for
//! Finder / Start Menu launches). Each launch therefore keeps its stage
//! timeline, the discovered Codex Desktop identity, and its outcome in a small
//! bounded file that the codexhost console reads. Recording is best effort:
//! failing to write never changes launch behavior.

use std::env;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

const DATA_DIRECTORY_ENV: &str = "CODEXHOST_DATA_DIR";
const RECORD_FILE: &str = "launcher-startup-v1.json";
const RECORD_SCHEMA_VERSION: u8 = 1;
const MAX_RECORDS: usize = 10;
const MAX_STAGES: usize = 64;
const MAX_ERROR_CHARS: usize = 2_000;
const MAX_FILE_BYTES: u64 = 256 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum StartupOutcome {
    Starting,
    Ready,
    Attached,
    Failed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupStage {
    pub name: String,
    pub elapsed_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupDesktop {
    pub version: String,
    pub build: String,
    pub install_root: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupRecord {
    pub id: String,
    pub pid: u32,
    pub launcher_version: String,
    pub started_at_ms: u64,
    pub finished_at_ms: Option<u64>,
    pub outcome: StartupOutcome,
    pub error: Option<String>,
    pub stages: Vec<StartupStage>,
    pub desktop: Option<StartupDesktop>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartupRecordFile {
    schema_version: u8,
    records: Vec<StartupRecord>,
}

struct ActiveStartup {
    id: String,
    started: Instant,
    started_at_ms: u64,
    stages: Vec<StartupStage>,
    desktop: Option<StartupDesktop>,
}

static ACTIVE: Mutex<Option<ActiveStartup>> = Mutex::new(None);

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

/// Begins recording this process's startup. Later calls are ignored.
pub fn begin() {
    let Ok(mut active) = ACTIVE.lock() else {
        return;
    };
    if active.is_some() {
        return;
    }
    let started_at_ms = now_ms();
    *active = Some(ActiveStartup {
        id: format!("{started_at_ms}-{}", std::process::id()),
        started: Instant::now(),
        started_at_ms,
        stages: Vec::new(),
        desktop: None,
    });
    drop(active);
    // Publish before the console opens; a missing runtime endpoint is expected
    // while this Launcher is still starting Desktop.
    finish(StartupOutcome::Starting, None);
}

/// When this process began recording its launch.
pub fn started_at_ms() -> Option<u64> {
    ACTIVE
        .lock()
        .ok()
        .and_then(|active| active.as_ref().map(|active| active.started_at_ms))
}

pub fn stage(name: &str) {
    let Ok(mut active) = ACTIVE.lock() else {
        return;
    };
    let Some(active) = active.as_mut() else {
        return;
    };
    if active.stages.len() >= MAX_STAGES {
        return;
    }
    active.stages.push(StartupStage {
        name: name.to_owned(),
        elapsed_ms: active.started.elapsed().as_millis() as u64,
    });
}

pub fn desktop(version: &str, build: &str, install_root: &Path) {
    let Ok(mut active) = ACTIVE.lock() else {
        return;
    };
    if let Some(active) = active.as_mut() {
        active.desktop = Some(StartupDesktop {
            version: version.to_owned(),
            build: build.to_owned(),
            install_root: install_root.display().to_string(),
        });
    }
}

/// Persists the current startup with its outcome. A later call for the same
/// startup (for example a failure after the Desktop was ready) replaces it.
pub fn finish(outcome: StartupOutcome, error: Option<&str>) {
    let record = {
        let Ok(active) = ACTIVE.lock() else {
            return;
        };
        let Some(active) = active.as_ref() else {
            return;
        };
        StartupRecord {
            id: active.id.clone(),
            pid: std::process::id(),
            launcher_version: env!("CARGO_PKG_VERSION").to_owned(),
            started_at_ms: active.started_at_ms,
            finished_at_ms: (outcome != StartupOutcome::Starting).then(now_ms),
            outcome,
            error: error.map(bounded_error),
            stages: active.stages.clone(),
            desktop: active.desktop.clone(),
        }
    };
    if let Some(path) = default_record_path() {
        let _ = persist(&path, record);
    }
}

fn bounded_error(message: &str) -> String {
    message.chars().take(MAX_ERROR_CHARS).collect()
}

fn home_directory() -> Option<PathBuf> {
    let name = if cfg!(target_os = "windows") {
        "USERPROFILE"
    } else {
        "HOME"
    };
    env::var_os(name)
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
}

/// `<data directory>/diagnostics`, matching the Host Runtime's data directory
/// rule: `CODEXHOST_DATA_DIR` when set, otherwise `~/.codexhost`.
pub fn diagnostics_directory() -> Option<PathBuf> {
    let data_directory = env::var_os(DATA_DIRECTORY_ENV)
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .or_else(|| home_directory().map(|home| home.join(".codexhost")))?;
    Some(data_directory.join("diagnostics"))
}

pub fn default_record_path() -> Option<PathBuf> {
    diagnostics_directory().map(|directory| directory.join(RECORD_FILE))
}

fn read_existing(path: &Path) -> StartupRecordFile {
    let read = || -> Option<StartupRecordFile> {
        let metadata = fs::symlink_metadata(path).ok()?;
        if !metadata.is_file() || metadata.len() > MAX_FILE_BYTES {
            return None;
        }
        let mut bytes = Vec::new();
        fs::File::open(path)
            .ok()?
            .take(MAX_FILE_BYTES)
            .read_to_end(&mut bytes)
            .ok()?;
        let file = serde_json::from_slice::<StartupRecordFile>(&bytes).ok()?;
        (file.schema_version == RECORD_SCHEMA_VERSION).then_some(file)
    };
    read().unwrap_or_default()
}

fn merge(mut records: Vec<StartupRecord>, record: StartupRecord) -> Vec<StartupRecord> {
    records.retain(|existing| existing.id != record.id);
    records.insert(0, record);
    records.truncate(MAX_RECORDS);
    records
}

fn create_private_directory(directory: &Path) -> std::io::Result<()> {
    fs::create_dir_all(directory)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(directory, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn persist(path: &Path, record: StartupRecord) -> std::io::Result<()> {
    let directory = path
        .parent()
        .ok_or_else(|| std::io::Error::other("startup record has no parent directory"))?;
    create_private_directory(directory)?;
    let existing = read_existing(path);
    let file = StartupRecordFile {
        schema_version: RECORD_SCHEMA_VERSION,
        records: merge(existing.records, record),
    };
    let bytes = serde_json::to_vec_pretty(&file).map_err(std::io::Error::other)?;
    let temporary = directory.join(format!(
        ".{RECORD_FILE}.{}.{}.tmp",
        std::process::id(),
        now_ms()
    ));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = (|| {
        let mut output = options.open(&temporary)?;
        output.write_all(&bytes)?;
        output.write_all(b"\n")?;
        output.sync_all()?;
        drop(output);
        fs::rename(&temporary, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn starting_record_has_no_finish_time_and_is_replaced_by_its_outcome() {
        let starting = record("start", StartupOutcome::Starting);
        let json = serde_json::to_value(&starting).expect("serialize starting");
        assert_eq!(json["outcome"], "starting");
        assert!(json["finishedAtMs"].is_null());
        let restored: StartupRecord = serde_json::from_value(json).expect("read starting");
        assert_eq!(restored, starting);
        for outcome in [StartupOutcome::Ready, StartupOutcome::Failed] {
            let completed = record("start", outcome);
            assert_eq!(
                merge(vec![starting.clone()], completed.clone()),
                vec![completed]
            );
        }
    }

    fn record(id: &str, outcome: StartupOutcome) -> StartupRecord {
        StartupRecord {
            id: id.to_owned(),
            pid: 1,
            launcher_version: "1.2.3".into(),
            started_at_ms: 1,
            finished_at_ms: (outcome != StartupOutcome::Starting).then_some(2),
            outcome,
            error: None,
            stages: vec![StartupStage {
                name: "launch requested".into(),
                elapsed_ms: 0,
            }],
            desktop: None,
        }
    }

    #[test]
    fn merge_replaces_the_same_startup_and_keeps_newest_first() {
        let merged = merge(
            vec![
                record("b", StartupOutcome::Ready),
                record("a", StartupOutcome::Ready),
            ],
            record("b", StartupOutcome::Failed),
        );
        assert_eq!(
            merged.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
            ["b", "a"]
        );
        assert_eq!(merged[0].outcome, StartupOutcome::Failed);
    }

    #[test]
    fn merge_bounds_history() {
        let existing = (0..MAX_RECORDS + 3)
            .map(|index| record(&index.to_string(), StartupOutcome::Ready))
            .collect();
        let merged = merge(existing, record("new", StartupOutcome::Failed));
        assert_eq!(merged.len(), MAX_RECORDS);
        assert_eq!(merged[0].id, "new");
    }

    #[test]
    fn persist_writes_a_readable_bounded_file() {
        let directory = env::temp_dir().join(format!(
            "codexhost-startup-record-{}-{}",
            std::process::id(),
            now_ms()
        ));
        let path = directory.join(RECORD_FILE);
        persist(&path, record("first", StartupOutcome::Ready)).expect("persist first");
        persist(&path, record("second", StartupOutcome::Failed)).expect("persist second");
        let file = read_existing(&path);
        fs::remove_dir_all(&directory).expect("remove record directory");
        assert_eq!(file.schema_version, RECORD_SCHEMA_VERSION);
        assert_eq!(
            file.records
                .iter()
                .map(|r| r.id.as_str())
                .collect::<Vec<_>>(),
            ["second", "first"]
        );
    }

    #[test]
    fn errors_are_bounded() {
        assert_eq!(
            bounded_error(&"x".repeat(MAX_ERROR_CHARS + 10)).len(),
            MAX_ERROR_CHARS
        );
    }
}
