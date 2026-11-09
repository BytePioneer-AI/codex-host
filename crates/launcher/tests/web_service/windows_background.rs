use super::Fixture;
use codexhost_platform::{configure_background_command, process_snapshot, spawn_supervised};
use std::env;
use std::ffi::c_void;
use std::fs;
use std::io;
use std::os::windows::process::CommandExt;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

#[link(name = "kernel32")]
unsafe extern "system" {
    fn AttachConsole(process_id: u32) -> i32;
    fn FreeConsole() -> i32;
    fn GetConsoleWindow() -> *mut c_void;
    fn GenerateConsoleCtrlEvent(event: u32, process_group_id: u32) -> i32;
    fn SetConsoleCtrlHandler(
        handler: Option<unsafe extern "system" fn(u32) -> i32>,
        add: i32,
    ) -> i32;
}

// Console attachment is process-wide, so probe from an isolated helper rather
// than changing the test runner's console or delivering control events to it.
#[test]
fn console_helper() {
    let Ok(pid) = env::var("CODEXHOST_TEST_CONSOLE_PID") else {
        return;
    };
    unsafe { FreeConsole() };
    let attached = unsafe { AttachConsole(pid.parse().unwrap()) } != 0;
    if !attached {
        assert_eq!(io::Error::last_os_error().raw_os_error(), Some(6));
        std::process::exit(11);
    }
    let window = unsafe { GetConsoleWindow() };
    if env::var_os("CODEXHOST_TEST_SIGNAL_CONSOLE").is_some() {
        unsafe extern "system" fn ignore_event(_event: u32) -> i32 {
            1
        }
        assert!(!window.is_null());
        assert_ne!(unsafe { SetConsoleCtrlHandler(Some(ignore_event), 1) }, 0);
        const CTRL_BREAK_EVENT: u32 = 1;
        assert_ne!(unsafe { GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, 0) }, 0);
    }
    assert_ne!(unsafe { FreeConsole() }, 0);
    std::process::exit(if window.is_null() { 11 } else { 10 });
}

fn console_probe(pid: u32, signal: bool) -> bool {
    let mut command = Command::new(env::current_exe().unwrap());
    command
        .args(["--exact", "windows_background::console_helper"])
        .env("CODEXHOST_TEST_CONSOLE_PID", pid.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit());
    if signal {
        command.env("CODEXHOST_TEST_SIGNAL_CONSOLE", "1");
    }
    configure_background_command(&mut command);
    match command.status().unwrap().code() {
        Some(10) => true,
        Some(11) => false,
        status => panic!("console probe for PID {pid} failed: {status:?}"),
    }
}

#[test]
fn launch_console_events_and_exit_leave_windowless_host_and_web_running() {
    let fixture = Fixture::new();
    let script = fixture.root.join("caller.mjs");
    fs::write(
        &script,
        r#"
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const data = process.env.CODEXHOST_DATA_DIR;
const timer = setInterval(() => {
  if (!fs.existsSync(path.join(data, 'caller-admitted'))) return;
  clearInterval(timer);
  const result = spawnSync(process.argv[2], process.argv.slice(3), {stdio:'pipe'});
  const ready = path.join(data, 'caller-result.json');
  fs.writeFileSync(ready + '.tmp', JSON.stringify({
    status:result.status, error:String(result.error ?? ''), stderr:String(result.stderr)
  }));
  fs.renameSync(ready + '.tmp', ready);
  setInterval(() => {}, 1000);
}, 20);
"#,
    )
    .unwrap();
    let launch = fixture.public_command("web");
    let mut command = Command::new(&fixture.node);
    command.env_clear();
    for (key, value) in launch.get_envs() {
        if let Some(value) = value {
            command.env(key, value);
        }
    }
    command
        .arg(&script)
        .arg(launch.get_program())
        .args(launch.get_args())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
    command.creation_flags(CREATE_NEW_CONSOLE);
    let mut caller = spawn_supervised(&mut command).unwrap();
    fs::write(fixture.root.join("caller-admitted"), "ready").unwrap();
    let deadline = Instant::now() + Duration::from_secs(40);
    while !fixture.root.join("caller-result.json").exists() {
        assert!(caller.try_wait().unwrap().is_none(), "caller exited early");
        assert!(Instant::now() < deadline, "Web startup timed out");
        thread::sleep(Duration::from_millis(25));
    }
    let result = fixture.record("caller-result.json");
    assert_eq!(result["status"], 0, "{result}");
    assert!(console_probe(caller.id(), false), "caller needs a console");
    let host = fixture.record("shared-host-ready.json");
    let web = fixture.record("web-service-ready.json");
    let host_pid = host["pid"].as_u64().unwrap() as u32;
    let identities: Vec<_> = [
        process_snapshot(host_pid).unwrap().parent_id,
        host_pid,
        web["pid"].as_u64().unwrap() as u32,
        web["web_pid"].as_u64().unwrap() as u32,
    ]
    .into_iter()
    .map(|pid| {
        assert!(
            !console_probe(pid, false),
            "background service PID {pid} owns a console window"
        );
        process_snapshot(pid).unwrap()
    })
    .collect();

    // Exercise real console control events without depending on a terminal
    // application's private window implementation (including ConPTY hosts).
    assert!(console_probe(caller.id(), true));
    let deadline = Instant::now() + Duration::from_secs(10);
    while caller.try_wait().unwrap().is_none() {
        assert!(
            Instant::now() < deadline,
            "console event did not stop caller"
        );
        thread::sleep(Duration::from_millis(25));
    }
    // Closing the caller's native Job must not collect either shared service.
    drop(caller);
    thread::sleep(Duration::from_millis(1500));
    for identity in identities {
        let live = process_snapshot(identity.id).expect("service died with the launch console");
        assert_eq!(live.started_at_micros, identity.started_at_micros);
    }
    let reused = fixture.public_command("web").output().unwrap();
    assert!(
        reused.status.success(),
        "{}",
        String::from_utf8_lossy(&reused.stderr)
    );
    assert_eq!(fixture.record("shared-host-ready.json"), host);
    assert_eq!(fixture.record("web-service-ready.json"), web);
    assert_eq!(fixture.starts(), 1, "console exit restarted Web");

    fixture.restart("crash");
    let restarted = fixture.record("web-service-ready.json");
    assert_eq!(restarted["pid"], web["pid"]);
    assert!(!console_probe(
        restarted["web_pid"].as_u64().unwrap() as u32,
        false
    ));
    assert_eq!(fixture.record("shared-host-ready.json"), host);
    let stopped = fixture.public_command("stop").output().unwrap();
    assert!(
        stopped.status.success(),
        "{}",
        String::from_utf8_lossy(&stopped.stderr)
    );
    assert!(!fixture.root.join("shared-host-ready.json").exists());
    assert!(!fixture.root.join("web-service-ready.json").exists());
}
