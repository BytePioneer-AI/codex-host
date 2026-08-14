//! Linux process inspection backed by the `/proc` filesystem.
//!
//! These functions mirror the macOS `libproc` snapshots in [`super::process`]:
//! a snapshot carries the identity needed to prove that a PID still refers to
//! the same process instance before a signal is delivered.

use std::fs;
use std::io;

use super::PlatformError;
use super::process::ProcessSnapshot;

/// Clock ticks per second for `/proc/<pid>/stat` field 22 (`starttime`).
///
/// Linux reports `_SC_CLK_TCK` to user space as a stable ABI value of 100,
/// decoupled from the kernel's internal `CONFIG_HZ`. Start times are therefore
/// accurate to 10ms, which the PID reuse checks combine with the parent,
/// process group, and executable path rather than relying on alone.
const CLOCK_TICKS_PER_SECOND: u64 = 100;
const MICROS_PER_SECOND: u64 = 1_000_000;

fn unreadable(process_id: u32, entry: &str, error: &io::Error) -> PlatformError {
    PlatformError::NotFound(format!("cannot read /proc/{process_id}/{entry}: {error}"))
}

/// Split the `/proc/<pid>/stat` fields that follow `comm`.
///
/// `comm` is wrapped in parentheses and may itself contain spaces and
/// parentheses, so the remaining fields are split after the final `)`. The
/// returned slice starts at field 3 (`state`), so `/proc` field *N* lives at
/// index *N* - 3.
fn stat_fields(stat: &str) -> Option<Vec<&str>> {
    let comm_end = stat.rfind(')')?;
    Some(stat[comm_end + 1..].split_whitespace().collect())
}

fn stat_field(fields: &[&str], field: usize, process_id: u32) -> Result<u64, PlatformError> {
    fields
        .get(field - 3)
        .and_then(|value| value.parse::<u64>().ok())
        .ok_or_else(|| {
            PlatformError::Invalid(format!(
                "/proc/{process_id}/stat has no numeric field {field}"
            ))
        })
}

fn stat_identifier(fields: &[&str], field: usize, process_id: u32) -> Result<u32, PlatformError> {
    let value = stat_field(fields, field, process_id)?;
    u32::try_from(value).map_err(|_| {
        PlatformError::Invalid(format!(
            "/proc/{process_id}/stat field {field} exceeds u32::MAX"
        ))
    })
}

pub(crate) fn linux_process_snapshot(process_id: u32) -> Result<ProcessSnapshot, PlatformError> {
    let stat = fs::read_to_string(format!("/proc/{process_id}/stat"))
        .map_err(|error| unreadable(process_id, "stat", &error))?;
    let fields = stat_fields(&stat).ok_or_else(|| {
        PlatformError::Invalid(format!("/proc/{process_id}/stat has no comm field"))
    })?;
    // A kernel thread has no `exe` link, and a process owned by another user
    // rejects the read. Both surface as NotFound so full-system scans skip them.
    let executable = fs::read_link(format!("/proc/{process_id}/exe"))
        .map_err(|error| unreadable(process_id, "exe", &error))?;
    Ok(ProcessSnapshot {
        id: process_id,
        parent_id: stat_identifier(&fields, 4, process_id)?,
        process_group_id: stat_identifier(&fields, 5, process_id)?,
        executable,
        started_at_micros: stat_field(&fields, 22, process_id)?.saturating_mul(MICROS_PER_SECOND)
            / CLOCK_TICKS_PER_SECOND,
    })
}

pub(crate) fn linux_process_snapshots() -> Result<Vec<ProcessSnapshot>, PlatformError> {
    let mut snapshots = Vec::new();
    for entry in fs::read_dir("/proc")? {
        let Ok(process_id) = entry?.file_name().to_string_lossy().parse::<u32>() else {
            continue;
        };
        if let Ok(snapshot) = linux_process_snapshot(process_id) {
            snapshots.push(snapshot);
        }
    }
    Ok(snapshots)
}

pub(crate) fn linux_process_exists(process_id: u32) -> bool {
    fs::metadata(format!("/proc/{process_id}")).is_ok_and(|metadata| metadata.is_dir())
}

#[cfg(test)]
mod tests {
    use super::{linux_process_exists, linux_process_snapshot, stat_fields};

    #[test]
    fn snapshots_the_current_linux_process_from_proc() {
        let snapshot =
            linux_process_snapshot(std::process::id()).expect("current process snapshot");
        assert_eq!(snapshot.id, std::process::id());
        assert!(snapshot.parent_id > 0);
        assert!(snapshot.process_group_id > 0);
        assert!(snapshot.executable.is_absolute());
        assert!(snapshot.started_at_micros > 0);
    }

    #[test]
    fn splits_stat_fields_after_a_comm_containing_spaces_and_parentheses() {
        // Field 3 is `state`, so field 4 (ppid) is index 1 and field 5 (pgrp)
        // is index 2 even though `comm` itself contains `)` and a space.
        let stat = "42 (od d) na:me) S 7 9 9 0 -1 4194304";
        let fields = stat_fields(stat).expect("fields after comm");
        assert_eq!(fields[0], "S");
        assert_eq!(fields[1], "7");
        assert_eq!(fields[2], "9");
    }

    #[test]
    fn reports_liveness_for_the_current_process_and_not_for_an_unused_pid() {
        assert!(linux_process_exists(std::process::id()));
        assert!(!linux_process_exists(u32::MAX));
    }
}
