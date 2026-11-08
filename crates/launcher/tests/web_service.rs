#[cfg(windows)]
#[path = "support/windows_service.rs"]
mod windows_service;

use std::env;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Output, Stdio};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[cfg(windows)]
#[path = "web_service/windows_background.rs"]
mod windows_background;

struct Fixture {
    root: PathBuf,
    node: String,
    console: Child,
    console_port: String,
}

impl Fixture {
    fn new() -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = env::temp_dir().join(format!(
            "web-service-{}-{:?}-{nonce}",
            std::process::id(),
            thread::current().id()
        ));
        fs::create_dir(&root).unwrap();
        let node = Command::new("node")
            .args(["-p", "process.execPath"])
            .output()
            .unwrap();
        assert!(node.status.success());
        let node = String::from_utf8(node.stdout).unwrap().trim().to_owned();
        fs::write(
            root.join("host-runtime.mjs"),
            r#"
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
const value = key => args[args.indexOf(key) + 1];
const remote = args.includes('--codexhost-remote');
const data = remote ? process.env.HOME : value('--data');
const log = text => fs.appendFileSync(path.join(data, 'events'), text + '\n');
if (!remote && !args.includes('--stop')) fs.writeFileSync(path.join(data, 'update-environment.json'), JSON.stringify(Object.fromEntries(['CODEXHOST_LAUNCHER_PID', 'CODEXHOST_LAUNCHER_EXECUTABLE', 'CODEXHOST_RUNTIME_DESCRIPTOR_PATH', 'CODEXHOST_UPDATE_SERVICE', 'CODEXHOST_NPM_NODE_PATH'].map(key => [key, process.env[key]]))));
if (remote) {
  log('remote-stop');
  if (fs.existsSync(path.join(data, 'remote-fail'))) process.exit(1);
  const changed = !fs.existsSync(path.join(data, 'remote-stopped'));
  fs.writeFileSync(path.join(data, 'remote-stopped'), 'stopped');
  console.log(JSON.stringify({changed}));
  process.exit(0);
}
const stop = path.join(data, 'host.stop');
if (args.includes('--stop')) {
  if (fs.existsSync(path.join(data, 'host-stop-fail'))) process.exit(1);
  log('host-stop');
  console.log('Shared Host stopped; interrupted 2 running task(s)');
  fs.writeFileSync(stop, 'stop');
} else {
  log('host-start');
  fs.rmSync(stop, {force:true});
  fs.writeFileSync(value('--ready-file') + '.tmp', 'ready\n');
  fs.renameSync(value('--ready-file') + '.tmp', value('--ready-file'));
  setInterval(() => { if (fs.existsSync(stop)) process.exit(0); }, 25);
}
"#,
        )
        .unwrap();
        fs::write(root.join("web.mjs"), r#"
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
const value = key => args[args.indexOf(key) + 1];
const data = value('--ch-data');
const settingsFile = path.join(data, 'web/service.json');
const settings = fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile)) : {port:4501};
if (args.includes('--save-service-options')) {
  const before = JSON.stringify(settings);
  if (args.includes('--port')) {
    const port = Number(value('--port'));
    if (!Number.isInteger(port) || port < 1 || port > 65535) { console.error('Invalid --port'); process.exit(1); }
    settings.port = port;
  }
  if (before === JSON.stringify(settings)) process.exit(0);
  fs.mkdirSync(path.dirname(settingsFile), {recursive:true});
  fs.writeFileSync(settingsFile, JSON.stringify(settings));
  process.exit(42);
}
const log = text => fs.appendFileSync(path.join(data, 'events'), text + '\n');
log('web-start');
fs.writeFileSync(path.join(data, 'npm-entrypoint.json'), JSON.stringify({node: process.env.CODEXHOST_NPM_NODE_PATH, wrapper: process.env.CODEXHOST_NPM_LAUNCHER_PATH}));
fs.appendFileSync(path.join(data, 'starts'), 'start\n');
if (fs.existsSync(path.join(data, 'fail'))) {
  console.error('first diagnostic' + 'x'.repeat(16384) + 'fixture port is occupied; use --port');
  process.exit(1);
}
const ready = value('--ready-file');
const address = `http://127.0.0.1:${settings.port}/`;
if (value('--ch-node') !== process.execPath) throw new Error('wrong Host Node');
if (value('--ch-plugins') !== path.join(path.dirname(value('--ch-host-runtime')), 'plugins')) throw new Error('wrong plugins');
fs.writeFileSync(ready + '.tmp', JSON.stringify({address, loginUrl:address + '?token=fixture-secret'}), {mode:0o600});
fs.renameSync(ready + '.tmp', ready);
process.on('SIGTERM', () => { log('web-stop'); process.exit(0); });
setInterval(() => {
  for (const [file, code] of [['crash',7], ['settings-changed',42]]) {
    const signal = path.join(data, file);
    if (fs.existsSync(signal)) { fs.unlinkSync(signal); process.exit(code); }
  }
}, 25);
"#).unwrap();
        fs::write(root.join("console-server.mjs"), r#"
import fs from 'node:fs';
if (process.argv[2] === 'stop') {
  if (fs.existsSync(process.env.HOME + '/console-stopped')) process.exitCode = 3;
  else await fetch(`http://127.0.0.1:${process.env.CODEXHOST_CONSOLE_PORT}/api/shutdown`, {method:'POST',headers:{'x-codexhost-console':'1'}});
} else {
  fs.writeFileSync(process.env.HOME + '/console-calls', process.argv.slice(2).join(' '));
  console.log('codexhost console: http://127.0.0.1:' + process.env.CODEXHOST_CONSOLE_PORT + '/');
}
"#).unwrap();
        fs::write(root.join("console-fixture.mjs"), r#"
import fs from 'node:fs';
import http from 'node:http';
const server = http.createServer((request, response) => {
  response.setHeader('content-type', 'application/json');
  if (request.url === '/api/health') response.end(JSON.stringify({service:'codexhost-console',pid:process.pid,appDirectory:process.env.HOME}));
  else if (request.method === 'POST' && request.url === '/api/shutdown' && request.headers['x-codexhost-console'] === '1') {
    fs.appendFileSync(process.env.HOME + '/events', 'console-stop\n');
    fs.writeFileSync(process.env.HOME + '/console-stopped', 'stopped');
    response.end('{}');
    server.close(() => process.exit(0));
  } else { response.writeHead(404).end('{}'); }
});
process.stdin.on('data', () => server.close(() => process.exit(0)));
server.listen(0, '127.0.0.1', () => console.log(server.address().port));
"#).unwrap();
        let mut command = Command::new(&node);
        command
            .env_clear()
            .env("HOME", &root)
            .env("USERPROFILE", &root)
            .arg(root.join("console-fixture.mjs"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
        #[cfg(windows)]
        command.env("SystemRoot", env::var_os("SystemRoot").unwrap());
        let mut console = command.spawn().unwrap();
        let mut port = String::new();
        BufReader::new(console.stdout.take().unwrap())
            .read_line(&mut port)
            .unwrap();
        let console_port = port.trim().to_owned();
        assert!(!["4400", "4399", ""].contains(&console_port.as_str()));
        Self {
            root,
            node,
            console,
            console_port,
        }
    }

    fn command(&self, service: &str, action: &str) -> Command {
        let mut command = self.public_command(service);
        command
            .arg(action)
            .arg("--node")
            .arg(&self.node)
            .arg("--host-runtime")
            .arg(self.root.join("host-runtime.mjs"))
            .arg("--data")
            .arg(&self.root);
        if service == "web-service" {
            command
                .arg("--web-runtime")
                .arg(self.root.join("web.mjs"))
                .arg("--host-node")
                .arg(&self.node);
        }
        command
    }

    fn public_command(&self, action: &str) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_codexhost"));
        command
            .env_clear()
            .env("PATH", env::var_os("PATH").unwrap())
            .env("HOME", &self.root)
            .env("USERPROFILE", &self.root)
            .env("LOCALAPPDATA", &self.root)
            .env("XDG_RUNTIME_DIR", &self.root)
            .env("CODEX_HOME", self.root.join("codex"))
            .env("CODEXHOST_DATA_DIR", &self.root)
            .env("CODEXHOST_INSTALL_ROOT", self.root.join("missing-desktop"))
            .env("CODEXHOST_CONSOLE_PORT", &self.console_port)
            .env("CODEXHOST_CONSOLE", "0")
            .env("CODEXHOST_WEB_SERVICE", "0")
            .env("SSH_CONNECTION", "fixture")
            .arg(action);
        #[cfg(windows)]
        command.env("SystemRoot", env::var_os("SystemRoot").unwrap());
        if !["status", "host", "web-service", "autostart"].contains(&action) {
            command
                .arg("--node")
                .arg(&self.node)
                .arg("--host-runtime")
                .arg(self.root.join("host-runtime.mjs"));
            if action != "host" {
                command.arg("--web-runtime").arg(self.root.join("web.mjs"));
            }
        }
        command
    }

    fn run(&self, action: &str) -> Output {
        self.command("web-service", action).output().unwrap()
    }

    fn starts(&self) -> usize {
        fs::read_to_string(self.root.join("starts"))
            .unwrap()
            .lines()
            .count()
    }

    fn record(&self, file: &str) -> serde_json::Value {
        serde_json::from_slice(&fs::read(self.root.join(file)).unwrap()).unwrap()
    }

    fn restart(&self, signal: &str) -> Duration {
        let initial = fs::read(self.root.join("web-service-ready.json")).unwrap();
        let started = Instant::now();
        fs::write(self.root.join(signal), signal).unwrap();
        while fs::read(self.root.join("web-service-ready.json")).unwrap() == initial {
            assert!(
                started.elapsed() < Duration::from_secs(10),
                "Web did not restart"
            );
            thread::sleep(Duration::from_millis(25));
        }
        started.elapsed()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self.command("web-service", "stop").output();
        let _ = fs::remove_file(self.root.join("host-stop-fail"));
        let _ = self.command("host", "stop").output();
        let _ = self.console.stdin.take().unwrap().write_all(b"stop\n");
        let _ = self.console.wait();
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[cfg(target_os = "macos")]
#[test]
fn background_web_records_ensure_failure_but_interactive_web_does_not() {
    let fixture = Fixture::new();
    fs::remove_file(fixture.root.join("host-runtime.mjs")).unwrap();
    let failure = fixture.root.join("web-service-failure.txt");
    let interactive = fixture
        .public_command("web")
        .args(["--port", "4472"])
        .output()
        .unwrap();
    assert!(!interactive.status.success());
    assert!(!failure.exists());
    let background = fixture
        .public_command("web")
        .arg("--background")
        .output()
        .unwrap();
    assert!(!background.status.success());
    assert!(background.stdout.is_empty());
    let reason = fs::read_to_string(&failure).unwrap();
    assert!(reason.contains("Host runtime or Node executable is missing"));
    let status = fixture.public_command("status").output().unwrap();
    assert!(status.status.success());
    assert!(
        String::from_utf8_lossy(&status.stdout).contains(&format!("Web last failure: {reason}"))
    );
    assert!(!fixture.root.join("starts").exists());
    assert!(!fixture.root.join("console-calls").exists());
}

#[cfg(target_os = "macos")]
#[test]
fn background_web_refreshes_only_enabled_autostart_without_printing_login_link() {
    let fixture = Fixture::new();
    let path = fixture
        .root
        .join("Library/LaunchAgents/ai.bytepioneer.codexhost.autostart.plist");
    let output = fixture
        .public_command("web")
        .args(["--background", "--port", "4472"])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stdout.is_empty());
    assert!(!path.exists());
    assert!(!fixture.root.join("console-calls").exists());
    assert!(
        fixture
            .public_command("autostart")
            .arg("on")
            .output()
            .unwrap()
            .status
            .success()
    );
    let initial = fs::read_to_string(&path).unwrap();
    let wrapper = fixture.root.join("npm-wrapper.js");
    fs::write(&wrapper, "fixture").unwrap();
    assert!(fixture.run("stop").status.success());
    let output = fixture
        .public_command("web")
        .arg("--background")
        .env("CODEXHOST_NPM_NODE_PATH", &fixture.node)
        .env("CODEXHOST_NPM_LAUNCHER_PATH", &wrapper)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stdout.is_empty());
    let refreshed = fs::read_to_string(&path).unwrap();
    assert_ne!(refreshed, initial);
    assert!(refreshed.contains(wrapper.to_str().unwrap()));
    let entrypoint = fixture.record("npm-entrypoint.json");
    assert_eq!(entrypoint["node"], fixture.node);
    assert_eq!(entrypoint["wrapper"], wrapper.to_str().unwrap());
    // A source build keeps the installed entry.
    assert!(
        fixture
            .public_command("web")
            .arg("--background")
            .output()
            .unwrap()
            .status
            .success()
    );
    assert_eq!(fs::read_to_string(&path).unwrap(), refreshed);
    fs::remove_file(&wrapper).unwrap();
    let status = fixture.public_command("status").output().unwrap();
    assert!(String::from_utf8_lossy(&status.stdout).contains("Autostart: invalid "));
    assert_eq!(fs::read_to_string(&path).unwrap(), refreshed);
    // Missing npm entrypoint makes refresh fail, but must not prevent Web reuse.
    let output = fixture
        .public_command("web")
        .arg("--background")
        .env("CODEXHOST_NPM_NODE_PATH", &fixture.node)
        .env("CODEXHOST_NPM_LAUNCHER_PATH", &wrapper)
        .output()
        .unwrap();
    assert!(output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("could not refresh autostart"));
    assert!(output.stdout.is_empty());
    assert_eq!(fs::read_to_string(&path).unwrap(), refreshed);
    let output = fixture.public_command("stop").output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        fs::read_to_string(&path).unwrap(),
        refreshed,
        "stop leaves autostart unchanged"
    );
}

#[test]
fn update_stop_leaves_console_and_remote_untouched() {
    #[cfg(windows)]
    if windows_service::run_in_service_job() {
        return;
    }
    let mut fixture = Fixture::new();
    assert!(fixture.run("ensure").status.success());
    fs::create_dir_all(fixture.root.join(".codexhost/remote")).unwrap();
    fs::write(fixture.root.join(".codexhost/remote/manifest.json"), "{}").unwrap();
    let output = fixture.public_command("stop-for-update").output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("interrupted 2 running task(s)"));
    assert!(!fixture.root.join("web-service-ready.json").exists());
    assert!(!fixture.root.join("shared-host-ready.json").exists());
    let events = fs::read_to_string(fixture.root.join("events")).unwrap();
    assert!(!events.contains("remote-stop"));
    assert!(!events.contains("console-stop"));
    assert!(fixture.console.try_wait().unwrap().is_none());
    assert!(
        fixture
            .public_command("stop-for-update")
            .output()
            .unwrap()
            .status
            .success()
    );
}

#[test]
fn supervises_only_ready_web_and_serializes_ensure_and_stop() {
    #[cfg(windows)]
    if windows_service::run_in_service_job() {
        return;
    }
    let fixture = Fixture::new();
    let mut first = fixture.command("web-service", "ensure").spawn().unwrap();
    let second = fixture.run("ensure");
    assert!(first.wait().unwrap().success());
    assert!(
        second.status.success(),
        "{}",
        String::from_utf8_lossy(&second.stderr)
    );
    assert_eq!(fixture.starts(), 1);
    fixture.restart("crash");
    assert!(fixture.restart("settings-changed") < Duration::from_secs(2));
    let delay = fixture.restart("crash");
    assert!(
        delay >= Duration::from_secs(2) && delay < Duration::from_secs(4),
        "{delay:?}"
    );
    assert_eq!(fixture.starts(), 4);
    assert!(fixture.run("stop").status.success());
    assert!(!fixture.root.join("web-service-ready.json").exists());
    thread::sleep(Duration::from_millis(1200));
    assert_eq!(fixture.starts(), 4);
    fs::write(fixture.root.join("fail"), "fail").unwrap();
    assert!(!fixture.run("ensure").status.success());
    let failure = fs::read_to_string(fixture.root.join("web-service-failure.txt")).unwrap();
    assert!(failure.contains("fixture port is occupied"));
    assert!(!failure.contains("first diagnostic"));
    thread::sleep(Duration::from_millis(1200));
    assert_eq!(fixture.starts(), 5);
    assert!(!fixture.root.join("web-service-ready.json").exists());
    fs::remove_file(fixture.root.join("fail")).unwrap();
    assert!(fixture.run("ensure").status.success());
    assert!(!fixture.root.join("web-service-failure.txt").exists());
}

#[test]
fn connect_devices_flag_keeps_printed_login_and_ready_record_unchanged() {
    #[cfg(windows)]
    if windows_service::run_in_service_job() {
        return;
    }
    let fixture = Fixture::new();
    let plain = fixture
        .public_command("web")
        .args(["--port", "4478"])
        .output()
        .unwrap();
    assert!(
        plain.status.success(),
        "{}",
        String::from_utf8_lossy(&plain.stderr)
    );
    assert_eq!(
        String::from_utf8_lossy(&plain.stdout),
        "codexhost web: http://127.0.0.1:4478/?token=fixture-secret\nWeb is running in the background; use `codexhost stop` to stop it\n"
    );
    let ready = fs::read(fixture.root.join("web-service-ready.json")).unwrap();
    let settings = fs::read(fixture.root.join("web/service.json")).unwrap();
    let connected = fixture
        .public_command("web")
        .arg("--connect-devices")
        .output()
        .unwrap();
    assert!(
        connected.status.success(),
        "{}",
        String::from_utf8_lossy(&connected.stderr)
    );
    assert_eq!(connected.stdout, plain.stdout);
    assert_eq!(
        fs::read(fixture.root.join("web-service-ready.json")).unwrap(),
        ready
    );
    assert_eq!(
        fs::read(fixture.root.join("web/service.json")).unwrap(),
        settings
    );
    assert_eq!(fixture.starts(), 1);
}

#[test]
fn headless_web_saves_options_and_replaces_mismatched_services_without_exposing_tokens_in_status() {
    #[cfg(windows)]
    if windows_service::run_in_service_job() {
        return;
    }
    let fixture = Fixture::new();
    let result = fixture
        .public_command("web")
        .args(["--port", "4502"])
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert!(
        String::from_utf8_lossy(&result.stdout)
            .contains("http://127.0.0.1:4502/?token=fixture-secret")
    );
    assert!(String::from_utf8_lossy(&result.stdout).contains("codexhost stop"));
    let host = fixture.record("shared-host-ready.json");
    let web = fixture.record("web-service-ready.json");
    assert_eq!(web["version"], env!("CARGO_PKG_VERSION"));
    assert!(
        fixture
            .public_command("web")
            .args(["--port", "4502"])
            .output()
            .unwrap()
            .status
            .success()
    );
    assert_eq!(fixture.record("web-service-ready.json"), web);
    assert!(
        fixture
            .public_command("web")
            .args(["--port", "4503"])
            .output()
            .unwrap()
            .status
            .success()
    );
    assert_eq!(fixture.record("shared-host-ready.json"), host);
    assert_ne!(
        fixture.record("web-service-ready.json")["web_pid"],
        web["web_pid"]
    );
    let saved = fs::read(fixture.root.join("web/service.json")).unwrap();
    assert!(
        !fixture
            .public_command("web")
            .args(["--port", "invalid"])
            .output()
            .unwrap()
            .status
            .success()
    );
    assert_eq!(
        fs::read(fixture.root.join("web/service.json")).unwrap(),
        saved
    );

    assert!(!fixture.root.join("web-service-failure.txt").exists());
    let mut old = host.clone();
    old.as_object_mut().unwrap().remove("version");
    fs::write(
        fixture.root.join("shared-host-ready.json"),
        serde_json::to_vec(&old).unwrap(),
    )
    .unwrap();
    let replaced = fixture.public_command("web").output().unwrap();
    assert!(
        replaced.status.success(),
        "{}",
        String::from_utf8_lossy(&replaced.stderr)
    );
    assert!(
        String::from_utf8_lossy(&replaced.stdout).contains("interrupted 2 running task(s)"),
        "{}",
        String::from_utf8_lossy(&replaced.stdout)
    );
    let host = fixture.record("shared-host-ready.json");
    assert_ne!(host["pid"], old["pid"]);
    let mut old_web = fixture.record("web-service-ready.json");
    old_web["runtime"] = fixture
        .root
        .join("other-install/web.mjs")
        .to_string_lossy()
        .into_owned()
        .into();
    fs::write(
        fixture.root.join("web-service-ready.json"),
        serde_json::to_vec(&old_web).unwrap(),
    )
    .unwrap();
    assert!(
        fixture
            .public_command("web")
            .output()
            .unwrap()
            .status
            .success()
    );
    assert_eq!(fixture.record("shared-host-ready.json"), host);
    let count = fixture.starts();
    let status = fixture.public_command("status").output().unwrap();
    assert!(status.status.success());
    let text = String::from_utf8_lossy(&status.stdout);
    assert!(text.contains("Host: running") && text.contains("Web: running"));
    assert!(text.contains("http://127.0.0.1:4503/"));
    assert!(!text.contains("fixture-secret") && !text.contains("token="));
    assert_eq!(fixture.starts(), count);
}

#[test]
fn stop_continues_after_failures_and_keeps_configuration() {
    #[cfg(windows)]
    if windows_service::run_in_service_job() {
        return;
    }
    let fixture = Fixture::new();
    let started = fixture.public_command("web").output().unwrap();
    assert!(
        started.status.success(),
        "{}",
        String::from_utf8_lossy(&started.stderr)
    );
    fs::create_dir_all(fixture.root.join(".codexhost/remote")).unwrap();
    fs::write(fixture.root.join(".codexhost/remote/manifest.json"), "{}").unwrap();
    fs::write(fixture.root.join("remote-fail"), "fail").unwrap();
    #[cfg(target_os = "macos")]
    {
        let runtime = fixture.root.join("Library/Application Support/codexhost");
        fs::create_dir_all(&runtime).unwrap();
        fs::write(runtime.join("desktop-runtime-v1.json"), "invalid").unwrap();
    }
    let _stopped = fixture.public_command("stop").output().unwrap();
    #[cfg(not(target_os = "windows"))]
    {
        assert!(!_stopped.status.success());
        assert!(String::from_utf8_lossy(&_stopped.stderr).contains("Remote: stop failed"));
    }
    assert!(!fixture.root.join("web-service-ready.json").exists());
    assert!(!fixture.root.join("shared-host-ready.json").exists());
    assert!(
        fixture
            .root
            .join(".codexhost/remote/manifest.json")
            .exists()
    );
    #[cfg(unix)]
    {
        let events = fs::read_to_string(fixture.root.join("events")).unwrap();
        assert!(
            events.contains("web-stop\nhost-stop\nremote-stop\nconsole-stop\n"),
            "{events}"
        );
    }
    let count = fixture.starts();
    thread::sleep(Duration::from_millis(1200));
    assert_eq!(fixture.starts(), count);
}

#[cfg(not(target_os = "windows"))]
#[test]
fn stopped_remote_installation_does_not_report_running_services_or_raw_json() {
    let fixture = Fixture::new();
    assert!(
        fixture
            .public_command("web")
            .output()
            .unwrap()
            .status
            .success()
    );
    fs::create_dir_all(fixture.root.join(".codexhost/remote")).unwrap();
    fs::write(fixture.root.join(".codexhost/remote/manifest.json"), "{}").unwrap();
    let first = fixture.public_command("stop").output().unwrap();
    assert!(
        first.status.success(),
        "{}",
        String::from_utf8_lossy(&first.stderr)
    );
    let text = String::from_utf8_lossy(&first.stdout);
    assert!(text.contains("reconnect from the other computer"));
    assert!(!text.contains("changed") && !text.contains("stopped="));
    let second = fixture.public_command("stop").output().unwrap();
    assert!(
        second.status.success(),
        "{}",
        String::from_utf8_lossy(&second.stderr)
    );
    assert_eq!(
        String::from_utf8_lossy(&second.stdout),
        "No codexhost services are running\n"
    );
    let events = fs::read_to_string(fixture.root.join("events")).unwrap();
    assert_eq!(
        events.lines().filter(|event| *event == "host-stop").count(),
        1
    );
}

#[test]
fn missing_host_entry_reports_failure_but_still_stops_web_and_console() {
    #[cfg(windows)]
    if windows_service::run_in_service_job() {
        return;
    }
    let fixture = Fixture::new();
    assert!(
        fixture
            .public_command("web")
            .output()
            .unwrap()
            .status
            .success()
    );
    let result = fixture
        .public_command("stop")
        .arg("--host-runtime")
        .arg(fixture.root.join("missing-host.mjs"))
        .output()
        .unwrap();
    assert!(!result.status.success());
    assert!(String::from_utf8_lossy(&result.stderr).contains("Host:"));
    assert!(!fixture.root.join("web-service-ready.json").exists());
    assert!(fixture.root.join("shared-host-ready.json").exists());
    assert!(
        fs::read_to_string(fixture.root.join("events"))
            .unwrap()
            .ends_with("console-stop\n")
    );
}

#[cfg(target_os = "macos")]
#[test]
fn terminal_launch_prints_both_addresses_when_desktop_is_missing() {
    let fixture = Fixture::new();
    let launched = fixture
        .public_command("launch")
        .env("CODEXHOST_WEB_SERVICE", "1")
        .env("CODEXHOST_CONSOLE", "1")
        .output()
        .unwrap();
    assert!(
        launched.status.success(),
        "{}",
        String::from_utf8_lossy(&launched.stderr)
    );
    assert!(String::from_utf8_lossy(&launched.stdout).contains("Codex Desktop is not installed"));
    let text = String::from_utf8_lossy(&launched.stderr);
    assert_eq!(text.matches("codexhost console: ").count(), 1);
    assert_eq!(text.matches("codexhost web: ").count(), 1);
    assert!(text.contains("codexhost web: http://127.0.0.1:4501/?token=fixture-secret"));
    assert!(fixture.root.join("console-calls").exists());
    assert!(fixture.root.join("web-service-ready.json").exists());
}

#[cfg(target_os = "macos")]
#[test]
fn terminal_failure_prints_ready_web_but_omits_disabled_web() {
    let fixture = Fixture::new();
    for enabled in ["1", "0"] {
        let result = fixture
            .public_command("launch")
            .env("CODEXHOST_INSTALL_ROOT", &fixture.root)
            .env("CODEXHOST_WEB_SERVICE", enabled)
            .env("CODEXHOST_CONSOLE", "1")
            .output()
            .unwrap();
        assert!(!result.status.success());
        let text = String::from_utf8_lossy(&result.stderr);
        assert_eq!(text.matches("codexhost console: ").count(), 1);
        assert_eq!(
            text.matches("codexhost web: ").count(),
            usize::from(enabled == "1")
        );
    }
}

#[cfg(target_os = "macos")]
#[test]
fn missing_desktop_and_failed_web_use_the_existing_console_error_path() {
    let fixture = Fixture::new();
    fs::write(fixture.root.join("fail"), "fail").unwrap();
    let result = fixture
        .public_command("launch")
        .env("CODEXHOST_WEB_SERVICE", "1")
        .env("CODEXHOST_CONSOLE", "1")
        .arg("--shim")
        .arg(&fixture.node)
        .arg("--desktop-controller")
        .arg(&fixture.node)
        .arg("--renderer")
        .arg(&fixture.node)
        .output()
        .unwrap();
    assert!(!result.status.success());
    assert!(String::from_utf8_lossy(&result.stderr).contains("Web startup failed:"));
    assert!(!String::from_utf8_lossy(&result.stderr).contains("codexhost web: "));
    assert!(
        fs::read_to_string(fixture.root.join("console-calls"))
            .unwrap()
            .contains("open")
    );
    assert_eq!(fixture.starts(), 1);
}

#[cfg(target_os = "macos")]
#[test]
fn failed_web_does_not_prevent_activation_of_the_owned_gui() {
    owned_gui_activation(false);
}

#[cfg(target_os = "macos")]
#[test]
fn failed_replacement_is_recorded_without_preventing_gui_activation() {
    owned_gui_activation(true);
}

#[cfg(target_os = "macos")]
fn owned_gui_activation(refuse_stop: bool) {
    use fs2::FileExt;
    use std::net::TcpListener;
    use std::os::unix::fs::PermissionsExt;
    let fixture = Fixture::new();
    let bundle = fixture.root.join("Codex.app");
    fs::create_dir_all(bundle.join("Contents/MacOS")).unwrap();
    fs::create_dir_all(bundle.join("Contents/Resources")).unwrap();
    fs::write(bundle.join("Contents/Resources/app.asar"), "fixture").unwrap();
    fs::write(bundle.join("Contents/Info.plist"), r#"<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.openai.codex</string><key>CFBundleExecutable</key><string>Codex</string><key>CFBundleShortVersionString</key><string>1.0</string><key>CFBundleVersion</key><string>1</string></dict></plist>"#).unwrap();
    for file in ["Contents/MacOS/Codex", "Contents/Resources/codex"] {
        fs::write(bundle.join(file), [0xcf, 0xfa, 0xed, 0xfe]).unwrap();
        fs::set_permissions(bundle.join(file), fs::Permissions::from_mode(0o755)).unwrap();
    }
    let runtime = fixture.root.join("Library/Application Support/codexhost");
    fs::create_dir_all(&runtime).unwrap();
    let guard = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(runtime.join("launcher-v1.lock"))
        .unwrap();
    guard.lock_exclusive().unwrap();
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let nonce = "0123456789abcdef0123456789abcdef";
    fs::write(runtime.join("desktop-runtime-v1.json"), serde_json::to_vec(&serde_json::json!({
        "schema_version":1,"launcher_pid":std::process::id(),"control_port":listener.local_addr().unwrap().port(),"nonce":nonce
    })).unwrap()).unwrap();
    assert!(
        fixture
            .public_command("web")
            .output()
            .unwrap()
            .status
            .success()
    );
    let mut old_host = fixture.record("shared-host-ready.json");
    old_host["version"] = "old".into();
    fs::write(
        fixture.root.join("shared-host-ready.json"),
        serde_json::to_vec(&old_host).unwrap(),
    )
    .unwrap();
    if refuse_stop {
        fs::write(fixture.root.join("host-stop-fail"), "fail").unwrap();
    }
    let host_record = fixture.root.join("shared-host-ready.json");
    let controller = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut line = String::new();
        BufReader::new(stream.try_clone().unwrap())
            .read_line(&mut line)
            .unwrap();
        assert_eq!(line.trim(), format!("ATTACH {nonce}"));
        let host: serde_json::Value =
            serde_json::from_slice(&fs::read(host_record).unwrap()).unwrap();
        if refuse_stop {
            assert_eq!(host, old_host);
        } else {
            assert_eq!(host["version"], env!("CARGO_PKG_VERSION"));
            assert_ne!(host["pid"], old_host["pid"]);
        }
        writeln!(stream, "ready").unwrap();
    });
    fs::write(fixture.root.join("fail"), "fail").unwrap();
    let launched = fixture
        .public_command("launch")
        .env("CODEXHOST_WEB_SERVICE", "1")
        .env("CODEXHOST_INSTALL_ROOT", &bundle)
        .arg("--shim")
        .arg(&fixture.node)
        .arg("--desktop-controller")
        .arg(&fixture.node)
        .arg("--renderer")
        .arg(&fixture.node)
        .output()
        .unwrap();
    assert!(
        launched.status.success(),
        "{}",
        String::from_utf8_lossy(&launched.stderr)
    );
    controller.join().unwrap();
    let failure = fs::read_to_string(fixture.root.join("web-service-failure.txt")).unwrap();
    if refuse_stop {
        assert!(failure.contains("Shared Host shutdown was not confirmed"));
        assert_eq!(fixture.starts(), 1);
    } else {
        assert!(failure.contains("fixture port is occupied"));
    }
}

#[cfg(unix)]
#[test]
fn service_supervisor_hands_off_once_and_can_retry_without_desktop() {
    use std::os::unix::fs::PermissionsExt;
    struct FinishHelper(PathBuf);
    impl Drop for FinishHelper {
        fn drop(&mut self) {
            let _ = fs::write(&self.0, "finish");
        }
    }
    let fixture = Fixture::new();
    let started = fixture
        .command("host", "ensure")
        .env("CODEXHOST_NPM_NODE_PATH", &fixture.node)
        .output()
        .unwrap();
    assert!(
        started.status.success(),
        "{}",
        String::from_utf8_lossy(&started.stderr)
    );
    let environment = fixture.record("update-environment.json");
    assert_eq!(environment["CODEXHOST_UPDATE_SERVICE"], "1");
    assert_eq!(environment["CODEXHOST_NPM_NODE_PATH"], fixture.node);
    let owner: u32 = environment["CODEXHOST_LAUNCHER_PID"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    let state = PathBuf::from(
        environment["CODEXHOST_RUNTIME_DESCRIPTOR_PATH"]
            .as_str()
            .unwrap(),
    )
    .parent()
    .unwrap()
    .join("updates");
    fs::create_dir_all(&state).unwrap();
    let deadline = || Instant::now() + Duration::from_secs(15);
    for attempt in 1..=2 {
        let operation = state.join(format!("update-1.2.3-test-{attempt}"));
        fs::create_dir_all(&operation).unwrap();
        let status = operation.join("status-v1.json");
        let request = operation.join("request-v1.json");
        let helper = operation.join("codexhost-updater");
        let _helper_cleanup = FinishHelper(operation.join("finish"));
        let helper_source = format!(
            r##"#!{}
import fs from 'node:fs';
import path from 'node:path';
const file = process.argv.at(-1);
const request = JSON.parse(fs.readFileSync(file));
const root = request.data_directory;
fs.writeFileSync(path.join(path.dirname(file), 'observed.json'), JSON.stringify({{pid:process.pid, request}}));
const write = phase => {{
 const status = JSON.parse(fs.readFileSync(request.status_path));
 status.phase=phase;
 fs.writeFileSync(request.status_path+'.tmp', JSON.stringify(status));
 fs.renameSync(request.status_path+'.tmp', request.status_path);
}};
write('waiting-for-exit');
setTimeout(() => process.exit(2), 30_000);
setInterval(() => {{
 if (fs.existsSync(path.join(path.dirname(file), 'finish'))) {{ write('failed'); process.exit(0); }}
}}, 20);
"##,
            fixture.node
        );
        fs::write(&helper, helper_source).unwrap();
        fs::set_permissions(&helper, fs::Permissions::from_mode(0o700)).unwrap();
        fs::write(&request, serde_json::to_vec(&serde_json::json!({
            "schema_version":1,"wait_pid":owner,"wait_executable":environment["CODEXHOST_LAUNCHER_EXECUTABLE"],
            "status_path":status,"service_managed":true,"restart_target":"desktop","data_directory":fixture.root
        })).unwrap()).unwrap();
        fs::write(&status, serde_json::to_vec(&serde_json::json!({
            "schemaVersion":1,"version":"1.2.3","installation":"npm","phase":"prepared","updatedAt":1
        })).unwrap()).unwrap();
        let lock = state.join("active-update-v1.lock");
        fs::write(
            &lock,
            serde_json::to_vec(&serde_json::json!({"ownerPid":1,"statusPath":status})).unwrap(),
        )
        .unwrap();
        let until = deadline();
        let observed = loop {
            if let Ok(bytes) = fs::read(operation.join("observed.json"))
                && let Ok(observed) = serde_json::from_slice::<serde_json::Value>(&bytes)
            {
                break observed;
            }
            assert!(
                Instant::now() < until,
                "service update did not start: {:?}",
                fs::read_to_string(&status)
            );
            thread::sleep(Duration::from_millis(20));
        };
        assert_eq!(observed["request"]["restart_target"], "web");
        let updater = observed["pid"].as_u64().unwrap() as u32;
        let until = deadline();
        loop {
            let owned: serde_json::Value =
                serde_json::from_slice(&fs::read(&lock).unwrap()).unwrap();
            if owned["ownerPid"] == updater {
                break;
            }
            assert!(Instant::now() < until);
            thread::sleep(Duration::from_millis(20));
        }
        // A service handoff leaves Host online until the Updater stops it.
        assert!(fixture.root.join("shared-host-ready.json").exists());
        if attempt == 2 {
            assert!(
                fixture
                    .command("host", "stop")
                    .output()
                    .unwrap()
                    .status
                    .success()
            );
            assert!(
                codexhost_platform::process_snapshot(updater).is_ok(),
                "Updater was killed with Host"
            );
            // An unrelated client cannot restart Host while installation is active.
            let blocked = fixture.command("host", "ensure").output().unwrap();
            assert!(!blocked.status.success());
            assert!(String::from_utf8_lossy(&blocked.stderr).contains("update is installing"));
        }
        fs::write(operation.join("finish"), "finish").unwrap();
        let until = deadline();
        loop {
            let result: serde_json::Value =
                serde_json::from_slice(&fs::read(&status).unwrap()).unwrap();
            if result["phase"] == "failed" {
                break;
            }
            assert!(Instant::now() < until);
            thread::sleep(Duration::from_millis(20));
        }
    }
}

#[test]
fn background_web_reuses_saved_configuration_without_opening_a_window() {
    #[cfg(windows)]
    if windows_service::run_in_service_job() {
        return;
    }
    let fixture = Fixture::new();
    let started = fixture
        .public_command("web")
        .args(["--background", "--port", "4599"])
        .output()
        .unwrap();
    assert!(
        started.status.success(),
        "{}",
        String::from_utf8_lossy(&started.stderr)
    );
    assert!(!String::from_utf8_lossy(&started.stdout).contains("token="));
    let record = fixture.record("web-service-ready.json");
    assert_eq!(record["address"], "http://127.0.0.1:4599/");
    let repeated = fixture
        .public_command("web")
        .args(["--background", "--update-recovery"])
        .output()
        .unwrap();
    assert!(
        repeated.status.success(),
        "{}",
        String::from_utf8_lossy(&repeated.stderr)
    );
    assert_eq!(fixture.starts(), 1);
}

#[test]
fn desktop_update_recovery_prepares_host_even_with_web_disabled() {
    #[cfg(windows)]
    if windows_service::run_in_service_job() {
        return;
    }
    let fixture = Fixture::new();
    // The fixture has no Desktop installation. Host preparation must still precede
    // that launch error, without starting Web or touching a real Desktop process.
    let result = fixture
        .public_command("launch")
        .arg("--update-recovery")
        .output()
        .unwrap();
    assert!(!result.status.success());
    assert!(fixture.root.join("shared-host-ready.json").exists());
    assert!(!fixture.root.join("web-service-ready.json").exists());
    assert!(
        fs::read_to_string(fixture.root.join("events"))
            .unwrap()
            .contains("host-start")
    );
}

#[test]
fn update_recovery_and_stop_refuse_to_replace_another_installation() {
    #[cfg(windows)]
    if windows_service::run_in_service_job() {
        return;
    }
    let fixture = Fixture::new();
    assert!(fixture.run("ensure").status.success());
    let original = fixture.record("shared-host-ready.json");
    let other = fixture.root.join("other-host.mjs");
    fs::copy(fixture.root.join("host-runtime.mjs"), &other).unwrap();
    for action in ["web", "stop-for-update"] {
        let mut command = fixture.public_command(action);
        command.arg("--host-runtime").arg(&other);
        if action == "web" {
            command.args(["--background", "--update-recovery"]);
        }
        let result = command.output().unwrap();
        assert!(!result.status.success());
        assert!(String::from_utf8_lossy(&result.stderr).contains("different installation"));
        assert_eq!(
            fixture.record("shared-host-ready.json")["pid"],
            original["pid"]
        );
        assert_eq!(fixture.starts(), 1);
    }
}
