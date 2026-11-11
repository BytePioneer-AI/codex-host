use super::{
    ReadyOwner, publish_ready, publish_status, readiness, remove_ready_record_if_owned,
    wait_for_shutdown,
};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use std::{env, fs, thread};

#[test]
fn publishes_complete_private_status_before_readiness() {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = env::temp_dir().join(format!("codexhost-ready-{}-{nonce}", std::process::id()));
    fs::create_dir_all(&root).unwrap();
    let file = root.join("status.ready");
    let target = file.clone();
    let writer = thread::spawn(move || {
        for index in 0..100 {
            publish_status(
                &target,
                if index % 2 == 0 {
                    "ready\n"
                } else {
                    "startup rejected\n"
                },
            )
            .unwrap();
        }
    });
    while !writer.is_finished() {
        if let Some(Err(error)) = readiness(&file) {
            assert_eq!(error.to_string(), "startup rejected\n");
        }
    }
    writer.join().unwrap();
    assert_eq!(fs::read_to_string(&file).unwrap(), "startup rejected\n");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(fs::metadata(&file).unwrap().permissions().mode() & 0o077, 0);
    }
    publish_ready(&root, std::process::id(), &env::current_exe().unwrap()).unwrap();
    let record: ReadyOwner =
        serde_json::from_slice(&fs::read(root.join("shared-host-ready.json")).unwrap()).unwrap();
    assert_eq!(record.version.as_deref(), Some(env!("CARGO_PKG_VERSION")));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn service_environment_preserves_opt_in_list_tracing() {
    const TEST: &str = "host_service::tests::service_environment_preserves_opt_in_list_tracing";
    if env::var_os("CODEXHOST_TRACE_ENV_TEST").is_some() {
        let mut command = Command::new("unused");
        super::clean(&mut command);
        assert!(
            !command
                .get_envs()
                .any(|(key, _)| key == "CODEXHOST_TRACE_SESSION_LIST")
        );
        assert!(
            command
                .get_envs()
                .any(|(key, value)| key == "CODEXHOST_TRACE_ENV_TEST" && value.is_none())
        );
        return;
    }
    let status = Command::new(env::current_exe().unwrap())
        .args(["--exact", TEST])
        .env("CODEXHOST_TRACE_ENV_TEST", "1")
        .env("CODEXHOST_TRACE_SESSION_LIST", "1")
        .status()
        .unwrap();
    assert!(status.success());
}

#[test]
fn shutdown_without_a_running_owner_returns_immediately() {
    wait_for_shutdown(None, None, Duration::from_millis(1)).unwrap();
}

#[test]
fn ready_record_removal_requires_record_ownership() {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = env::temp_dir().join(format!(
        "codexhost-ready-owner-{}-{nonce}",
        std::process::id()
    ));
    fs::create_dir_all(&root).unwrap();
    let record = root.join("shared-host-ready.json");
    let child = codexhost_platform::process_snapshot(std::process::id()).unwrap();
    publish_ready(&root, std::process::id(), &env::current_exe().unwrap()).unwrap();

    // A reused PID with a different start time and a foreign PID must both keep
    // a record published for another supervisor, for example after a failed
    // startup that never published its own Host.
    let reused_pid = codexhost_platform::ProcessSnapshot {
        started_at_micros: 0,
        ..child.clone()
    };
    let foreign_pid = codexhost_platform::ProcessSnapshot {
        id: child.id.wrapping_add(1),
        ..child.clone()
    };
    remove_ready_record_if_owned(&root, &reused_pid);
    remove_ready_record_if_owned(&root, &foreign_pid);
    assert!(record.is_file());

    // The supervisor that published the record clears it, and a missing record
    // stays a no-op.
    remove_ready_record_if_owned(&root, &child);
    assert!(!record.exists());
    remove_ready_record_if_owned(&root, &child);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn stalled_shutdown_terminates_the_captured_fixture_process() {
    const TEST: &str =
        "host_service::tests::stalled_shutdown_terminates_the_captured_fixture_process";
    if let Some(root) = env::var_os("CODEXHOST_STOP_TEST_ROOT") {
        fs::write(std::path::PathBuf::from(root).join("started"), "started").unwrap();
        loop {
            thread::sleep(Duration::from_millis(20));
        }
    }
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = env::temp_dir().join(format!("codexhost-stalled-{}-{nonce}", std::process::id()));
    fs::create_dir_all(&root).unwrap();
    let mut child = Command::new(env::current_exe().unwrap())
        .args(["--exact", TEST])
        .env("CODEXHOST_STOP_TEST_ROOT", &root)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while !root.join("started").exists() {
        assert!(Instant::now() < deadline, "fixture did not start");
        assert!(child.try_wait().unwrap().is_none());
        thread::sleep(Duration::from_millis(20));
    }
    let owner = codexhost_platform::process_snapshot(child.id()).unwrap();
    assert!(wait_for_shutdown(Some(&owner), None, Duration::from_millis(1)).is_err());
    wait_for_shutdown(Some(&owner), None, Duration::from_secs(5)).unwrap();
    assert!(!child.wait().unwrap().success());
    fs::remove_dir_all(root).unwrap();
}
