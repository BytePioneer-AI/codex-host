use super::{ObservedProcessTree, ProcessSnapshot};
use crate::macos_process_observation::{ProcessIdentity, resolve_tree_candidates};

fn snapshot(id: u32, parent_id: u32, group: u32, start: u64) -> ProcessSnapshot {
    ProcessSnapshot {
        id,
        parent_id,
        process_group_id: group,
        executable: format!("/fixture/{id}").into(),
        started_at_micros: start,
    }
}

fn filtered(
    tree: &ObservedProcessTree,
    processes: &[ProcessSnapshot],
    unreadable: &[u32],
) -> (Vec<ProcessSnapshot>, Vec<u32>) {
    let mut reads = Vec::new();
    let identities = processes
        .iter()
        .map(|process| ProcessIdentity {
            id: process.id,
            parent_id: process.parent_id,
            process_group_id: process.process_group_id,
            started_at_micros: process.started_at_micros,
        })
        .collect();
    let selected = resolve_tree_candidates(
        identities,
        tree.root.id,
        &tree.known,
        tree.process_group_id
            .map(|group| (group, tree.process_group_started_at_micros)),
        |id| {
            reads.push(id);
            if unreadable.contains(&id) {
                None
            } else {
                Some(
                    processes
                        .iter()
                        .find(|process| process.id == id)
                        .unwrap()
                        .executable
                        .clone(),
                )
            }
        },
    );
    (selected, reads)
}

fn compare_frame(
    original: &mut ObservedProcessTree,
    optimized: &mut ObservedProcessTree,
    processes: &[ProcessSnapshot],
    unreadable: &[u32],
) -> Vec<u32> {
    let (selected, reads) = filtered(optimized, processes, unreadable);
    let full = processes
        .iter()
        .filter(|process| !unreadable.contains(&process.id))
        .cloned()
        .collect::<Vec<_>>();
    let expected = original
        .observe_snapshots(&full)
        .map_err(|error| error.to_string());
    let actual = optimized
        .observe_snapshots(&selected)
        .map_err(|error| error.to_string());
    assert_eq!(
        actual, expected,
        "full returned snapshots and errors must match"
    );
    assert_eq!(optimized.known, original.known);
    assert_eq!(optimized.root, original.root);
    reads
}

#[test]
fn skips_unrelated_paths_but_returns_complete_owned_snapshots() {
    let root = snapshot(10, 1, 10, 100);
    let processes = vec![
        root.clone(),
        snapshot(11, 10, 11, 101),
        snapshot(12, 11, 12, 102),
        snapshot(90, 1, 90, 90),
        snapshot(91, 90, 90, 91),
    ];
    let mut original = ObservedProcessTree::new(root.clone());
    let mut optimized = ObservedProcessTree::new(root);
    assert_eq!(
        compare_frame(&mut original, &mut optimized, &processes, &[]),
        [10, 11, 12]
    );
}

#[test]
fn path_failures_preserve_lineage_filtering_and_group_membership() {
    let root = snapshot(10, 1, 10, 100);
    let processes = vec![
        root.clone(),
        snapshot(11, 10, 11, 101),
        snapshot(12, 11, 12, 102),
        snapshot(13, 11, 10, 103),
        snapshot(90, 1, 90, 90),
    ];
    for unreadable in [
        vec![11],
        vec![10],
        vec![12, 13],
        vec![90],
        vec![10, 11, 12, 13],
    ] {
        let mut original = ObservedProcessTree::new(root.clone());
        let mut optimized = ObservedProcessTree::new(root.clone());
        compare_frame(&mut original, &mut optimized, &processes, &unreadable);
        // A new escaped child cannot be attributed through an unreadable parent.
        if unreadable == [11] {
            assert!(!optimized.known.iter().any(|process| process.id == 12));
            assert!(optimized.known.iter().any(|process| process.id == 13));
        }
    }
}

#[test]
fn retains_reparented_descendants_and_forgets_reused_pids() {
    let root = snapshot(10, 1, 10, 100);
    let mut original = ObservedProcessTree::new_following_root_exec(root.clone());
    let mut optimized = ObservedProcessTree::new_following_root_exec(root.clone());
    let mut execed = root.clone();
    execed.executable = "/fixture/execed-root".into();
    let mut execed_child = snapshot(12, 1, 12, 102);
    execed_child.executable = "/fixture/execed-child".into();
    let frames = [
        vec![
            root.clone(),
            snapshot(11, 10, 11, 101),
            snapshot(12, 11, 12, 102),
        ],
        vec![
            root.clone(),
            snapshot(12, 1, 12, 102),
            snapshot(13, 12, 13, 103),
        ],
        vec![execed.clone(), execed_child, snapshot(13, 1, 13, 103)],
        vec![execed, snapshot(12, 1, 12, 900), snapshot(13, 1, 13, 103)],
        vec![snapshot(13, 1, 13, 103), snapshot(14, 13, 14, 104)],
        vec![snapshot(90, 1, 90, 90)],
    ];
    for frame in frames {
        compare_frame(&mut original, &mut optimized, &frame, &[]);
    }
}

#[test]
fn still_rejects_root_pid_reuse_and_strict_root_exec() {
    let root = snapshot(10, 1, 10, 100);
    let mut execed = root.clone();
    execed.executable = "/different".into();
    for changed in [snapshot(10, 1, 10, 999), execed] {
        let mut original = ObservedProcessTree::new(root.clone());
        let mut optimized = ObservedProcessTree::new(root.clone());
        compare_frame(
            &mut original,
            &mut optimized,
            std::slice::from_ref(&changed),
            &[],
        );
        let (selected, reads) = filtered(&optimized, &[changed], &[]);
        assert_eq!(reads, [10]);
        assert!(optimized.observe_snapshots(&selected).is_err());
    }
}

#[test]
fn differential_snapshots_preserve_results_across_topologies_and_read_failures() {
    // Fixed seed: exercise reversed enumeration, foreign trees, PGIDs, stale
    // identities and missing paths without nondeterministic live-process races.
    let mut random = 0x8723_u64;
    let mut next = || {
        random = random.wrapping_mul(6364136223846793005).wrapping_add(1);
        random >> 32
    };
    for _ in 0..500 {
        let root = snapshot(10, 1, 10, 100);
        let known = vec![snapshot(20, 10, 20, 110), snapshot(30, 1, 30, 120)];
        let group = (next() % 2 == 0).then_some(10);
        let mut original =
            ObservedProcessTree::new_with_owned_processes(root.clone(), group, None, known.clone());
        let mut optimized =
            ObservedProcessTree::new_with_owned_processes(root.clone(), group, None, known);
        for _ in 0..4 {
            let mut processes = vec![root.clone()];
            let mut unreadable = Vec::new();
            for id in 11..70 {
                let parent = match next() % 4 {
                    0 => 1,
                    1 => 10,
                    _ => 11 + (next() % 59) as u32,
                };
                let pgid = if next() % 3 == 0 { 10 } else { id };
                let start = if next() % 3 == 0 { 90 } else { id as u64 + 90 };
                if next() % 5 == 0 {
                    unreadable.push(id);
                }
                if next() % 5 != 0 {
                    processes.push(snapshot(id, parent, pgid, start));
                }
            }
            processes.reverse();
            compare_frame(&mut original, &mut optimized, &processes, &unreadable);
        }
    }
}
