use super::configure_detached_service_command;
use crate::process_snapshot;
use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use std::{env, fs, thread};

#[test]
fn detached_service_releases_callers_capture_pipes() {
    const TEST: &str = "background::service_tests::detached_service_releases_callers_capture_pipes";
    let executable = env::current_exe().unwrap();
    let role = env::var("CODEXHOST_PIPE_TEST_ROLE").unwrap_or_default();
    if !role.is_empty() {
        let root = std::path::PathBuf::from(env::var_os("CODEXHOST_PIPE_TEST_ROOT").unwrap());
        if role == "service" {
            fs::write(root.join("ready"), std::process::id().to_string()).unwrap();
            while !root.join("stop").exists() {
                thread::sleep(Duration::from_millis(20));
            }
            return;
        }
        let mut command = Command::new(&executable);
        command
            .args(["--exact", TEST, "--nocapture"])
            .env("CODEXHOST_PIPE_TEST_ROLE", "service")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        configure_detached_service_command(&mut command).unwrap();
        drop(command.spawn().unwrap());
        let deadline = Instant::now() + Duration::from_secs(10);
        while !root.join("ready").exists() {
            assert!(Instant::now() < deadline, "service did not start");
            thread::sleep(Duration::from_millis(20));
        }
        println!("foreground completed");
        return;
    }
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = env::temp_dir().join(format!("codexhost-pipes-{}-{nonce}", std::process::id()));
    fs::create_dir_all(&root).unwrap();
    let mut caller = Command::new(&executable)
        .args(["--exact", TEST, "--nocapture"])
        .env("CODEXHOST_PIPE_TEST_ROLE", "caller")
        .env("CODEXHOST_PIPE_TEST_ROOT", &root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let (sender, receiver) = mpsc::channel();
    let pipes: [Box<dyn Read + Send>; 2] = [
        Box::new(caller.stdout.take().unwrap()),
        Box::new(caller.stderr.take().unwrap()),
    ];
    let readers: Vec<_> = pipes
        .into_iter()
        .map(|mut pipe| {
            let sender = sender.clone();
            thread::spawn(move || {
                let mut output = String::new();
                pipe.read_to_string(&mut output).unwrap();
                sender.send(output).unwrap();
            })
        })
        .collect();
    assert!(caller.wait().unwrap().success());
    let pid = fs::read_to_string(root.join("ready"))
        .unwrap()
        .parse()
        .unwrap();
    let service = process_snapshot(pid).unwrap();
    let output = receiver.recv_timeout(Duration::from_secs(2));
    let error = receiver.recv_timeout(Duration::from_secs(2));
    let still_running =
        process_snapshot(pid).is_ok_and(|live| live.started_at_micros == service.started_at_micros);
    fs::write(root.join("stop"), "stop").unwrap();
    for reader in readers {
        reader.join().unwrap();
    }
    let deadline = Instant::now() + Duration::from_secs(5);
    while process_snapshot(pid)
        .is_ok_and(|live| live.started_at_micros == service.started_at_micros)
    {
        assert!(Instant::now() < deadline, "service did not stop");
        thread::sleep(Duration::from_millis(20));
    }
    fs::remove_dir_all(root).unwrap();
    assert!(still_running, "detached service should outlive its caller");
    assert!(
        output.is_ok() && error.is_ok(),
        "background service inherited caller capture pipes"
    );
    assert!(format!("{}{}", output.unwrap(), error.unwrap()).contains("foreground completed"));
}
