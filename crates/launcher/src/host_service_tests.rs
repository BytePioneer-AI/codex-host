use super::{ReadyOwner, publish_ready, publish_status, readiness, wait_for_shutdown};
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
fn ready_identity_ignores_the_image_and_cleanup_preserves_another_owner() {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = env::temp_dir().join(format!("codexhost-owner-{}-{nonce}", std::process::id()));
    fs::create_dir_all(&root).unwrap();
    let file = root.join("shared-host-ready.json");
    publish_ready(&root, std::process::id(), &env::current_exe().unwrap()).unwrap();
    let mut record: ReadyOwner = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
    record.executable = root.join("deleted-package/node");
    fs::write(&file, serde_json::to_vec(&record).unwrap()).unwrap();
    assert!(super::owner_snapshot(&root).is_some());
    assert!(super::current_runtime(&root).is_some());

    let original = fs::read(&file).unwrap();
    super::remove_ready(&root, record.pid + 1);
    assert_eq!(fs::read(&file).unwrap(), original);

    record.started_at_micros += 1;
    fs::write(&file, serde_json::to_vec(&record).unwrap()).unwrap();
    assert!(super::owner_snapshot(&root).is_none());
    assert!(super::current_runtime(&root).is_none());

    super::remove_ready(&root, record.pid);
    assert!(!file.exists());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn service_environment_preserves_opt_in_settings() {
    const TEST: &str = "host_service::tests::service_environment_preserves_opt_in_settings";
    if env::var_os("CODEXHOST_TRACE_ENV_TEST").is_some() {
        let mut command = Command::new("unused");
        super::clean(&mut command);
        for setting in [
            "CODEXHOST_TRACE_SESSION_LIST",
            "CODEXHOST_EXTERNAL_CLIENT_PORT",
        ] {
            assert!(!command.get_envs().any(|(key, _)| key == setting));
        }
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
        .env("CODEXHOST_EXTERNAL_CLIENT_PORT", "4402")
        .status()
        .unwrap();
    assert!(status.success());
}

#[test]
fn shutdown_without_a_running_owner_returns_immediately() {
    wait_for_shutdown(None, None, Duration::from_millis(1)).unwrap();
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[test]
fn shutdown_with_a_reused_owner_identity_waits_for_the_supervisor() {
    use std::sync::mpsc;

    const TEST: &str =
        "host_service::tests::shutdown_with_a_reused_owner_identity_waits_for_the_supervisor";
    if let Some(root) = env::var_os("CODEXHOST_IDENTITY_TEST_ROOT") {
        let root = std::path::PathBuf::from(root);
        let role = env::var("CODEXHOST_IDENTITY_TEST_ROLE").unwrap();
        fs::write(root.join(format!("{role}.ready")), "ready").unwrap();
        let deadline = Instant::now() + Duration::from_secs(15);
        while !root.join(format!("{role}.exit")).exists() {
            assert!(Instant::now() < deadline, "fixture was not released");
            thread::sleep(Duration::from_millis(10));
        }
        return;
    }

    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = env::temp_dir().join(format!("codexhost-identity-{}-{nonce}", std::process::id()));
    fs::create_dir_all(&root).unwrap();
    let spawn = |role: &str| {
        Command::new(env::current_exe().unwrap())
            .args(["--exact", TEST])
            .env("CODEXHOST_IDENTITY_TEST_ROOT", &root)
            .env("CODEXHOST_IDENTITY_TEST_ROLE", role)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap()
    };
    let mut replacement = spawn("replacement");
    let mut supervisor = spawn("supervisor");
    let deadline = Instant::now() + Duration::from_secs(5);
    while !root.join("replacement.ready").exists() || !root.join("supervisor.ready").exists() {
        assert!(Instant::now() < deadline, "fixtures did not start");
        thread::sleep(Duration::from_millis(10));
    }
    let mut stale_owner = codexhost_platform::process_identity(replacement.id()).unwrap();
    let supervisor_identity = codexhost_platform::process_identity(supervisor.id()).unwrap();
    assert_eq!(stale_owner.parent_id, std::process::id());
    assert_eq!(supervisor_identity.parent_id, std::process::id());
    // A different captured start time represents PID reuse without recycling an OS PID.
    stale_owner.started_at_micros -= 1;
    let reaper = thread::spawn(move || supervisor.wait().unwrap());
    let (sender, receiver) = mpsc::channel();
    let waiter = thread::spawn(move || {
        let result = wait_for_shutdown(
            Some(&stale_owner),
            Some(&supervisor_identity),
            Duration::from_secs(8),
        )
        .map_err(|error| error.to_string());
        sender.send(result).unwrap();
    });
    let early = receiver.recv_timeout(Duration::from_millis(2500));
    let still_waiting = matches!(early, Err(mpsc::RecvTimeoutError::Timeout));
    let replacement_alive = replacement.try_wait().unwrap().is_none();
    fs::write(root.join("supervisor.exit"), "exit").unwrap();
    let result = early.unwrap_or_else(|_| receiver.recv_timeout(Duration::from_secs(5)).unwrap());
    waiter.join().unwrap();
    let supervisor_status = reaper.join().unwrap();
    fs::write(root.join("replacement.exit"), "exit").unwrap();
    let replacement_status = replacement.wait().unwrap();
    fs::remove_dir_all(root).unwrap();

    assert!(
        still_waiting,
        "shutdown returned before supervisor exit: {result:?}"
    );
    assert!(result.is_ok(), "shutdown failed: {result:?}");
    assert!(
        replacement_alive && replacement_status.success(),
        "replacement was terminated"
    );
    assert!(supervisor_status.success());
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
    let owner = codexhost_platform::process_identity(child.id()).unwrap();
    assert!(wait_for_shutdown(Some(&owner), None, Duration::from_millis(1)).is_err());
    wait_for_shutdown(Some(&owner), None, Duration::from_secs(5)).unwrap();
    assert!(!child.wait().unwrap().success());
    fs::remove_dir_all(root).unwrap();
}
