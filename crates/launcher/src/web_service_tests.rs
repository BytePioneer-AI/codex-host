use super::{Options, ReadyOwner, WebAccess};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use std::{env, fs, thread};

#[test]
fn stop_waits_for_the_recorded_instance_without_its_original_image() {
    const TEST: &str =
        "web_service::tests::stop_waits_for_the_recorded_instance_without_its_original_image";
    if let Some(root) = env::var_os("CODEXHOST_WEB_STOP_TEST") {
        let root = std::path::PathBuf::from(root);
        fs::write(root.join("started"), "ready").unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        while !root.join("web-service.stop").exists() {
            assert!(Instant::now() < deadline, "stop request not received");
            thread::sleep(Duration::from_millis(10));
        }
        thread::sleep(Duration::from_millis(200));
        fs::write(root.join("stopped"), "done").unwrap();
        return;
    }
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = env::temp_dir().join(format!("codexhost-web-stop-{}-{nonce}", std::process::id()));
    fs::create_dir_all(&root).unwrap();
    let executable = env::current_exe().unwrap();
    let mut child = Command::new(&executable)
        .args(["--exact", TEST])
        .env("CODEXHOST_WEB_STOP_TEST", &root)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !root.join("started").exists() {
            assert!(Instant::now() < deadline, "fixture did not start");
            thread::sleep(Duration::from_millis(10));
        }
        let live = codexhost_platform::process_identity(child.id()).unwrap();
        let record = ReadyOwner {
            pid: live.id,
            started_at_micros: live.started_at_micros,
            executable: root.join("deleted-package/codexhost"),
            web_pid: live.id,
            web_started_at_micros: 0,
            version: "0.18.0-beta.4".into(),
            runtime: root.join("web-server.mjs"),
            access: WebAccess {
                address: "http://127.0.0.1:4400/".into(),
                login_url: String::new(),
            },
        };
        let file = root.join(super::READY);
        fs::write(&file, serde_json::to_vec(&record).unwrap()).unwrap();
        assert!(super::owner(&root).unwrap().is_some());
        let mut reused = record;
        reused.started_at_micros += 1;
        fs::write(&file, serde_json::to_vec(&reused).unwrap()).unwrap();
        assert!(super::owner(&root).unwrap().is_none());
        reused.started_at_micros -= 1;
        fs::write(&file, serde_json::to_vec(&reused).unwrap()).unwrap();
        let options = Options {
            node: executable.clone(),
            host_node: executable.clone(),
            runtime: executable.clone(),
            host_runtime: executable.clone(),
            data: root.clone(),
            ready: None,
        };
        assert!(super::stop(&options).unwrap());
        assert_eq!(
            fs::read_to_string(root.join("stopped")).unwrap(),
            "done",
            "stop returned before shutdown completed"
        );
    }));
    if result.is_err() {
        let _ = child.kill();
    }
    let status = child.wait().unwrap();
    fs::remove_dir_all(&root).unwrap();
    result.unwrap();
    assert!(status.success());
}
#[cfg(unix)]
#[test]
fn stop_recovers_an_orphaned_web_child_of_a_dead_supervisor() {
    const TEST: &str =
        "web_service::tests::stop_recovers_an_orphaned_web_child_of_a_dead_supervisor";
    if let Some(root) = env::var_os("CODEXHOST_WEB_ORPHAN_TEST") {
        let root = std::path::PathBuf::from(root);
        fs::write(root.join("started"), "ready").unwrap();
        let deadline = Instant::now() + Duration::from_secs(60);
        while Instant::now() < deadline {
            thread::sleep(Duration::from_millis(50));
        }
        return;
    }
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = env::temp_dir().join(format!(
        "codexhost-web-orphan-{}-{nonce}",
        std::process::id()
    ));
    fs::create_dir_all(&root).unwrap();
    let executable = env::current_exe().unwrap();
    // Launch the fixture detached: its shell parent exits immediately, so the
    // fixture is reparented to init like a real orphaned Web child and is
    // reaped when signalled, leaving no zombie to confuse identity checks.
    let spawn_orphan = || -> u32 {
        let script = format!(
            "\"{}\" --exact \"{}\" >/dev/null 2>&1 & echo $!",
            executable.display(),
            TEST
        );
        let output = Command::new("sh")
            .arg("-c")
            .arg(&script)
            .env("CODEXHOST_WEB_ORPHAN_TEST", &root)
            .output()
            .unwrap();
        String::from_utf8_lossy(&output.stdout)
            .trim()
            .parse()
            .expect("fixture pid")
    };
    let wait_started = |deadline: Instant| {
        while !root.join("started").exists() {
            assert!(Instant::now() < deadline, "fixture did not start");
            thread::sleep(Duration::from_millis(10));
        }
    };
    let live = codexhost_platform::process_identity(spawn_orphan()).unwrap();
    wait_started(Instant::now() + Duration::from_secs(10));
    let mut record = ReadyOwner {
        pid: live.id,
        // A started_at that matches no live process models a supervisor that
        // already exited.
        started_at_micros: live.started_at_micros + 1,
        executable: root.join("deleted-package/codexhost"),
        web_pid: live.id,
        web_started_at_micros: live.started_at_micros,
        version: "0.18.0-beta.4".into(),
        runtime: root.join("web-server.mjs"),
        access: WebAccess {
            address: "http://127.0.0.1:4400/".into(),
            login_url: String::new(),
        },
    };
    let file = root.join(super::READY);
    fs::write(&file, serde_json::to_vec(&record).unwrap()).unwrap();
    assert!(super::stop_orphaned_web_service(&root).unwrap());
    assert!(!file.exists(), "the stale record must be removed");
    assert!(
        codexhost_platform::process_identity(record.web_pid).is_err(),
        "the confirmed orphan must be terminated"
    );
    // A legacy record without the web identity must never kill anything.
    let orphan = spawn_orphan();
    wait_started(Instant::now() + Duration::from_secs(10));
    record.web_pid = orphan;
    record.web_started_at_micros = 0;
    fs::write(&file, serde_json::to_vec(&record).unwrap()).unwrap();
    assert!(!super::stop_orphaned_web_service(&root).unwrap());
    assert!(!file.exists(), "the unverifiable record is dropped");
    assert!(
        codexhost_platform::process_identity(orphan).is_ok(),
        "an unverified listener must not be terminated"
    );
    let _ = Command::new("kill").arg(orphan.to_string()).status();
    fs::remove_dir_all(&root).unwrap();
}
