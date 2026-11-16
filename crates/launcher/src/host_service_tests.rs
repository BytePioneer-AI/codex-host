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
