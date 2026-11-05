#![cfg(unix)]

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

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
        fs::create_dir_all(root.join("package/bin")).unwrap();
        for name in ["web-running", "host-running", "console-running"] {
            fs::write(root.join(name), "running").unwrap();
        }
        let launcher = root.join("package/bin/codexhost");
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
            "set -eu\n[ ! -f \"$HOME/web-running\" ]\n[ ! -f \"$HOME/host-running\" ]\nprintf 'install\\n' >> \"$HOME/order\"\nexit {}\n",
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
                "npm_launcher_path":root.join("launch.sh"), "npm_package_root":root.join("package")
            }
        })).unwrap()).unwrap();
        Self { root, owner }
    }
    fn status(&self) -> Option<serde_json::Value> {
        fs::read(self.root.join("status.json"))
            .ok()
            .map(|bytes| serde_json::from_slice(&bytes).unwrap())
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self.owner.kill();
        let _ = self.owner.wait();
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn update(fail_install: bool, host_running: bool) {
    let mut fixture = Fixture::new(fail_install);
    if !host_running {
        fs::remove_file(fixture.root.join("host-running")).unwrap();
        let launcher = fixture.root.join("package/bin/codexhost");
        let script = fs::read_to_string(&launcher)
            .unwrap()
            .replace(
                "rm \"$HOME/web-running\" \"$HOME/host-running\"",
                "rm \"$HOME/web-running\"",
            )
            .replace(
                "printf 'Host stopped; interrupted tasks: 7\\n<opaque output>\\n'",
                "",
            );
        fs::write(launcher, script).unwrap();
    }
    let mut updater = Command::new(env!("CARGO_BIN_EXE_codexhost-updater"))
        .args(["apply", "--request"])
        .arg(fixture.root.join("request.json"))
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("HOME", &fixture.root)
        .env("CODEXHOST_DATA_DIR", fixture.root.join("data"))
        .env("CODEX_HOME", fixture.root.join("codex"))
        .env("CODEXHOST_CONSOLE_PORT", "4467")
        .env("SSH_CONNECTION", "smoke")
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(15);
    while fixture.status().is_none() {
        assert!(Instant::now() < deadline);
        thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(fixture.status().unwrap()["phase"], "waiting-for-exit");
    assert!(!fixture.root.join("order").exists());
    assert!(fixture.root.join("web-running").exists());
    assert_eq!(fixture.root.join("host-running").exists(), host_running);
    fixture.owner.kill().unwrap();
    fixture.owner.wait().unwrap();
    loop {
        if let Some(result) = updater.try_wait().unwrap() {
            assert_eq!(result.success(), !fail_install);
            break;
        }
        if Instant::now() >= deadline {
            updater.kill().unwrap();
            panic!("fixture updater timed out");
        }
        thread::sleep(Duration::from_millis(20));
    }
    let status = fixture.status().unwrap();
    assert_eq!(
        status["phase"],
        if fail_install { "failed" } else { "succeeded" }
    );
    if host_running {
        assert_eq!(
            status["serviceStopOutput"],
            "Host stopped; interrupted tasks: 7\n<opaque output>\n"
        );
    } else {
        assert!(status.get("serviceStopOutput").is_none());
    }
    assert_eq!(
        fs::read_to_string(fixture.root.join("order")).unwrap(),
        if fail_install {
            "stop\ninstall\n"
        } else {
            "stop\ninstall\nrelaunch\n"
        }
    );
    assert_eq!(fixture.root.join("web-running").exists(), !fail_install);
    assert_eq!(fixture.root.join("host-running").exists(), !fail_install);
    assert!(fixture.root.join("console-running").exists());
}

#[test]
fn waits_then_stops_services_before_install_and_keeps_opaque_output_after_relaunch() {
    update(false, true);
}
#[test]
fn failed_install_leaves_services_stopped_and_preserves_stop_output() {
    update(true, true);
}

#[test]
fn no_running_host_omits_empty_stop_output_from_the_update_result() {
    update(false, false);
}
