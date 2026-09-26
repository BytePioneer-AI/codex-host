use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::json;

#[cfg(any(target_os = "macos", target_os = "windows"))]
use super::STATUS_FILE;
use super::{ACTIVE_UPDATE_LOCK_FILE, PendingUpdate, waiting_for_launcher_exit_at};
#[cfg(any(target_os = "macos", target_os = "windows"))]
use super::{
    StartedUpdate, atomic_replace_file, pending_startable_update_at, pending_update_at,
    record_updater_start_failure, start_pending_update_at, transfer_lock_to_updater,
    wait_for_updater_ready,
};

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn sleeping_helper() -> std::process::Child {
    let mut command = std::process::Command::new(if cfg!(target_os = "windows") {
        "ping"
    } else {
        "/bin/sleep"
    });
    if cfg!(target_os = "windows") {
        command.args(["-n", "60", "127.0.0.1"]);
    } else {
        command.arg("60");
    }
    #[cfg(target_os = "windows")]
    codexhost_platform::configure_background_command(&mut command);
    command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("spawn sleeping Helper fixture")
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn set_phase(pending: &PendingUpdate, phase: &str) {
    let mut status = read_status(pending);
    status["phase"] = phase.into();
    fs::write(&pending.status_path, serde_json::to_vec(&status).unwrap())
        .expect("write update phase");
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn read_status(pending: &PendingUpdate) -> serde_json::Value {
    serde_json::from_slice(&fs::read(&pending.status_path).expect("read update status"))
        .expect("parse update status")
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn ready_helper(label: &str) -> (PathBuf, StartedUpdate) {
    let root = fixture_directory(label);
    let pending = write_pending_update(
        &root,
        &std::env::current_exe().expect("current Launcher executable"),
        std::process::id(),
    );
    let mut child = sleeping_helper();
    set_phase(&pending, "waiting-for-exit");
    wait_for_updater_ready(&mut child, &pending.status_path).expect("Helper is ready");
    (
        root,
        StartedUpdate {
            child,
            pending,
            abort_reason: None,
        },
    )
}

fn fixture_directory(label: &str) -> PathBuf {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system time")
        .as_nanos();
    let path =
        std::env::temp_dir().join(format!("codexhost-{label}-{}-{unique}", std::process::id()));
    fs::create_dir(&path).expect("create active update fixture");
    path
}

fn write_pending_update(root: &Path, launcher: &Path, launcher_pid: u32) -> PendingUpdate {
    write_pending_update_in(root, launcher, launcher_pid, "update-1.2.3-fixture")
}

fn write_pending_update_in(
    root: &Path,
    launcher: &Path,
    launcher_pid: u32,
    operation_name: &str,
) -> PendingUpdate {
    let operation = root.join(operation_name);
    fs::create_dir_all(&operation).expect("create update operation fixture");
    let helper_path = operation.join(super::UPDATER_FILE);
    fs::write(&helper_path, b"helper").expect("write Helper fixture");
    let status_path = operation.join("status-v1.json");
    fs::write(
        &status_path,
        format!(
            "{}\n",
            json!({
                "schemaVersion": 1,
                "version": "1.2.3",
                "installation": "macos-dmg",
                "phase": "prepared",
                "updatedAt": 1,
            })
        ),
    )
    .expect("write update status fixture");
    let request_path = operation.join("request-v1.json");
    fs::write(
        &request_path,
        format!(
            "{}\n",
            json!({
                "schema_version": 1,
                "version": "1.2.3",
                "wait_pid": launcher_pid,
                "wait_executable": launcher,
                "status_path": status_path,
                "installation": { "kind": "macos-dmg" },
            })
        ),
    )
    .expect("write update request fixture");
    fs::write(
        root.join(ACTIVE_UPDATE_LOCK_FILE),
        format!("{}\n", json!({ "ownerPid": 42, "statusPath": status_path })),
    )
    .expect("write active update lock fixture");
    PendingUpdate {
        lock_path: root.join(ACTIVE_UPDATE_LOCK_FILE),
        status_path: status_path
            .canonicalize()
            .expect("canonical status fixture"),
        helper_path: helper_path
            .canonicalize()
            .expect("canonical Helper fixture"),
        request_path: request_path
            .canonicalize()
            .expect("canonical request fixture"),
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
#[test]
fn resolves_only_a_request_for_the_current_launcher() {
    let fixture = fixture_directory("pending-update");
    let root = fixture.join("updates");
    fs::create_dir(&root).expect("create update root");
    let launcher = fixture.join("codexhost");
    fs::write(&launcher, b"launcher").expect("write Launcher fixture");
    let expected = write_pending_update(&root, &launcher, 42);

    assert_eq!(
        pending_startable_update_at(&root, 42, &launcher).expect("resolve pending update"),
        Some(expected)
    );
    assert!(pending_update_at(&root, 43, &launcher).is_err());
    fs::remove_dir_all(fixture).expect("remove pending update fixture");
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
#[test]
fn waits_for_the_updater_ready_handshake_before_returning() {
    let fixture = fixture_directory("updater-ready");
    let status_path = fixture.join(STATUS_FILE);
    fs::write(
        &status_path,
        format!(
            "{}\n",
            json!({
                "schemaVersion": 1,
                "version": "1.2.3",
                "installation": "macos-dmg",
                "phase": "prepared",
                "updatedAt": 1,
            })
        ),
    )
    .expect("write prepared status fixture");
    let mut command = std::process::Command::new(if cfg!(target_os = "windows") {
        "ping"
    } else {
        "/bin/sleep"
    });
    if cfg!(target_os = "windows") {
        command.args(["-n", "4", "127.0.0.1"]);
    } else {
        command.arg("2");
    }
    let mut child = command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("spawn updater fixture");
    let ready_status_path = status_path.clone();
    let writer = std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(50));
        let temporary_status_path =
            ready_status_path.with_file_name(format!(".{STATUS_FILE}.{}.tmp", std::process::id()));
        fs::write(
            &temporary_status_path,
            format!(
                "{}\n",
                json!({
                    "schemaVersion": 1,
                    "version": "1.2.3",
                    "installation": "macos-dmg",
                    "phase": "waiting-for-exit",
                    "updatedAt": 2,
                })
            ),
        )
        .expect("write waiting status fixture");
        atomic_replace_file(&temporary_status_path, &ready_status_path)
            .expect("publish waiting status fixture");
    });
    let started = std::time::Instant::now();
    wait_for_updater_ready(&mut child, &status_path).expect("wait for updater readiness");
    assert!(started.elapsed() >= std::time::Duration::from_millis(40));
    writer.join().expect("join status writer");
    child.kill().expect("stop updater fixture");
    let _ = child.wait().expect("reap updater fixture");
    fs::remove_dir_all(fixture).expect("remove updater ready fixture");
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
#[test]
fn does_not_accept_a_waiting_status_from_an_exited_updater() {
    let fixture = fixture_directory("exited-updater");
    let status_path = fixture.join(STATUS_FILE);
    fs::write(
        &status_path,
        format!(
            "{}\n",
            json!({
                "schemaVersion": 1,
                "version": "1.2.3",
                "installation": "npm",
                "phase": "waiting-for-exit",
                "updatedAt": 1,
            })
        ),
    )
    .expect("write stale waiting status");
    let mut command = std::process::Command::new(if cfg!(target_os = "windows") {
        "cmd.exe"
    } else {
        "/usr/bin/true"
    });
    if cfg!(target_os = "windows") {
        command.args(["/d", "/c", "exit", "0"]);
    }
    let mut child = command.spawn().expect("spawn exiting updater fixture");
    child.wait().expect("reap exiting updater fixture");

    assert!(wait_for_updater_ready(&mut child, &status_path).is_err());
    fs::remove_dir_all(fixture).expect("remove exited updater fixture");
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
#[test]
fn transfers_the_active_lock_to_the_updater_process() {
    let fixture = fixture_directory("update-owner");
    let root = fixture.join("updates");
    fs::create_dir(&root).expect("create update root");
    let launcher = fixture.join("codexhost");
    fs::write(&launcher, b"launcher").expect("write Launcher fixture");
    let pending = write_pending_update(&root, &launcher, 42);

    transfer_lock_to_updater(&pending, 99).expect("transfer update lock");
    let lock = serde_json::from_slice::<serde_json::Value>(
        &fs::read(root.join(ACTIVE_UPDATE_LOCK_FILE)).expect("read transferred lock"),
    )
    .expect("parse transferred lock");
    assert_eq!(lock["ownerPid"], 99);
    assert_eq!(lock["statusPath"].as_str(), pending.status_path.to_str());
    fs::remove_dir_all(fixture).expect("remove transferred lock fixture");
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
#[test]
fn waits_until_the_final_request_exists() {
    let fixture = fixture_directory("incomplete-update");
    let root = fixture.join("updates");
    fs::create_dir(&root).expect("create update root");
    let launcher = fixture.join("codexhost");
    fs::write(&launcher, b"launcher").expect("write Launcher fixture");
    let expected = write_pending_update(&root, &launcher, 42);
    fs::remove_file(expected.request_path).expect("remove incomplete request");

    assert_eq!(
        pending_startable_update_at(&root, 42, &launcher).expect("ignore incomplete update"),
        None
    );
    fs::remove_dir_all(fixture).expect("remove incomplete update fixture");
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
#[test]
fn records_a_failed_helper_launch_without_retrying_the_prepared_request() {
    let fixture = fixture_directory("helper-start-failure");
    let root = fixture.join("updates");
    fs::create_dir(&root).expect("create update root");
    let launcher = fixture.join("codexhost");
    fs::write(&launcher, b"launcher").expect("write Launcher fixture");
    let pending = write_pending_update(&root, &launcher, 42);
    let mut started_request = None;

    assert!(start_pending_update_at(&root, 42, &launcher, &mut started_request).is_err());
    assert!(started_request.is_none());
    let status = serde_json::from_slice::<serde_json::Value>(
        &fs::read(&pending.status_path).expect("read failed update status"),
    )
    .expect("parse failed update status");
    assert_eq!(status["phase"], "failed");
    assert!(
        status["error"]
            .as_str()
            .is_some_and(|error| !error.is_empty())
    );
    assert_eq!(
        pending_startable_update_at(&root, 42, &launcher).expect("ignore failed operation"),
        None
    );
    fs::remove_dir_all(fixture).expect("remove failed update fixture");
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
#[test]
fn preserves_a_failure_reported_by_the_helper() {
    let fixture = fixture_directory("helper-reported-failure");
    let root = fixture.join("updates");
    fs::create_dir(&root).expect("create update root");
    let launcher = fixture.join("codexhost");
    fs::write(&launcher, b"launcher").expect("write Launcher fixture");
    let pending = write_pending_update(&root, &launcher, 42);
    let original = json!({
        "schemaVersion": 1,
        "version": "1.2.3",
        "installation": "macos-dmg",
        "phase": "failed",
        "updatedAt": 2,
        "error": "Helper rejected the request",
    });
    fs::write(&pending.status_path, format!("{original}\n")).expect("write Helper failure status");

    record_updater_start_failure(&pending, &std::io::Error::other("Launcher timeout"))
        .expect("preserve Helper failure");
    let status = serde_json::from_slice::<serde_json::Value>(
        &fs::read(&pending.status_path).expect("read Helper failure status"),
    )
    .expect("parse Helper failure status");
    assert_eq!(status, original);
    fs::remove_dir_all(fixture).expect("remove Helper failure fixture");
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
#[test]
fn clears_a_completed_helper_before_considering_another_request() {
    let fixture = fixture_directory("completed-helper");
    let root = fixture.join("updates");
    fs::create_dir(&root).expect("create update root");
    let launcher = fixture.join("codexhost");
    fs::write(&launcher, b"launcher").expect("write Launcher fixture");
    let pending = write_pending_update(&root, &launcher, 42);
    fs::write(
        &pending.status_path,
        format!(
            "{}\n",
            json!({
                "schemaVersion": 1,
                "version": "1.2.3",
                "installation": "npm",
                "phase": "failed",
                "updatedAt": 2,
                "error": "Helper exited",
            })
        ),
    )
    .expect("write terminal status");
    let mut started_request = Some(StartedUpdate {
        child: sleeping_helper(),
        pending,
        abort_reason: None,
    });

    start_pending_update_at(&root, 42, &launcher, &mut started_request)
        .expect("ignore terminal operation");
    assert!(started_request.is_none());
    fs::remove_dir_all(fixture).expect("remove completed Helper fixture");
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
#[test]
fn records_a_helper_exit_after_the_ready_handshake() {
    let (root, mut started) = ready_helper("helper-exits-after-ready");
    assert!(
        started
            .waiting_for_launcher_exit()
            .expect("live Helper is waiting")
    );
    started
        .child
        .kill()
        .expect("simulate Helper crash after ready");
    started.child.wait().expect("wait for crashed Helper");
    assert_eq!(read_status(&started.pending)["phase"], "waiting-for-exit");
    assert!(
        !started
            .waiting_for_launcher_exit()
            .expect("detect crashed Helper")
    );
    let status = read_status(&started.pending);
    assert_eq!(status["phase"], "failed");
    assert!(
        status["error"]
            .as_str()
            .unwrap()
            .contains("exited after becoming ready")
    );

    let mut operation = Some(started);
    start_pending_update_at(
        &root,
        std::process::id(),
        &std::env::current_exe().unwrap(),
        &mut operation,
    )
    .expect("clear failed Helper without restarting it");
    assert!(operation.is_none());
    fs::remove_dir_all(root).expect("remove crashed Helper fixture");
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
#[test]
fn abort_reaps_the_helper_before_recording_failure() {
    let (root, mut started) = ready_helper("abort-ready-helper");
    started
        .abort(&std::io::Error::other(
            "Desktop ownership could not be verified",
        ))
        .expect("abort Helper");

    assert!(started.child.try_wait().unwrap().is_some());
    let status = read_status(&started.pending);
    assert_eq!(status["phase"], "failed");
    assert_eq!(status["error"], "Desktop ownership could not be verified");
    assert!(
        !started
            .waiting_for_launcher_exit()
            .expect("aborted Helper cannot close Desktop")
    );
    fs::remove_dir_all(root).expect("remove aborted Helper fixture");
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
#[test]
fn a_failed_status_stops_the_helper_without_closing_desktop() {
    let (root, mut started) = ready_helper("failed-ready-helper");
    set_phase(&started.pending, "failed");
    let original = read_status(&started.pending);

    assert!(
        !started
            .waiting_for_launcher_exit()
            .expect("failed status disables update stop")
    );
    assert!(started.child.try_wait().unwrap().is_some());
    assert_eq!(read_status(&started.pending), original);
    fs::remove_dir_all(root).expect("remove failed Helper fixture");
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
#[test]
fn cancelled_helper_cannot_resume_when_failure_recording_needs_retry() {
    let (root, mut started) = ready_helper("retry-abort-status");
    let waiting = fs::read(&started.pending.status_path).expect("read waiting fixture");
    fs::write(&started.pending.status_path, b"invalid status").expect("break status write");
    assert!(
        started
            .abort(&std::io::Error::other("cancelled operation"))
            .is_err()
    );
    assert!(started.child.try_wait().unwrap().is_some());

    fs::write(&started.pending.status_path, waiting).expect("restore waiting fixture");
    assert!(
        !started
            .waiting_for_launcher_exit()
            .expect("retry cancellation status")
    );
    let status = read_status(&started.pending);
    assert_eq!(status["phase"], "failed");
    assert_eq!(status["error"], "cancelled operation");
    fs::remove_dir_all(root).expect("remove retried cancellation fixture");
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
#[test]
fn a_stale_ready_helper_cannot_use_a_different_active_request() {
    let (root, mut started) = ready_helper("stale-ready-helper");
    let next = write_pending_update_in(
        &root,
        &std::env::current_exe().unwrap(),
        std::process::id(),
        "update-1.2.4-fixture",
    );
    set_phase(&next, "waiting-for-exit");

    assert!(
        !started
            .waiting_for_launcher_exit()
            .expect("abort detached update request")
    );
    assert!(started.child.try_wait().unwrap().is_some());
    assert_eq!(read_status(&started.pending)["phase"], "failed");
    assert_eq!(read_status(&next)["phase"], "waiting-for-exit");
    fs::remove_dir_all(root).expect("remove stale Helper fixture");
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
#[test]
fn abort_preserves_the_helper_failure_while_stopping_its_process() {
    let (root, mut started) = ready_helper("abort-helper-own-failure");
    let mut original = read_status(&started.pending);
    original["phase"] = "failed".into();
    original["error"] = "Helper could not verify the Launcher".into();
    fs::write(
        &started.pending.status_path,
        serde_json::to_vec(&original).unwrap(),
    )
    .expect("write Helper failure");

    started
        .abort(&std::io::Error::other("Launcher stop failed"))
        .expect("abort failed Helper");
    assert!(started.child.try_wait().unwrap().is_some());
    assert_eq!(read_status(&started.pending), original);
    fs::remove_dir_all(root).expect("remove Helper own failure fixture");
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
#[test]
fn a_removed_status_does_not_leave_an_unmanaged_live_helper() {
    let (root, mut started) = ready_helper("removed-helper-status");
    fs::remove_file(&started.pending.status_path).expect("remove update status");

    assert!(
        !started
            .waiting_for_launcher_exit()
            .expect("removed status disables update stop")
    );
    assert!(started.child.try_wait().unwrap().is_some());
    fs::remove_dir_all(root).expect("remove deleted status fixture");
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
#[test]
fn polling_aborts_the_helper_when_desktop_shutdown_fails() {
    let (root, started) = ready_helper("poll-desktop-stop-failure");
    let mut operation = Some(started);
    let mut stop_calls = 0;
    let ready = crate::desktop_update::poll_pending_update(&mut operation, |_| {
        stop_calls += 1;
        Err(std::io::Error::other("Desktop ownership was lost").into())
    })
    .expect("cancel failed Desktop handoff");

    assert!(!ready);
    assert_eq!(stop_calls, 1);
    let started = operation
        .as_mut()
        .expect("keep cancelled operation until cleanup");
    assert!(started.child.try_wait().unwrap().is_some());
    let status = read_status(&started.pending);
    assert_eq!(status["phase"], "failed");
    assert_eq!(status["error"], "Desktop ownership was lost");
    fs::remove_dir_all(root).expect("remove failed Desktop handoff fixture");
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
#[test]
fn polling_retains_cancellation_until_its_failure_can_be_recorded() {
    let (root, started) = ready_helper("poll-cancellation-retry");
    let status_path = started.pending.status_path.clone();
    let waiting = fs::read(&status_path).expect("read waiting fixture");
    let mut operation = Some(started);
    let mut stop_calls = 0;
    let result = crate::desktop_update::poll_pending_update(&mut operation, |started| {
        stop_calls += 1;
        fs::write(&started.pending.status_path, b"invalid status")?;
        Err(std::io::Error::other("Desktop shutdown failed").into())
    });

    assert!(
        result.is_err(),
        "unfinished cancellation must keep the Launcher alive"
    );
    let retained = operation.as_mut().expect("retain cancelled operation");
    assert!(retained.child.try_wait().unwrap().is_some());
    assert_eq!(
        retained.abort_reason.as_deref(),
        Some("Desktop shutdown failed")
    );
    assert!(
        crate::desktop_update::poll_pending_update(&mut operation, |_| {
            stop_calls += 1;
            Ok(())
        })
        .is_err()
    );
    assert_eq!(
        stop_calls, 1,
        "cancellation must not retry Desktop shutdown"
    );
    assert!(operation.is_some());

    fs::write(&status_path, waiting).expect("restore waiting fixture");
    // Explicitly select the fixture directory when cleanup can clear Some;
    // polling the global entry point here would then inspect real user state.
    start_pending_update_at(
        &root,
        std::process::id(),
        &std::env::current_exe().unwrap(),
        &mut operation,
    )
    .expect("finish cancellation without restarting the Helper");
    assert!(operation.is_none());
    let status: serde_json::Value =
        serde_json::from_slice(&fs::read(status_path).unwrap()).unwrap();
    assert_eq!(status["phase"], "failed");
    assert_eq!(status["error"], "Desktop shutdown failed");
    assert_eq!(stop_calls, 1);
    fs::remove_dir_all(root).expect("remove cancellation retry fixture");
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
#[test]
fn polling_rejects_a_helper_exit_during_successful_desktop_shutdown() {
    let (root, started) = ready_helper("poll-helper-exit-during-stop");
    let mut operation = Some(started);
    let ready = crate::desktop_update::poll_pending_update(&mut operation, |started| {
        started.child.kill()?;
        started.child.wait()?;
        Ok(())
    })
    .expect("cancel handoff after Helper exit");

    assert!(!ready);
    let started = operation
        .as_mut()
        .expect("retain failed operation until cleanup");
    assert!(started.child.try_wait().unwrap().is_some());
    let status = read_status(&started.pending);
    assert_eq!(status["phase"], "failed");
    assert!(
        status["error"]
            .as_str()
            .unwrap()
            .contains("exited after becoming ready")
    );
    fs::remove_dir_all(root).expect("remove Helper exit during stop fixture");
}

#[test]
fn treats_waiting_for_exit_as_a_managed_desktop_stop() {
    let fixture = fixture_directory("waiting-update");
    let root = fixture.join("updates");
    fs::create_dir(&root).expect("create update root");
    let launcher = fixture.join("codexhost");
    fs::write(&launcher, b"launcher").expect("write Launcher fixture");
    let pending = write_pending_update(&root, &launcher, 42);
    fs::write(
        &pending.status_path,
        format!(
            "{}\n",
            json!({
                "schemaVersion": 1,
                "version": "1.2.3",
                "installation": "macos-dmg",
                "phase": "waiting-for-exit",
                "updatedAt": 2,
            })
        ),
    )
    .expect("write waiting status fixture");

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    assert_eq!(
        pending_startable_update_at(&root, 42, &launcher).expect("do not restart Helper"),
        None
    );
    assert!(waiting_for_launcher_exit_at(&root, 42, &launcher).expect("detect waiting update"));
    assert!(waiting_for_launcher_exit_at(&root, 43, &launcher).is_err());
    fs::remove_dir_all(fixture).expect("remove waiting update fixture");
}
