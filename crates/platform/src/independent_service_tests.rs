use crate::{
    configure_detached_service_command, process_snapshot, register_independent_service,
    spawn_supervised,
};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use std::{env, fs, thread};

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[test]
fn stale_registrations_do_not_hide_a_live_service() {
    const TEST: &str = "independent_service::tests::stale_registrations_do_not_hide_a_live_service";
    if env::var_os("CODEXHOST_STALE_REGISTRY_TEST").is_some() {
        use std::os::unix::fs::PermissionsExt;
        let directory = super::directory().unwrap();
        fs::create_dir_all(&directory).unwrap();
        let live = process_snapshot(std::process::id()).unwrap();
        let mut exited = Command::new("/bin/sleep").arg("0").spawn().unwrap();
        let dead_pid = exited.id();
        exited.wait().unwrap();
        let write = |name: &str, pid, started_at_micros| {
            let file = directory.join(name);
            let record = super::Record {
                pid,
                started_at_micros,
                executable: directory.join("deleted-launcher"),
            };
            fs::write(&file, serde_json::to_vec(&record).unwrap()).unwrap();
            fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
        };
        for index in 0..300 {
            write(&format!("dead-{index}.json"), dead_pid, 1);
        }
        write("reused.json", live.id, live.started_at_micros + 1);
        write("live.json", live.id, live.started_at_micros);
        let mut root = live.clone();
        root.id = u32::MAX;
        let mut owned = live.clone();
        owned.process_group_id = owned.id;
        assert_eq!(super::transferred_processes(&root, &[owned]), [live.id]);
        assert_eq!(fs::read_dir(&directory).unwrap().count(), 1);
        assert!(directory.join("live.json").exists());
        assert!(super::transferred_processes(&root, &[]).is_empty());
        assert!(directory.join("live.json").exists());
        return;
    }
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = env::temp_dir().join(format!("codexhost-registry-{}-{nonce}", std::process::id()));
    fs::create_dir_all(&root).unwrap();
    let output = Command::new(env::current_exe().unwrap())
        .args(["--exact", TEST])
        .env("CODEXHOST_STALE_REGISTRY_TEST", "1")
        .env("HOME", &root)
        .output()
        .unwrap();
    fs::remove_dir_all(root).unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn service_survives_supervised_parent_cleanup() {
    const TEST: &str = "independent_service::tests::service_survives_supervised_parent_cleanup";
    let executable = env::current_exe().unwrap();
    let role = env::var("CODEXHOST_INDEPENDENT_TEST_ROLE").unwrap_or_default();
    let root = env::var_os("CODEXHOST_INDEPENDENT_TEST_ROOT").map(std::path::PathBuf::from);
    if role == "service" {
        let root = root.unwrap();
        let _registration = register_independent_service().unwrap();
        fs::write(root.join("ready"), std::process::id().to_string()).unwrap();
        while !root.join("stop").exists() {
            thread::sleep(Duration::from_millis(20));
        }
        return;
    }
    if role == "foreground" {
        let mut command = Command::new(&executable);
        command
            .args(["--exact", TEST])
            .env("CODEXHOST_INDEPENDENT_TEST_ROLE", "service")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        configure_detached_service_command(&mut command).unwrap();
        let mut service = command.spawn().unwrap();
        // The outer fixture kills this foreground while it waits, proving that
        // its cleanup does not own the detached service's lifetime.
        service.wait().unwrap();
        return;
    }
    if role == "outer" {
        let root = root.unwrap();
        let mut command = Command::new(&executable);
        command
            .args(["--exact", TEST])
            .env("CODEXHOST_INDEPENDENT_TEST_ROLE", "foreground")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let mut foreground = spawn_supervised(&mut command).unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        while !root.join("ready").exists() {
            assert!(Instant::now() < deadline, "service did not start");
            thread::sleep(Duration::from_millis(20));
        }
        let pid = fs::read_to_string(root.join("ready"))
            .unwrap()
            .parse()
            .unwrap();
        let service = process_snapshot(pid).unwrap();
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            foreground.has_live_processes().unwrap();
            foreground.terminate().unwrap();
            foreground
                .wait_for_tree_exit(Duration::from_secs(5))
                .unwrap();
            assert_eq!(
                process_snapshot(pid).unwrap().started_at_micros,
                service.started_at_micros
            );
        }));
        fs::write(root.join("stop"), "stop").unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while process_snapshot(pid)
            .is_ok_and(|live| live.started_at_micros == service.started_at_micros)
        {
            assert!(Instant::now() < deadline, "service did not stop");
            thread::sleep(Duration::from_millis(20));
        }
        result.unwrap();
        return;
    }
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = env::temp_dir().join(format!(
        "codexhost-independent-{}-{nonce}",
        std::process::id()
    ));
    fs::create_dir_all(&root).unwrap();
    let output = Command::new(&executable)
        .args(["--exact", TEST, "--nocapture"])
        .env("CODEXHOST_INDEPENDENT_TEST_ROLE", "outer")
        .env("CODEXHOST_INDEPENDENT_TEST_ROOT", &root)
        .env("CODEXHOST_LAUNCHER_EXECUTABLE", &executable)
        .env("HOME", &root)
        .env("USERPROFILE", &root)
        .output()
        .unwrap();
    fs::remove_dir_all(&root).unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}
