use std::path::Path;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use super::{
    belongs_to_current_parent, descendant_process_snapshots, process_instance_exists,
    process_snapshot, running_executable_snapshots, running_executable_snapshots_with,
    windows_descendant_ids, windows_executable_key,
};
use crate::terminate_process_instance;
use crate::windows_process::ProcessEntry;
use crate::{PlatformError, ProcessSnapshot};

fn entry(id: u32, parent_id: u32, executable_name: &str) -> ProcessEntry {
    ProcessEntry {
        id,
        parent_id,
        executable_name: executable_name.into(),
    }
}

fn snapshot(executable: &str) -> ProcessSnapshot {
    ProcessSnapshot {
        id: 42,
        parent_id: 1,
        process_group_id: 42,
        executable: executable.into(),
        started_at_micros: 200,
    }
}

fn inaccessible_process(process_id: u32) -> PlatformError {
    PlatformError::ProcessInspection {
        process_id,
        operation: "read executable",
        source: std::io::Error::from(std::io::ErrorKind::PermissionDenied),
    }
}

#[test]
fn treats_verbatim_and_regular_windows_executable_paths_as_equal() {
    assert_eq!(
        windows_executable_key(Path::new(r"\\?\D:\Program\node.exe")),
        windows_executable_key(Path::new(r"d:\program\node.exe")),
    );
}

#[test]
fn captures_descendants_before_intermediate_parents_exit() {
    let entries = [
        entry(1, 0, "root.exe"),
        entry(2, 1, "child.exe"),
        entry(3, 2, "child.exe"),
        entry(4, 3, "child.exe"),
    ];
    assert_eq!(windows_descendant_ids(1, &entries), [2, 3, 4]);
    // A post-shutdown snapshot cannot rediscover the surviving orphan chain.
    assert!(windows_descendant_ids(1, &entries[2..]).is_empty());
}

#[test]
fn finds_the_current_windows_process_by_executable() {
    // Use this test binary rather than cmd.exe: parallel tests may launch
    // unrelated cmd.exe children whose images are not always inspectable.
    let current = process_snapshot(std::process::id()).expect("current process snapshot");
    let matching =
        running_executable_snapshots(&[&current.executable]).expect("scan the current executable");
    assert!(matching.iter().any(|snapshot| snapshot.id == current.id));
}

#[test]
fn checks_the_exact_windows_process_instance() {
    let current = process_snapshot(std::process::id()).expect("current process snapshot");
    assert!(
        process_instance_exists(current.id, current.started_at_micros)
            .expect("inspect current instance")
    );
    assert!(
        !process_instance_exists(current.id, current.started_at_micros.saturating_add(1))
            .expect("reject another instance")
    );
}

#[test]
fn scans_the_final_snapshot_executable_after_a_candidate_pid_is_reused() {
    let matching = running_executable_snapshots_with(
        &[Path::new(r"C:\codexhost\node.exe")],
        &[entry(42, 1, "node.exe")],
        |_| Ok(snapshot(r"C:\unrelated\node.exe")),
        |_| panic!("a readable snapshot needs no failure recheck"),
    )
    .expect("scan the replacement process instance");

    assert!(matching.is_empty());
}

#[test]
fn matches_case_and_verbatim_paths_in_the_final_snapshot() {
    let current = snapshot(r"\\?\C:\CODEXHOST\NODE.EXE");
    let matching = running_executable_snapshots_with(
        &[Path::new(r"c:/codexhost/node.exe")],
        &[entry(42, 1, "NODE.EXE")],
        |_| Ok(current.clone()),
        |_| panic!("a readable snapshot needs no failure recheck"),
    )
    .expect("scan the normalized executable path");

    assert_eq!(matching, [current]);
}

#[test]
fn rejects_a_live_candidate_whose_process_identity_cannot_be_read() {
    let error = running_executable_snapshots_with(
        &[Path::new(r"C:\codexhost\node.exe")],
        &[entry(42, 1, "NODE.EXE")],
        |process_id| Err(inaccessible_process(process_id)),
        |process_id| {
            assert_eq!(process_id, 42);
            Ok(true)
        },
    )
    .expect_err("an unreadable relevant live process must block the update");

    assert!(matches!(
        error,
        PlatformError::ProcessInspection { process_id: 42, .. }
    ));
}

#[test]
fn skips_an_inaccessible_candidate_that_has_exited() {
    let matching = running_executable_snapshots_with(
        &[Path::new(r"C:\codexhost\node.exe")],
        &[entry(42, 1, "node.exe")],
        |process_id| Err(inaccessible_process(process_id)),
        |_| Ok(false),
    )
    .expect("an exited process cannot hold the executable open");

    assert!(matching.is_empty());
}

#[test]
fn skips_unrelated_protected_processes_without_reading_their_images() {
    let matching = running_executable_snapshots_with(
        &[Path::new(r"C:\codexhost\node.exe")],
        &[entry(4, 0, "System"), entry(100, 4, "csrss.exe")],
        |_| panic!("unrelated protected processes must not be inspected"),
        |_| panic!("unrelated protected processes need no failure recheck"),
    )
    .expect("skip unrelated protected processes");

    assert!(matching.is_empty());
}

#[test]
fn propagates_a_failed_liveness_recheck_for_an_inaccessible_candidate() {
    let error = running_executable_snapshots_with(
        &[Path::new(r"C:\codexhost\node.exe")],
        &[entry(42, 1, "node.exe")],
        |process_id| Err(inaccessible_process(process_id)),
        |_| {
            Err(PlatformError::Io(std::io::Error::other(
                "enumeration failed",
            )))
        },
    )
    .expect_err("an enumeration failure cannot establish that the process exited");

    assert!(error.to_string().contains("enumeration failed"));
}

#[test]
fn terminates_captured_descendants_after_the_windows_root_exits() {
    let mut root = Command::new("cmd.exe")
        .args(["/d", "/c", "ping -n 10 127.0.0.1 >NUL"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("start process tree root");
    let root_snapshot = process_snapshot(root.id()).expect("root process snapshot");
    let deadline = Instant::now() + Duration::from_secs(3);
    let captured = loop {
        let snapshots = descendant_process_snapshots(&root_snapshot, &[])
            .expect("inspect process tree descendants");
        if !snapshots.is_empty() {
            break Some(snapshots);
        }
        if Instant::now() >= deadline {
            break None;
        }
        thread::sleep(Duration::from_millis(20));
    };
    let captured = captured.expect("cmd.exe did not start its ping.exe descendant");
    let required_executable = &captured[0].executable;
    let required = descendant_process_snapshots(&root_snapshot, &[required_executable])
        .expect("capture the required descendant executable");
    assert!(
        required
            .iter()
            .any(|snapshot| snapshot.id == captured[0].id)
    );
    let _ = root.kill();
    let _ = root.wait();
    assert!(
        !process_instance_exists(root_snapshot.id, root_snapshot.started_at_micros)
            .expect("observe stopped root")
    );
    for descendant in &captured {
        terminate_process_instance(descendant, true).expect("terminate captured descendant");
    }
    for descendant in &captured {
        let deadline = Instant::now() + Duration::from_secs(2);
        while process_instance_exists(descendant.id, descendant.started_at_micros)
            .expect("observe terminated descendant")
            && Instant::now() < deadline
        {
            thread::sleep(Duration::from_millis(20));
        }
        assert!(
            !process_instance_exists(descendant.id, descendant.started_at_micros)
                .expect("confirm descendant exit")
        );
    }
}

#[test]
fn rejects_an_old_orphan_after_its_parent_pid_is_reused() {
    let parent = super::ProcessSnapshot {
        id: 42,
        parent_id: 1,
        process_group_id: 42,
        executable: "parent.exe".into(),
        started_at_micros: 200,
    };
    let old_orphan = super::ProcessSnapshot {
        id: 43,
        parent_id: 42,
        process_group_id: 43,
        executable: "old-child.exe".into(),
        started_at_micros: 100,
    };
    assert!(!belongs_to_current_parent(&parent, &old_orphan));
}
