#![cfg(any(target_os = "macos", target_os = "linux"))]

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use codexhost_platform::{ProcessSnapshot, process_snapshot, terminate_process_instance};

struct Fixture {
    directory: PathBuf,
}

impl Fixture {
    fn new(name: &str) -> Self {
        let directory = std::env::temp_dir().join(format!("ch-fail-{name}-{}", std::process::id()));
        fs::create_dir(&directory).unwrap();
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).unwrap();
        let script = directory.join("codex");
        fs::write(
            &script,
            r#"#!/usr/bin/python3
import os, signal, time
child = os.fork()
if child == 0:
    os.setsid()
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    with open(os.environ['FAILURE_READY'], 'w') as f:
        f.write(str(os.getppid()) + '\n' + str(os.getpid()))
while True:
    time.sleep(1)
"#,
        )
        .unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o700)).unwrap();
        Self { directory }
    }

    fn command(&self) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_codexhost-shim"));
        for (key, _) in std::env::vars_os() {
            if key.to_string_lossy().starts_with("CODEXHOST_") {
                command.env_remove(key);
            }
        }
        command
            .args(["app-server", "--listen", "unix://"])
            .env("CODEXHOST_STOCK_CODEX_PATH", self.directory.join("codex"))
            .env("CODEXHOST_REMOTE_SSH_MANAGED", "1")
            .env("CODEX_HOME", &self.directory)
            .env("FAILURE_READY", self.directory.join("ready"))
            .env_remove("CODEXHOST_LAUNCHER_PID")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        command
    }

    fn descendants(&self) -> Vec<ProcessSnapshot> {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Ok(text) = fs::read_to_string(self.directory.join("ready")) {
                let snapshots: Vec<_> = text
                    .lines()
                    .filter_map(|line| line.parse().ok())
                    .filter_map(|pid| process_snapshot(pid).ok())
                    .collect();
                if snapshots.len() == 2 {
                    return snapshots;
                }
            }
            assert!(Instant::now() < deadline, "fixture did not start");
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        // Also clean up the fixture when a regression leaves its descendants alive.
        if let Ok(text) = fs::read_to_string(self.directory.join("ready")) {
            for pid in text.lines().filter_map(|line| line.parse().ok()) {
                if let Ok(snapshot) = process_snapshot(pid) {
                    let _ = terminate_process_instance(&snapshot, true);
                }
            }
        }
        let _ = fs::remove_dir_all(&self.directory);
    }
}

fn assert_gone(expected: &[ProcessSnapshot]) {
    for expected in expected {
        assert!(
            !process_snapshot(expected.id)
                .is_ok_and(|current| current.started_at_micros == expected.started_at_micros),
            "failed startup left descendant {} alive",
            expected.id,
        );
    }
}

fn failed_start_cleans_descendants(session: &str) {
    let fixture = Fixture::new(session);
    let child = fixture
        .command()
        .env("CODEXHOST_REMOTE_EXECUTION_SESSION", session)
        .spawn()
        .unwrap();
    let descendants = fixture.descendants();
    let output = child.wait_with_output().unwrap();
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(!output.status.success(), "{stderr}");
    assert!(stderr.contains("did not become ready"), "{stderr}");
    assert_gone(&descendants);
}

#[test]
fn failed_ssh_start_cleans_descendants_ignoring_sigterm() {
    failed_start_cleans_descendants("ssh");
}

#[cfg(target_os = "macos")]
#[test]
#[ignore = "requires the current user's logged-in macOS desktop and launchd"]
fn failed_desktop_start_cleans_descendants_ignoring_sigterm() {
    failed_start_cleans_descendants("desktop");
}

#[cfg(target_os = "macos")]
#[test]
#[ignore = "requires the current user's logged-in macOS desktop"]
fn rejected_desktop_handoff_cleans_descendants_ignoring_sigterm() {
    use std::io::{Read, Write};
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::net::UnixListener;

    let fixture = Fixture::new("rejected");
    let socket = fixture.directory.join("ipc");
    let listener = UnixListener::bind(&socket).unwrap();
    fs::set_permissions(&socket, fs::Permissions::from_mode(0o600)).unwrap();
    let helper = Command::new(env!("CARGO_BIN_EXE_codexhost-shim"))
        .arg(codexhost_platform::AQUA_SPAWN_ARGUMENT)
        .arg(&socket)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let (mut stream, _) = listener.accept().unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let mut command = fixture.command();
    command.env("CODEXHOST_REMOTE_LISTENER_CHILD", "1");
    let environment = command
        .get_envs()
        .filter_map(|(key, value)| {
            value.map(|value| format!("[{:?},{:?}]", key.as_bytes(), value.as_bytes()))
        })
        .collect::<Vec<_>>()
        .join(",");
    let request = format!(
        "{{\"program\":{:?},\"arguments\":{:?},\"environment\":[{}],\"directory\":{:?}}}",
        command.get_program().as_bytes(),
        [b"app-server".as_slice(), b"--listen", b"unix://"],
        environment,
        fixture.directory.as_os_str().as_bytes(),
    );
    stream
        .write_all(&(request.len() as u32).to_be_bytes())
        .unwrap();
    stream.write_all(request.as_bytes()).unwrap();
    let mut size = [0; 4];
    stream.read_exact(&mut size).unwrap();
    let size = u32::from_be_bytes(size) as usize;
    assert!(size < 4096);
    let mut reply = vec![0; size];
    stream.read_exact(&mut reply).unwrap();
    assert!(String::from_utf8_lossy(&reply).contains("Started"));
    let descendants = fixture.descendants();
    // Reject the handoff only after the native supervisor has observed the child.
    std::thread::sleep(Duration::from_secs(1));
    drop(stream);
    let output = helper.wait_with_output().unwrap();
    assert!(!output.status.success());
    assert_gone(&descendants);
}
