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
    // A timed-out wait escalates to forced termination of the waited target
    // instead of failing, so a short timeout is enough to stop the stalled
    // fixture and confirm shutdown.
    wait_for_shutdown(Some(&owner), None, Duration::from_millis(1)).unwrap();
    assert!(!child.wait().unwrap().success());
    fs::remove_dir_all(root).unwrap();
}

#[cfg(target_os = "linux")]
#[test]
fn forced_shutdown_cleans_descendants_in_another_process_group() {
    use std::io::BufRead;
    use std::os::unix::process::CommandExt;

    let mut supervisor = Command::new("/bin/sh")
        .args(["-c", "setsid /bin/sleep 30 & echo $!; read release"])
        .process_group(0)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut pid = String::new();
    std::io::BufReader::new(supervisor.stdout.take().unwrap())
        .read_line(&mut pid)
        .unwrap();
    let child_id = pid.trim().parse::<u32>().unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    let child = loop {
        if let Ok(child) = codexhost_platform::process_snapshot(child_id)
            && child.process_group_id == child_id
        {
            break child;
        }
        assert!(
            Instant::now() < deadline,
            "child did not enter its own group"
        );
        thread::sleep(Duration::from_millis(10));
    };
    let identity = codexhost_platform::process_identity(supervisor.id()).unwrap();
    assert_eq!(child.parent_id, identity.id);
    assert_ne!(child.process_group_id, identity.id);
    // Same-PGID alone is not ownership: this process is our child, not the
    // supervisor's descendant, and must survive its shutdown.
    let mut bystander = Command::new("/bin/sleep")
        .arg("30")
        .process_group(identity.id as i32)
        .spawn()
        .unwrap();
    let mut reused = identity;
    reused.started_at_micros += 1;
    assert!(wait_for_shutdown(None, Some(&reused), Duration::ZERO).is_err());
    assert!(supervisor.try_wait().unwrap().is_none());
    let result = wait_for_shutdown(None, Some(&identity), Duration::from_millis(1));
    let bystander_survived = bystander.try_wait().unwrap().is_none();
    bystander.kill().unwrap();
    bystander.wait().unwrap();
    let survived =
        codexhost_platform::process_instance(child.id, child.started_at_micros).is_some();
    // Clean even on the negative baseline, then assert the production result.
    codexhost_platform::terminate_process_instance(&child, true).unwrap();
    supervisor.wait().unwrap();
    result.unwrap();
    assert!(
        bystander_survived,
        "shutdown killed an unrelated same-group process"
    );
    assert!(
        !survived,
        "shutdown reported success while its child remained alive"
    );
}

#[test]
fn stalled_supervisor_shutdown_is_escalated_when_no_owner_was_captured() {
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
    let root = env::temp_dir().join(format!(
        "codexhost-stalled-supervisor-{}-{nonce}",
        std::process::id()
    ));
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
    let supervisor = codexhost_platform::process_identity(child.id()).unwrap();
    // The Desktop stop path passes no captured owner: the waited supervisor is
    // the validated Launcher identity, and the timed-out wait must escalate
    // termination on it (#861) rather than only reporting a timeout.
    wait_for_shutdown(None, Some(&supervisor), Duration::from_millis(1)).unwrap();
    assert!(!child.wait().unwrap().success());
    fs::remove_dir_all(root).unwrap();
}
