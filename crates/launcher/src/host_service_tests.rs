use super::{publish_status, readiness, wait_for_shutdown};
use fs2::FileExt;
use std::fs::OpenOptions;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use std::time::{SystemTime, UNIX_EPOCH};
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
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn shutdown_requires_supervised_tree_admission_to_be_released() {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = env::temp_dir().join(format!("codexhost-stop-{}-{nonce}", std::process::id()));
    fs::create_dir_all(&root).unwrap();
    let owner = OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .open(root.join("shared-host-process.lock"))
        .unwrap();
    owner.lock_exclusive().unwrap();
    assert_eq!(
        wait_for_shutdown(&root, None, Duration::from_millis(1))
            .unwrap_err()
            .to_string(),
        "Shared Host process tree exit was not confirmed"
    );
    FileExt::unlock(&owner).unwrap();
    wait_for_shutdown(&root, None, Duration::from_secs(1)).unwrap();
    drop(owner);
    fs::remove_dir_all(&root).unwrap();
    wait_for_shutdown(&root, None, Duration::from_secs(1)).unwrap();
}

#[test]
fn stalled_shutdown_escalates_only_the_captured_process_instance() {
    const TEST: &str =
        "host_service::tests::stalled_shutdown_escalates_only_the_captured_process_instance";
    if let Some(root) = env::var_os("CODEXHOST_STOP_TEST_ROOT") {
        let root = std::path::PathBuf::from(root);
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(root.join("shared-host-process.lock"))
            .unwrap();
        lock.lock_exclusive().unwrap();
        fs::write(root.join("held"), "held").unwrap();
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
    while !root.join("held").exists() {
        assert!(Instant::now() < deadline, "fixture did not hold admission");
        assert!(child.try_wait().unwrap().is_none());
        thread::sleep(Duration::from_millis(20));
    }
    let owner = codexhost_platform::process_snapshot(child.id()).unwrap();
    let mut obsolete = owner.clone();
    obsolete.started_at_micros += 1;
    assert!(wait_for_shutdown(&root, Some(&obsolete), Duration::from_millis(2100)).is_err());
    assert!(
        child.try_wait().unwrap().is_none(),
        "must not terminate a reused PID"
    );
    wait_for_shutdown(&root, Some(&owner), Duration::from_secs(5)).unwrap();
    assert!(!child.wait().unwrap().success());
    fs::remove_dir_all(root).unwrap();
}
