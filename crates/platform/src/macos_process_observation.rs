//! Narrow full-system identity scans to possible tree members before resolving paths.
//! This is an observation optimization, not an ownership decision: the existing tree
//! algorithm still validates root identity, retires reused PIDs and attributes members.

use std::collections::HashSet;
use std::path::PathBuf;

use libproc::libproc::bsd_info::BSDInfo;
use libproc::libproc::proc_pid::{pidinfo, pidpath};
use libproc::processes::{ProcFilter, pids_by_type};

use super::{PlatformError, ProcessSnapshot};

pub(super) struct ProcessIdentity {
    pub id: u32,
    pub parent_id: u32,
    pub process_group_id: u32,
    pub started_at_micros: u64,
}

pub(super) fn tree_snapshots(
    root_id: u32,
    known: &[ProcessSnapshot],
    process_group: Option<(u32, u64)>,
) -> Result<Vec<ProcessSnapshot>, PlatformError> {
    let identities = pids_by_type(ProcFilter::All)?
        .into_iter()
        .filter_map(|id| {
            let native_id = i32::try_from(id).ok()?;
            let info = pidinfo::<BSDInfo>(native_id, 0).ok()?;
            Some(ProcessIdentity {
                id: info.pbi_pid,
                parent_id: info.pbi_ppid,
                process_group_id: info.pbi_pgid,
                started_at_micros: info
                    .pbi_start_tvsec
                    .saturating_mul(1_000_000)
                    .saturating_add(info.pbi_start_tvusec),
            })
        })
        .collect::<Vec<_>>();
    Ok(resolve_tree_candidates(
        identities,
        root_id,
        known,
        process_group,
        |id| pidpath(i32::try_from(id).ok()?).ok().map(PathBuf::from),
    ))
}

pub(super) fn resolve_tree_candidates(
    identities: Vec<ProcessIdentity>,
    root_id: u32,
    known: &[ProcessSnapshot],
    process_group: Option<(u32, u64)>,
    mut resolve_path: impl FnMut(u32) -> Option<PathBuf>,
) -> Vec<ProcessSnapshot> {
    // Deliberately over-approximate. Include reused known PIDs and the root even
    // when their identity changed, so the original checks still see them. Keeping
    // absent known IDs also preserves discovery after a parent has exited.
    let mut candidates = known
        .iter()
        .map(|process| process.id)
        .collect::<HashSet<_>>();
    candidates.insert(root_id);
    if let Some((group, started_at)) = process_group {
        candidates.extend(
            identities
                .iter()
                .filter(|process| {
                    process.process_group_id == group && process.started_at_micros >= started_at
                })
                .map(|process| process.id),
        );
    }
    loop {
        let mut changed = false;
        for process in &identities {
            if candidates.contains(&process.parent_id) {
                changed |= candidates.insert(process.id);
            }
        }
        if !changed {
            break;
        }
    }
    identities
        .into_iter()
        .filter(|process| candidates.contains(&process.id))
        .filter_map(|process| {
            // Preserve path-read failure filtering for every possible member.
            // In particular, an unreadable parent must not supply a new lineage
            // edge. The original observer receives only complete snapshots.
            let executable = resolve_path(process.id)?;
            Some(ProcessSnapshot {
                id: process.id,
                parent_id: process.parent_id,
                process_group_id: process.process_group_id,
                executable,
                started_at_micros: process.started_at_micros,
            })
        })
        .collect()
}
