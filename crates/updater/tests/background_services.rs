#![cfg(unix)]

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

// A platform package installed as its own global package in `$HOME/node_modules`.
const PACKAGE: &str = "node_modules/@codexhost/cli-fixture";

struct Fixture {
    root: PathBuf,
    owner: Child,
}
impl Fixture {
    fn new(fail_install: bool) -> Self {
        let root = std::env::temp_dir().join(format!(
            "codexhost-update-services-{}-{:?}",
            std::process::id(),
            thread::current().id()
        ));
        fs::create_dir_all(root.join(PACKAGE).join("bin")).unwrap();
        for name in ["web-running", "host-running", "console-running"] {
            fs::write(root.join(name), "running").unwrap();
        }
        let launcher = root.join(PACKAGE).join("bin/codexhost");
        fs::write(
            &launcher,
            r#"#!/bin/sh
set -eu
[ "$1" = stop-for-update ]
[ "$2" = --node ]
[ "$3" = /bin/sh ]
printf 'stop\n' >> "$HOME/order"
rm "$HOME/web-running" "$HOME/host-running"
printf 'Host stopped; interrupted tasks: 7\n<opaque output>\n'
"#,
        )
        .unwrap();
        fs::set_permissions(&launcher, fs::Permissions::from_mode(0o755)).unwrap();
        fs::write(root.join("install.sh"), format!(
            "set -eu\nif [ \"$1\" = root ]; then echo \"$HOME/node_modules\"; exit 0; fi\n[ ! -f \"$HOME/web-running\" ]\n[ ! -f \"$HOME/host-running\" ]\nprintf 'install\\n' >> \"$HOME/order\"\nexit {}\n",
            if fail_install { 1 } else { 0 }
        )).unwrap();
        fs::write(root.join("launch.sh"), format!(
            "set -eu\nprintf 'relaunch\\n' >> \"$HOME/order\"\ntouch \"$HOME/web-running\" \"$HOME/host-running\"\nprintf '%s' '{}' > \"$HOME/runtime.json\"\n",
            serde_json::json!({ "schema_version":1, "launcher_pid":std::process::id(), "control_port":4468, "nonce":"a".repeat(32) })
        )).unwrap();
        let owner = Command::new("/bin/sleep").arg("60").spawn().unwrap();
        fs::write(root.join("request.json"), serde_json::to_vec(&serde_json::json!({
            "schema_version": 1, "version":"1.2.3", "wait_pid":owner.id(),
            "wait_executable":"/bin/sleep", "runtime_descriptor_path":root.join("runtime.json"),
            "status_path":root.join("status.json"), "installation": {
                "kind":"npm", "node_path":"/bin/sh", "npm_cli_path":root.join("install.sh"),
                "npm_launcher_path":root.join("launch.sh"), "npm_package_root":root.join(PACKAGE)
            }
        })).unwrap()).unwrap();
        Self { root, owner }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if let Some(shell) = fixture_shell(&self.root) {
            let _ = codexhost_platform::terminate_process_identity(&(&shell).into(), true);
        }
        let _ = self.owner.kill();
        let _ = self.owner.wait();
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn fixture_shell(root: &std::path::Path) -> Option<codexhost_platform::ProcessSnapshot> {
    let pid = fs::read_to_string(root.join("shell.pid"))
        .ok()?
        .trim()
        .parse()
        .ok()?;
    let shell = codexhost_platform::process_snapshot(pid).ok()?;
    let executable = root
        .join(PACKAGE)
        .join("bin/codexhost-shell")
        .canonicalize()
        .ok()?;
    (shell.executable.canonicalize().ok()? == executable).then_some(shell)
}

#[test]
fn service_managed_handoff_does_not_wait_for_the_owner_and_reports_recovery_failure() {
    assert_managed_update_failure(false);
}

#[test]
fn failed_pre_update_shutdown_does_not_install_and_preserves_the_gui_error() {
    assert_managed_update_failure(true);
}

fn assert_managed_update_failure(stop_fails: bool) {
    let mut fixture = Fixture::new(true);
    let launcher = fixture.root.join(PACKAGE).join("bin/codexhost");
    let script = fs::read_to_string(&launcher).unwrap().replace(
        "[ \"$3\" = /bin/sh ]",
        "[ \"$3\" = /bin/sh ]\n[ \"$4\" = --data ]\n[ \"$5\" = \"$HOME/data\" ]\n[ \"$CODEXHOST_DATA_DIR\" = \"$HOME/data\" ]",
    );
    let script = if stop_fails {
        script.replace(
            "rm \"$HOME/web-running\" \"$HOME/host-running\"",
            "echo 'stopping Desktop failed: lifecycle verification rejected' >&2\nexit 1",
        )
    } else {
        script
    };
    fs::write(launcher, script).unwrap();
    let path = fixture.root.join("request.json");
    let mut request: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    request["service_managed"] = true.into();
    request["restart_target"] = "web".into();
    request["data_directory"] = fixture
        .root
        .join("data")
        .to_string_lossy()
        .into_owned()
        .into();
    let status_path = fixture.root.join("update-fixture/status-v1.json");
    fs::create_dir_all(status_path.parent().unwrap()).unwrap();
    request["status_path"] = serde_json::to_value(&status_path).unwrap();
    let lock_path = fixture.root.join("active-update-v1.lock");
    fs::write(
        &lock_path,
        serde_json::to_vec(&serde_json::json!({
            "ownerPid": fixture.owner.id(), "statusPath": status_path,
        }))
        .unwrap(),
    )
    .unwrap();
    fs::write(&path, serde_json::to_vec(&request).unwrap()).unwrap();
    let mut updater = Command::new(env!("CARGO_BIN_EXE_codexhost-updater"))
        .args(["apply", "--request"])
        .arg(path)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("HOME", &fixture.root)
        .env("USERPROFILE", &fixture.root)
        .env("CODEXHOST_DATA_DIR", fixture.root.join("wrong-data"))
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(15);
    while !status_path.exists() {
        assert!(
            Instant::now() < deadline,
            "managed updater did not acknowledge handoff"
        );
        thread::sleep(Duration::from_millis(20));
    }
    thread::sleep(Duration::from_millis(100));
    assert!(
        !fixture.root.join("order").exists(),
        "services stopped before lock transfer"
    );
    let transferred = fixture.root.join("transferred.lock");
    fs::write(
        &transferred,
        serde_json::to_vec(&serde_json::json!({
            "ownerPid":updater.id(), "statusPath":status_path,
        }))
        .unwrap(),
    )
    .unwrap();
    fs::rename(transferred, lock_path).unwrap();
    loop {
        if let Some(status) = updater.try_wait().unwrap() {
            assert!(!status.success());
            break;
        }
        if Instant::now() >= deadline {
            updater.kill().unwrap();
            updater.wait().unwrap();
            panic!("managed updater waited for its live owner");
        }
        thread::sleep(Duration::from_millis(20));
    }
    assert!(fixture.owner.try_wait().unwrap().is_none());
    let status: serde_json::Value =
        serde_json::from_slice(&fs::read(status_path).unwrap()).unwrap();
    assert_eq!(status["phase"], "failed");
    let error = status["error"].as_str().unwrap();
    if stop_fails {
        assert!(error.contains("pre-update service shutdown failed"));
        assert!(error.contains("stopping Desktop failed: lifecycle verification rejected"));
        assert!(fixture.root.join("host-running").exists());
    } else {
        assert!(error.contains("npm update failed"));
    }
    assert!(
        status["error"]
            .as_str()
            .unwrap()
            .contains("service recovery failed")
    );
    assert_eq!(
        fs::read_to_string(fixture.root.join("order")).unwrap(),
        if stop_fails {
            "stop\n"
        } else {
            "stop\ninstall\n"
        }
    );
}

#[test]
fn rejected_lock_handoff_does_not_stop_or_recover_services() {
    let fixture = Fixture::new(false);
    let status_path = fixture.root.join("update-fixture/status-v1.json");
    fs::create_dir_all(status_path.parent().unwrap()).unwrap();
    let path = fixture.root.join("request.json");
    let mut request: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    request["service_managed"] = true.into();
    request["restart_target"] = "web".into();
    request["data_directory"] = serde_json::to_value(fixture.root.join("data")).unwrap();
    request["status_path"] = serde_json::to_value(&status_path).unwrap();
    fs::write(&path, serde_json::to_vec(&request).unwrap()).unwrap();
    fs::write(
        fixture.root.join("active-update-v1.lock"),
        serde_json::to_vec(&serde_json::json!({
            "ownerPid":fixture.owner.id(), "statusPath":fixture.root.join("unrelated-status.json"),
        }))
        .unwrap(),
    )
    .unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_codexhost-updater"))
        .args(["apply", "--request"])
        .arg(path)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("HOME", &fixture.root)
        .env("USERPROFILE", &fixture.root)
        .output()
        .unwrap();
    assert!(!output.status.success());
    let status: serde_json::Value =
        serde_json::from_slice(&fs::read(status_path).unwrap()).unwrap();
    assert_eq!(status["phase"], "failed");
    assert!(
        status["error"]
            .as_str()
            .unwrap()
            .contains("different update operation")
    );
    assert!(!status["error"].as_str().unwrap().contains("recovery"));
    assert!(!fixture.root.join("order").exists());
    assert!(fixture.root.join("web-running").exists());
    assert!(fixture.root.join("host-running").exists());
}

struct LiveWebFixture {
    supervisor: Child,
    web_pid: u32,
    _listener: std::net::TcpListener,
    address: String,
    supervisor_started_at_micros: u64,
}

impl LiveWebFixture {
    fn start() -> Self {
        use std::io::{BufRead, BufReader};

        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let mut supervisor = Command::new("/bin/sh")
            .args(["-c", "sleep 60 & echo $!; wait"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let mut line = String::new();
        BufReader::new(supervisor.stdout.take().unwrap())
            .read_line(&mut line)
            .unwrap();
        let web_pid: u32 = line.trim().parse().unwrap();
        let supervisor_started_at_micros = codexhost_platform::process_identity(supervisor.id())
            .unwrap()
            .started_at_micros;
        Self {
            supervisor,
            web_pid,
            _listener: listener,
            address: format!("http://127.0.0.1:{port}/"),
            supervisor_started_at_micros,
        }
    }
}

impl Drop for LiveWebFixture {
    fn drop(&mut self) {
        if let Ok(child) = codexhost_platform::process_identity(self.web_pid) {
            let _ = codexhost_platform::terminate_process_identity(&child, true);
        }
        let _ = self.supervisor.kill();
        let _ = self.supervisor.wait();
    }
}

fn run_service_update_relaunch_scenario(fail_install: bool, restart_desktop_shell: bool) {
    let fixture = Fixture::new(fail_install);
    let live = LiveWebFixture::start();
    let package_root = fixture.root.join(PACKAGE);
    let app_dir = package_root.join("app");
    fs::create_dir_all(&app_dir).unwrap();
    fs::write(app_dir.join("host-runtime.mjs"), "fixture").unwrap();
    fs::write(app_dir.join("web-server.mjs"), "fixture").unwrap();
    fs::write(package_root.join("package.json"), r#"{"version":"1.2.2"}"#).unwrap();
    fs::write(
        app_dir.join("codexhost-distribution.json"),
        r#"{"schemaVersion":1,"version":"1.2.2","distribution":"npm","target":"fixture"}"#,
    )
    .unwrap();
    let data = fixture.root.join("data");
    fs::create_dir_all(&data).unwrap();
    let status_path = fixture.root.join("update-fixture/status-v1.json");
    fs::create_dir_all(status_path.parent().unwrap()).unwrap();
    let launcher = package_root.join("bin/codexhost");
    if restart_desktop_shell {
        fs::copy("/bin/sleep", package_root.join("bin/codexhost-shell")).unwrap();
    }
    let shell_ready = data.join("desktop-shell-ready.json");
    let version = if fail_install { "1.2.2" } else { "1.2.3" };

    let host_ready = |version: &str| {
        serde_json::to_string(&serde_json::json!({
            "pid": live.supervisor.id(),
            "started_at_micros": live.supervisor_started_at_micros,
            "executable": "/bin/sh",
            "runtime": app_dir.join("host-runtime.mjs"),
            "version": version,
        }))
        .unwrap()
    };
    let web_ready = |version: &str| {
        serde_json::to_string(&serde_json::json!({
            "pid": live.supervisor.id(),
            "started_at_micros": live.supervisor_started_at_micros,
            "executable": launcher,
            "runtime": app_dir.join("web-server.mjs"),
            "version": version,
            "web_pid": live.web_pid,
            "address": live.address,
        }))
        .unwrap()
    };
    let templates = fixture.root.join("templates");
    fs::create_dir_all(&templates).unwrap();
    for version in ["1.2.2", "1.2.3"] {
        fs::write(
            templates.join(format!("host-{version}.json")),
            host_ready(version),
        )
        .unwrap();
        fs::write(
            templates.join(format!("web-{version}.json")),
            web_ready(version),
        )
        .unwrap();
    }
    fs::write(
        fixture.root.join("install.sh"),
        format!(
            r#"set -eu
if [ "$1" = root ]; then echo "$HOME/node_modules"; exit 0; fi
[ ! -f "$HOME/web-running" ]
[ ! -f "$HOME/host-running" ]
printf 'install\n' >> "$HOME/order"
if [ "{fail}" = "1" ]; then exit 1; fi
printf '{{"schemaVersion":1,"version":"1.2.3","distribution":"npm","target":"fixture"}}' > "{dist}"
"#,
            fail = usize::from(fail_install),
            dist = app_dir.join("codexhost-distribution.json").display(),
        ),
    )
    .unwrap();
    fs::write(
        &launcher,
        format!(
            r#"#!/bin/sh
set -eu
case "$1" in
  stop-for-update)
    printf 'stop\n' >> "$HOME/order"
    rm -f "$HOME/web-running" "$HOME/host-running" "$CODEXHOST_DATA_DIR/shared-host-ready.json" "$CODEXHOST_DATA_DIR/web-service-ready.json"
    ;;
  web)
    printf 'web\n' >> "$HOME/order"
    ver=1.2.2
    if grep -q '"1.2.3"' "{dist}"; then ver=1.2.3; fi
    cp "{templates}/host-$ver.json" "$CODEXHOST_DATA_DIR/shared-host-ready.json"
    cp "{templates}/web-$ver.json" "$CODEXHOST_DATA_DIR/web-service-ready.json"
    ;;
  app)
    printf 'app\n' >> "$HOME/order"
    cp "{status}" "$HOME/app-observed-status.json"
    printf '%s|%s|%s|%s|%s\n' "$CODEXHOST_DATA_DIR" "$CODEXHOST_NPM_NODE_PATH" "$CODEXHOST_NPM_CLI_PATH" "$CODEXHOST_NPM_LAUNCHER_PATH" "$CODEXHOST_NPM_PACKAGE_ROOT" > "$HOME/app-env.tmp"
    mv "$HOME/app-env.tmp" "$HOME/app-env.txt"
    if grep -q '"1.2.3"' "{dist}"; then
      [ "$#" -eq 2 ]
      [ "$2" = --update-recovery ]
    else
      [ "$#" -eq 1 ]
    fi
    "$CODEXHOST_NPM_PACKAGE_ROOT/bin/codexhost-shell" 30 &
    shell_pid=$!
    printf '%s\n' "$shell_pid" > "$HOME/shell.pid.tmp"
    mv "$HOME/shell.pid.tmp" "$HOME/shell.pid"
    wait "$shell_pid"
    ;;
  *)
    exit 1
    ;;
esac
"#,
            dist = app_dir.join("codexhost-distribution.json").display(),
            templates = templates.display(),
            status = status_path.display(),
        ),
    )
    .unwrap();
    fs::set_permissions(&launcher, fs::Permissions::from_mode(0o755)).unwrap();

    let path = fixture.root.join("request.json");
    let mut request: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    request["service_managed"] = true.into();
    request["restart_target"] = "web".into();
    if restart_desktop_shell {
        request["restart_desktop_shell"] = true.into();
    }
    request["data_directory"] = serde_json::to_value(&data).unwrap();
    request["status_path"] = serde_json::to_value(&status_path).unwrap();
    let lock_path = fixture.root.join("active-update-v1.lock");
    fs::write(
        &lock_path,
        serde_json::to_vec(&serde_json::json!({
            "ownerPid": fixture.owner.id(), "statusPath": status_path,
        }))
        .unwrap(),
    )
    .unwrap();
    fs::write(&path, serde_json::to_vec(&request).unwrap()).unwrap();

    let mut updater = Command::new(env!("CARGO_BIN_EXE_codexhost-updater"))
        .args(["apply", "--request"])
        .arg(&path)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("HOME", &fixture.root)
        .env("USERPROFILE", &fixture.root)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(15);
    while !status_path.exists() {
        assert!(
            Instant::now() < deadline,
            "updater did not acknowledge handoff"
        );
        thread::sleep(Duration::from_millis(20));
    }
    let transferred = fixture.root.join("transferred.lock");
    fs::write(
        &transferred,
        serde_json::to_vec(&serde_json::json!({
            "ownerPid": updater.id(), "statusPath": status_path,
        }))
        .unwrap(),
    )
    .unwrap();
    fs::rename(transferred, lock_path).unwrap();

    let exit_status = loop {
        if restart_desktop_shell
            && !shell_ready.exists()
            && let Some(shell) = fixture_shell(&fixture.root)
        {
            // Publish the real process identity once the launched image has exec'd.
            let temporary = shell_ready.with_extension("tmp");
            fs::write(
                &temporary,
                serde_json::to_vec(&serde_json::json!({
                    "pid": shell.id,
                    "started_at_micros": shell.started_at_micros,
                    "executable": shell.executable,
                    "version": version,
                }))
                .unwrap(),
            )
            .unwrap();
            fs::rename(temporary, &shell_ready).unwrap();
        }
        if let Some(status) = updater.try_wait().unwrap() {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = updater.kill();
            let _ = updater.wait();
            panic!(
                "updater did not finish; status={:?}, order={:?}",
                fs::read_to_string(&status_path),
                fs::read_to_string(fixture.root.join("order")),
            );
        }
        thread::sleep(Duration::from_millis(20));
    };
    assert_eq!(exit_status.success(), !fail_install);

    let final_status: serde_json::Value =
        serde_json::from_slice(&fs::read(&status_path).unwrap()).unwrap();
    if fail_install {
        assert_eq!(final_status["phase"], "failed");
        assert!(
            final_status["error"]
                .as_str()
                .unwrap()
                .contains("service recovery succeeded")
        );
        assert!(
            !final_status["error"]
                .as_str()
                .unwrap()
                .contains("desktop shell recovery failed")
        );
    } else {
        assert_eq!(final_status["phase"], "succeeded");
    }

    if restart_desktop_shell {
        let app_env_path = fixture.root.join("app-env.txt");
        assert!(shell_ready.exists());
        assert!(fixture_shell(&fixture.root).is_some());
        let observed_status: serde_json::Value = serde_json::from_slice(
            &fs::read(fixture.root.join("app-observed-status.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(
            observed_status["phase"], "restarting",
            "app must start before the terminal update status"
        );
        let env_line = fs::read_to_string(&app_env_path).unwrap();
        let parts = env_line.trim_end().split('|').collect::<Vec<_>>();
        assert_eq!(parts[0], data.to_string_lossy());
        assert_eq!(parts[1], "/bin/sh");
        assert_eq!(parts[2], fixture.root.join("install.sh").to_string_lossy());
        assert_eq!(parts[3], fixture.root.join("launch.sh").to_string_lossy());
        assert_eq!(
            PathBuf::from(parts[4]).canonicalize().unwrap(),
            package_root.canonicalize().unwrap()
        );
        assert_eq!(
            fs::read_to_string(fixture.root.join("order")).unwrap(),
            "stop\ninstall\nweb\napp\n"
        );
    } else {
        thread::sleep(Duration::from_millis(150));
        assert!(!fixture.root.join("app-env.txt").exists());
        assert_eq!(
            fs::read_to_string(fixture.root.join("order")).unwrap(),
            "stop\ninstall\nweb\n"
        );
    }
}

#[test]
fn desktop_shell_update_relaunches_app_after_success_and_rollback_without_affecting_web() {
    run_service_update_relaunch_scenario(false, true);
    run_service_update_relaunch_scenario(true, true);
    run_service_update_relaunch_scenario(false, false);
}
