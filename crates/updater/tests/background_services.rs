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
        let _ = self.owner.kill();
        let _ = self.owner.wait();
        let _ = fs::remove_dir_all(&self.root);
    }
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
