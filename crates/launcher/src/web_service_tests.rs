use super::{Options, ReadyOwner, WebAccess};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use std::{env, fs, thread};

#[test]
fn stop_waits_for_the_recorded_instance_without_its_original_image() {
    const TEST: &str =
        "web_service::tests::stop_waits_for_the_recorded_instance_without_its_original_image";
    if let Some(root) = env::var_os("CODEXHOST_WEB_STOP_TEST") {
        let root = std::path::PathBuf::from(root);
        fs::write(root.join("started"), "ready").unwrap();
        let deadline = Instant::now() + super::STOP_WAIT;
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
    let pid = child.id();
    // A reaper thread waits on the fixture concurrently so it is reaped the
    // moment it exits; on macOS an unreaped zombie still shows up in process
    // queries with its original identity, which would make stop() wait out
    // its whole timeout instead of observing the shutdown.
    let exited: Arc<Mutex<Option<std::process::ExitStatus>>> = Arc::new(Mutex::new(None));
    let reaper = {
        let exited = exited.clone();
        thread::spawn(move || {
            let status = child.wait();
            *exited.lock().unwrap() = status.ok();
        })
    };
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let deadline = Instant::now() + super::STOP_WAIT;
        while !root.join("started").exists() {
            assert!(Instant::now() < deadline, "fixture did not start");
            thread::sleep(Duration::from_millis(10));
        }
        let live = codexhost_platform::process_identity(pid).unwrap();
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
        assert!(super::stop(&options, None).unwrap());
        assert_eq!(
            fs::read_to_string(root.join("stopped")).unwrap(),
            "done",
            "stop returned before shutdown completed"
        );
    }));
    // Wait for the reaper to observe the fixture's exit (bounded, so a
    // failing run cannot hang forever); then report its status.
    let status = {
        let deadline = Instant::now() + super::STOP_WAIT;
        loop {
            if let Some(status) = exited.lock().unwrap().take() {
                break status;
            }
            assert!(Instant::now() < deadline, "fixture did not exit after stop");
            thread::sleep(Duration::from_millis(10));
        }
    };
    let _ = reaper.join();
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
    // Launch the fixture directly (never by interpolating its path into a
    // shell script) in a new session, so it becomes its own process-group
    // leader exactly like the supervised Web child in production. A reaper
    // thread waits on it concurrently, so it is reaped as soon as it is
    // signalled and leaves no zombie to confuse identity checks.
    let spawn_orphan = || -> u32 {
        let mut command = Command::new(&executable);
        command
            .args(["--exact", TEST])
            .env("CODEXHOST_WEB_ORPHAN_TEST", &root)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        codexhost_platform::configure_detached_service_command(&mut command).unwrap();
        let mut child = command.spawn().unwrap();
        let pid = child.id();
        thread::spawn(move || child.wait());
        pid
    };
    let wait_started = |deadline: Instant| {
        while !root.join("started").exists() {
            assert!(Instant::now() < deadline, "fixture did not start");
            thread::sleep(Duration::from_millis(10));
        }
    };
    let live = codexhost_platform::process_snapshot(spawn_orphan()).unwrap();
    wait_started(Instant::now() + super::STOP_WAIT);
    assert_eq!(
        live.process_group_id, live.id,
        "the fixture must lead its own process group"
    );
    let live = codexhost_platform::process_snapshot(live.id).unwrap();
    assert_eq!(
        live.process_group_id, live.id,
        "the fixture must lead its own process group"
    );
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
    assert!(super::stop_orphaned_web_service(&root, None).unwrap());
    assert!(!file.exists(), "the stale record must be removed");
    assert!(
        codexhost_platform::process_identity(record.web_pid).is_err(),
        "the confirmed orphan must be terminated"
    );
    // A legacy record without the web identity must never kill anything.
    // The first fixture's marker must not satisfy the second launch's wait,
    // so it is removed before the new fixture starts.
    fs::remove_file(root.join("started")).unwrap();
    let orphan = spawn_orphan();
    wait_started(Instant::now() + super::STOP_WAIT);
    record.web_pid = orphan;
    record.web_started_at_micros = 0;
    fs::write(&file, serde_json::to_vec(&record).unwrap()).unwrap();
    assert!(!super::stop_orphaned_web_service(&root, None).unwrap());
    assert!(!file.exists(), "the unverifiable record is dropped");
    assert!(
        codexhost_platform::process_identity(orphan).is_ok(),
        "an unverified listener must not be terminated"
    );
    let _ = Command::new("kill").arg(orphan.to_string()).status();
    fs::remove_dir_all(&root).unwrap();
}

#[cfg(unix)]
#[test]
fn orphan_cleanup_scopes_runtime_ownership_and_frees_the_port() {
    const TEST: &str =
        "web_service::tests::orphan_cleanup_scopes_runtime_ownership_and_frees_the_port";
    // The fixture plays the orphaned Web child: it binds a real ephemeral
    // port, publishes it, and stays alive until it is signalled.
    if let Some(root) = env::var_os("CODEXHOST_WEB_PORT_TEST") {
        let root = std::path::PathBuf::from(root);
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        fs::write(
            root.join("port"),
            listener.local_addr().unwrap().port().to_string(),
        )
        .unwrap();
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
    let root = env::temp_dir().join(format!("codexhost-web-port-{}-{nonce}", std::process::id()));
    fs::create_dir_all(&root).unwrap();
    let executable = env::current_exe().unwrap();
    let spawn_orphan = || -> (u32, u16) {
        let mut command = Command::new(&executable);
        command
            .args(["--exact", TEST])
            .env("CODEXHOST_WEB_PORT_TEST", &root)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        codexhost_platform::configure_detached_service_command(&mut command).unwrap();
        let mut child = command.spawn().unwrap();
        let pid = child.id();
        thread::spawn(move || child.wait());
        let deadline = Instant::now() + super::STOP_WAIT;
        while !root.join("port").exists() {
            assert!(Instant::now() < deadline, "fixture did not publish a port");
            thread::sleep(Duration::from_millis(10));
        }
        let port: u16 = fs::read_to_string(root.join("port"))
            .unwrap()
            .parse()
            .unwrap();
        (pid, port)
    };
    let record_for = |pid: u32, started_at_micros: u64, runtime: std::path::PathBuf| ReadyOwner {
        pid,
        // Matches no live process: models an already-exited supervisor.
        started_at_micros: started_at_micros + 1,
        executable: root.join("deleted-package/codexhost"),
        web_pid: pid,
        web_started_at_micros: started_at_micros,
        version: "0.23.0".into(),
        runtime,
        access: WebAccess {
            address: "http://127.0.0.1:4400/".into(),
            login_url: String::new(),
        },
    };
    let file = root.join(super::READY);

    // Unprovable ownership: neither the recorded nor the expected runtime can
    // be canonicalized, so cleanup must fail with the record kept.
    let (orphan, _port) = spawn_orphan();
    let started = codexhost_platform::process_identity(orphan)
        .unwrap()
        .started_at_micros;
    let record = record_for(
        orphan,
        started,
        root.join("missing-install-a/web-server.mjs"),
    );
    fs::write(&file, serde_json::to_vec(&record).unwrap()).unwrap();
    let expected = root.join("missing-install-b/web-server.mjs");
    assert!(
        super::stop_orphaned_web_service(&root, Some(&expected)).is_err(),
        "double missing runtime must be rejected, not matched"
    );
    assert!(file.exists(), "the record must be kept for retry");
    assert!(
        codexhost_platform::process_identity(orphan).is_ok(),
        "an orphan of unprovable ownership must not be terminated"
    );

    // A provably foreign installation: cleanup skips it and keeps the record.
    fs::create_dir_all(root.join("other-install")).unwrap();
    fs::write(root.join("other-install/web-server.mjs"), "").unwrap();
    let record = record_for(orphan, started, root.join("other-install/web-server.mjs"));
    fs::write(&file, serde_json::to_vec(&record).unwrap()).unwrap();
    let expected = root.join("this-install/web-server.mjs");
    fs::create_dir_all(root.join("this-install")).unwrap();
    fs::write(&expected, "").unwrap();
    assert!(!super::stop_orphaned_web_service(&root, Some(&expected)).unwrap());
    assert!(file.exists(), "another installation's orphan is left alone");
    assert!(
        codexhost_platform::process_identity(orphan).is_ok(),
        "a foreign installation's orphan must not be terminated"
    );

    // Same installation without an expected runtime (normal startup): the
    // orphan is terminated and its port becomes bindable again.
    let port = fs::read_to_string(root.join("port"))
        .unwrap()
        .parse()
        .unwrap();
    let record = record_for(
        orphan,
        started,
        root.join("missing-install-a/web-server.mjs"),
    );
    fs::write(&file, serde_json::to_vec(&record).unwrap()).unwrap();
    assert!(super::stop_orphaned_web_service(&root, None).unwrap());
    assert!(!file.exists(), "the stale record must be removed");
    assert!(
        codexhost_platform::process_identity(orphan).is_err(),
        "the confirmed orphan must be terminated"
    );
    let deadline = Instant::now() + super::STOP_WAIT;
    let rebound = loop {
        match std::net::TcpListener::bind(("127.0.0.1", port)) {
            Ok(listener) => break listener,
            Err(error) => {
                assert!(
                    Instant::now() < deadline,
                    "port {port} never rebindable: {error}"
                );
                thread::sleep(Duration::from_millis(50));
            }
        }
    };
    drop(rebound);
    fs::remove_dir_all(&root).unwrap();
}

#[cfg(unix)]
#[test]
fn update_recovery_reclaim_spares_foreign_orphans_and_same_group_neighbors() {
    const TEST: &str = "web_service::tests::update_recovery_reclaim_spares_foreign_orphans_and_same_group_neighbors";
    // The fixture plays the orphaned Web child of an update's stop phase: it
    // leads its own process group, spawns a plain child that shares that
    // group (an unrelated process the old group-wide reclaim would have
    // killed), and stays alive until it is signalled.
    if let Some(root) = env::var_os("CODEXHOST_WEB_GROUP_TEST") {
        let root = std::path::PathBuf::from(root);
        let mut neighbor = Command::new("sleep")
            .arg("120")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        fs::write(root.join("neighbor"), neighbor.id().to_string()).unwrap();
        fs::write(root.join("started"), "ready").unwrap();
        let deadline = Instant::now() + Duration::from_secs(60);
        while Instant::now() < deadline {
            thread::sleep(Duration::from_millis(50));
        }
        // Reap the neighbor before the fixture exits so the `sleep` child
        // never lingers as a zombie of this process.
        let _ = neighbor.wait();
        return;
    }
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = env::temp_dir().join(format!(
        "codexhost-web-group-{}-{nonce}",
        std::process::id()
    ));
    fs::create_dir_all(&root).unwrap();
    let executable = env::current_exe().unwrap();
    let mut command = Command::new(&executable);
    command
        .args(["--exact", TEST])
        .env("CODEXHOST_WEB_GROUP_TEST", &root)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    codexhost_platform::configure_detached_service_command(&mut command).unwrap();
    let mut child = command.spawn().unwrap();
    let orphan = child.id();
    thread::spawn(move || child.wait());
    let deadline = Instant::now() + super::STOP_WAIT;
    while !root.join("started").exists() {
        assert!(Instant::now() < deadline, "fixture did not start");
        thread::sleep(Duration::from_millis(10));
    }
    let neighbor: u32 = fs::read_to_string(root.join("neighbor"))
        .unwrap()
        .parse()
        .unwrap();
    let orphan_started = codexhost_platform::process_identity(orphan)
        .unwrap()
        .started_at_micros;
    let neighbor_identity = codexhost_platform::process_snapshot(neighbor).unwrap();
    assert_eq!(
        neighbor_identity.process_group_id, orphan,
        "the neighbor must share the orphan's process group"
    );
    fs::create_dir_all(root.join("other-install")).unwrap();
    fs::write(root.join("other-install/web-server.mjs"), "").unwrap();
    fs::create_dir_all(root.join("this-install")).unwrap();
    let this_install = root.join("this-install/web-server.mjs");
    fs::write(&this_install, "").unwrap();
    let file = root.join(super::READY);
    let record_for = |runtime: std::path::PathBuf| ReadyOwner {
        pid: orphan,
        // Matches no live process: models a supervisor that already exited.
        started_at_micros: orphan_started + 1,
        executable: root.join("deleted-package/codexhost"),
        web_pid: orphan,
        web_started_at_micros: orphan_started,
        version: "0.23.0".into(),
        runtime,
        access: WebAccess {
            address: "http://127.0.0.1:4400/".into(),
            login_url: String::new(),
        },
    };

    // Recovery entry (--update-recovery) passes the expected runtime: a
    // foreign installation's orphan sharing this data directory is left
    // alone, with its record kept for that installation's own recovery.
    let record = record_for(root.join("other-install/web-server.mjs"));
    fs::write(&file, serde_json::to_vec(&record).unwrap()).unwrap();
    assert!(!super::stop_orphaned_web_service(&root, Some(&this_install)).unwrap());
    assert!(file.exists(), "the foreign orphan's record must be kept");
    assert!(
        codexhost_platform::process_identity(orphan).is_ok(),
        "a foreign installation's orphan must survive recovery"
    );
    assert!(
        codexhost_platform::process_identity(neighbor).is_ok(),
        "the same-group neighbor must survive a skipped reclaim"
    );

    // The orphan provably belongs to this installation: only the verified
    // Web identity is terminated; its same-group neighbor survives.
    let record = record_for(this_install.clone());
    fs::write(&file, serde_json::to_vec(&record).unwrap()).unwrap();
    assert!(super::stop_orphaned_web_service(&root, Some(&this_install)).unwrap());
    assert!(!file.exists(), "the reclaimed record must be removed");
    assert!(
        codexhost_platform::process_identity(orphan).is_err(),
        "the confirmed orphan must be terminated"
    );
    assert!(
        codexhost_platform::process_identity(neighbor).is_ok(),
        "a same-PGID unrelated process must not be terminated"
    );
    let _ = Command::new("kill").arg(neighbor.to_string()).status();
    fs::remove_dir_all(&root).unwrap();
}
