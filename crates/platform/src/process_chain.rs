use std::collections::HashSet;
use std::path::{Path, PathBuf};

use crate::process::same_process_instance;
use crate::{PlatformError, ProcessSnapshot};

/// Observation of a Desktop root's process subtree during Host chain startup.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostChainObservation {
    pub root_alive: bool,
    pub tree_size: usize,
    pub pair_exists: bool,
    pub shim_running: bool,
    pub node_running: bool,
    /// True when the official CLI is running under the Desktop tree without the
    /// expected Shim as its parent (strong signal that managed env was dropped).
    pub direct_stock_cli_without_shim: bool,
}

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

/// Inspect the Desktop root's subtree once for Host chain readiness, root
/// survival, and missing-environment diagnostics.
pub fn observe_host_chain(
    root: &ProcessSnapshot,
    shim_executable: &Path,
    node_executables: &[PathBuf],
    stock_cli_executable: Option<&Path>,
) -> Result<HostChainObservation, PlatformError> {
    let snapshots = snapshots_under(root.id)?;
    Ok(observe_tree(
        root,
        shim_executable,
        node_executables,
        stock_cli_executable,
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

fn observe_tree(
    root: &ProcessSnapshot,
    shim_executable: &Path,
    node_executables: &[PathBuf],
    stock_cli_executable: Option<&Path>,
    snapshots: &[ProcessSnapshot],
) -> HostChainObservation {
    let Some(current_root) = snapshots.iter().find(|candidate| {
        same_process_instance(root, candidate)
            && same_executable(&root.executable, &candidate.executable)
    }) else {
        return HostChainObservation {
            root_alive: false,
            tree_size: 0,
            pair_exists: false,
            shim_running: false,
            node_running: false,
            direct_stock_cli_without_shim: false,
        };
    };
    let mut pending = vec![current_root];
    let mut visited = HashSet::from([root.id]);
    let mut tree_size = 1_usize;
    let mut pair_exists = false;
    let mut shim_running = false;
    let mut node_running = false;
    let mut direct_stock_cli = false;

    while let Some(parent) = pending.pop() {
        let parent_is_shim =
            parent.id != root.id && same_executable(&parent.executable, shim_executable);
        for child in snapshots.iter().filter(|child| {
            child.parent_id == parent.id && child.started_at_micros >= parent.started_at_micros
        }) {
            if !visited.insert(child.id) {
                continue;
            }
            tree_size += 1;
            let child_is_shim = same_executable(&child.executable, shim_executable);
            let child_is_node = node_executables
                .iter()
                .any(|node| same_executable(&child.executable, node));
            if child_is_shim {
                shim_running = true;
            }
            if child_is_node {
                node_running = true;
            }
            if parent_is_shim && child_is_node {
                pair_exists = true;
            }
            if !parent_is_shim
                && stock_cli_executable
                    .is_some_and(|stock| same_executable(&child.executable, stock))
            {
                direct_stock_cli = true;
            }
            pending.push(child);
        }
    }

    HostChainObservation {
        root_alive: true,
        tree_size,
        pair_exists,
        shim_running,
        node_running,
        direct_stock_cli_without_shim: direct_stock_cli && !shim_running,
    }
}

fn matches_pair(
    root: &ProcessSnapshot,
    parent_executable: &Path,
    child_executable: &Path,
    snapshots: &[ProcessSnapshot],
) -> bool {
    observe_tree(
        root,
        parent_executable,
        &[child_executable.to_path_buf()],
        None,
        snapshots,
    )
    .pair_exists
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

    #[test]
    fn observes_root_exit_and_direct_stock_cli_without_shim() {
        let root = process(1, 0, "/desktop");
        let shim = Path::new("/shim");
        let nodes = [PathBuf::from("/node")];
        let stock = Path::new("/codex");

        let exited = observe_tree(&root, shim, &nodes, Some(stock), &[]);
        assert!(!exited.root_alive);
        assert!(!exited.pair_exists);

        // Desktop directly spawned stock codex without shim -> missing managed env.
        let unshimmed = observe_tree(
            &root,
            shim,
            &nodes,
            Some(stock),
            &[root.clone(), process(2, 1, "/codex")],
        );
        assert!(unshimmed.root_alive);
        assert!(!unshimmed.shim_running);
        assert!(unshimmed.direct_stock_cli_without_shim);

        // Shim spawning stock codex is normal official-traffic proxying, not missing env.
        let via_shim = observe_tree(
            &root,
            shim,
            &nodes,
            Some(stock),
            &[
                root.clone(),
                process(2, 1, "/shim"),
                process(3, 2, "/codex"),
            ],
        );
        assert!(via_shim.root_alive);
        assert!(via_shim.shim_running);
        assert!(!via_shim.direct_stock_cli_without_shim);
    }
}
