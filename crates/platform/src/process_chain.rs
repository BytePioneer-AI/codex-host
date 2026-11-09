use std::collections::HashSet;
use std::path::Path;

use crate::process::same_process_instance;
use crate::{PlatformError, ProcessSnapshot};

/// Find a matching parent and its direct child below this exact root instance.
/// The root itself cannot stand in for the requested parent executable.
pub fn descendant_executable_pair_exists(
    root: &ProcessSnapshot,
    parent_executable: &Path,
    child_executable: &Path,
) -> Result<bool, PlatformError> {
    let snapshots = snapshots_under(root.id)?;
    Ok(matches_pair(
        root,
        parent_executable,
        child_executable,
        &snapshots,
    ))
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn snapshots_under(_root_id: u32) -> Result<Vec<ProcessSnapshot>, PlatformError> {
    crate::process::process_snapshots()
}

#[cfg(target_os = "windows")]
fn snapshots_under(root_id: u32) -> Result<Vec<ProcessSnapshot>, PlatformError> {
    use crate::windows_process;

    let entries = windows_process::process_entries()?;
    let mut owned = HashSet::from([root_id]);
    loop {
        let previous = owned.len();
        for entry in &entries {
            if owned.contains(&entry.parent_id) {
                owned.insert(entry.id);
            }
        }
        if owned.len() == previous {
            break;
        }
    }
    // Inspect only this subtree; inaccessible unrelated system processes are not
    // startup failures. Missing members cannot contribute evidence of a chain.
    Ok(entries
        .iter()
        .filter(|entry| owned.contains(&entry.id))
        .filter_map(|entry| {
            Some(ProcessSnapshot {
                id: entry.id,
                parent_id: entry.parent_id,
                process_group_id: entry.id,
                executable: windows_process::process_image_path(entry.id).ok()?,
                started_at_micros: windows_process::process_started_at_micros(entry.id).ok()?,
            })
        })
        .collect())
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
fn snapshots_under(_root_id: u32) -> Result<Vec<ProcessSnapshot>, PlatformError> {
    Err(PlatformError::Unsupported(
        "process chain inspection requires Windows, macOS, or Linux",
    ))
}

fn same_executable(left: &Path, right: &Path) -> bool {
    #[cfg(target_os = "windows")]
    {
        crate::process::windows_executable_key(left)
            == crate::process::windows_executable_key(right)
    }
    #[cfg(not(target_os = "windows"))]
    {
        left == right
    }
}

fn matches_pair(
    root: &ProcessSnapshot,
    parent_executable: &Path,
    child_executable: &Path,
    snapshots: &[ProcessSnapshot],
) -> bool {
    let Some(current_root) = snapshots.iter().find(|candidate| {
        same_process_instance(root, candidate)
            && same_executable(&root.executable, &candidate.executable)
    }) else {
        return false;
    };
    let mut pending = vec![current_root];
    let mut visited = HashSet::from([root.id]);
    while let Some(parent) = pending.pop() {
        for child in snapshots.iter().filter(|child| {
            child.parent_id == parent.id && child.started_at_micros >= parent.started_at_micros
        }) {
            if !visited.insert(child.id) {
                continue;
            }
            if parent.id != root.id
                && same_executable(&parent.executable, parent_executable)
                && same_executable(&child.executable, child_executable)
            {
                return true;
            }
            pending.push(child);
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn process(id: u32, parent_id: u32, executable: &str) -> ProcessSnapshot {
        ProcessSnapshot {
            id,
            parent_id,
            process_group_id: id,
            executable: executable.into(),
            started_at_micros: u64::from(id) * 100,
        }
    }

    fn matches(root: &ProcessSnapshot, snapshots: &[ProcessSnapshot]) -> bool {
        matches_pair(root, Path::new("/shim"), Path::new("/node"), snapshots)
    }

    #[test]
    fn requires_a_direct_parent_child_pair_in_the_same_subtree() {
        let root = process(1, 0, "/desktop");
        let parent = process(2, 1, "/shim");
        let child = process(3, 2, "/node");
        assert!(matches(
            &root,
            &[root.clone(), parent.clone(), child.clone()]
        ));
        let sibling = process(3, 1, "/node");
        assert!(!matches(&root, &[root.clone(), parent.clone(), sibling]));
        let wrong_node = process(3, 2, "/other-node");
        assert!(!matches(&root, &[root.clone(), parent.clone(), wrong_node]));
        let mut grandchild = child.clone();
        grandchild.parent_id = 4;
        let mut intermediary = process(4, 2, "/helper");
        intermediary.started_at_micros = 250;
        assert!(!matches(
            &root,
            &[root.clone(), parent.clone(), intermediary, grandchild]
        ));
        let mut foreign_parent = parent;
        foreign_parent.parent_id = 99;
        assert!(!matches(&root, &[root.clone(), foreign_parent, child]));
    }

    #[test]
    fn accepts_a_pair_below_an_intermediate_desktop_process() {
        let root = process(1, 0, "/desktop");
        assert!(matches(
            &root,
            &[
                root.clone(),
                process(2, 1, "/helper"),
                process(3, 2, "/shim"),
                process(4, 3, "/node"),
            ]
        ));
    }

    #[test]
    fn rejects_missing_or_reused_root_and_reused_parent() {
        let root = process(1, 0, "/desktop");
        let parent = process(2, 1, "/shim");
        let child = process(3, 2, "/node");
        assert!(!matches(&root, &[parent.clone(), child.clone()]));
        let mut reused_root = root.clone();
        reused_root.started_at_micros += 1;
        assert!(!matches(
            &root,
            &[reused_root, parent.clone(), child.clone()]
        ));
        let mut reused_parent = parent;
        reused_parent.started_at_micros = child.started_at_micros + 1;
        assert!(!matches(&root, &[root.clone(), reused_parent, child]));
    }

    #[test]
    fn does_not_count_the_root_as_the_parent_or_follow_disconnected_cycles() {
        let root = process(1, 0, "/shim");
        assert!(!matches(&root, &[root.clone(), process(2, 1, "/node")]));
        assert!(!matches(
            &root,
            &[root.clone(), process(2, 3, "/shim"), process(3, 2, "/node")]
        ));
    }
}
