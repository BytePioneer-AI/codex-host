#![cfg(target_os = "macos")]

use std::{
    env, fs,
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

#[test]
fn cli_contract_and_status_are_read_only_in_isolated_home() {
    let root = env::temp_dir().join(format!(
        "autostart-cli-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir(&root).unwrap();
    let command = |args: &[&str]| {
        let mut command = Command::new(env!("CARGO_BIN_EXE_codexhost"));
        command
            .env_clear()
            .env("HOME", &root)
            .env("CODEXHOST_DATA_DIR", root.join("data"))
            .env("CODEX_HOME", root.join("codex"))
            .env("CODEXHOST_CONSOLE_PORT", "4473")
            .env("SSH_CONNECTION", "smoke")
            .args(args);
        command
    };
    let path = root.join("Library/LaunchAgents/ai.bytepioneer.codexhost.autostart.plist");
    let off = command(&["autostart", "status"]).output().unwrap();
    assert!(off.status.success());
    assert_eq!(off.stdout, b"off\n");
    assert!(!path.exists());
    let on = command(&["autostart", "on"]).output().unwrap();
    assert!(
        on.status.success(),
        "{}",
        String::from_utf8_lossy(&on.stderr)
    );
    assert!(on.stdout.is_empty());
    let before = fs::read(&path).unwrap();
    let status = command(&["autostart", "status"]).output().unwrap();
    assert_eq!(status.stdout, b"on\n");
    assert_eq!(fs::read(&path).unwrap(), before);
    let status = command(&["status"]).output().unwrap();
    assert!(status.status.success());
    assert!(String::from_utf8_lossy(&status.stdout).contains("Autostart: on\n"));
    assert!(!String::from_utf8_lossy(&status.stdout).contains("token"));
    assert!(
        !root.join("data").exists(),
        "status must not start services"
    );

    let node = root.join("node");
    let wrapper = root.join("cli.js");
    fs::write(&node, "fixture").unwrap();
    fs::write(&wrapper, "fixture").unwrap();
    let on = command(&["autostart", "on"])
        .env("CODEXHOST_NPM_NODE_PATH", &node)
        .env("CODEXHOST_NPM_LAUNCHER_PATH", &wrapper)
        .output()
        .unwrap();
    assert!(on.status.success());
    let content = fs::read_to_string(&path).unwrap();
    assert!(content.contains(wrapper.to_str().unwrap()));
    assert!(content.contains(node.to_str().unwrap()));
    fs::remove_file(&wrapper).unwrap();
    let status = command(&["autostart", "status"]).output().unwrap();
    let text = String::from_utf8(status.stdout).unwrap();
    assert!(status.status.success());
    assert!(text.starts_with("invalid "));
    assert_eq!(text.lines().count(), 1);
    assert!(text.contains("run `codexhost` again to repair"));
    let status = command(&["status"]).output().unwrap();
    assert!(String::from_utf8_lossy(&status.stdout).contains("Autostart: invalid "));
    assert_eq!(fs::read_to_string(&path).unwrap(), content);
    let failed = command(&["autostart", "on"])
        .env("CODEXHOST_NPM_NODE_PATH", &node)
        .env("CODEXHOST_NPM_LAUNCHER_PATH", &wrapper)
        .output()
        .unwrap();
    assert!(!failed.status.success());
    assert!(!failed.stderr.is_empty());
    assert!(failed.stdout.is_empty());
    assert_eq!(fs::read_to_string(&path).unwrap(), content);
    let off = command(&["autostart", "off"]).output().unwrap();
    assert!(off.status.success());
    assert!(!path.exists());
    assert!(
        command(&["autostart", "off"])
            .output()
            .unwrap()
            .status
            .success()
    );
    for args in [
        vec!["autostart"],
        vec!["autostart", "on", "extra"],
        vec!["autostart", "unknown"],
    ] {
        let output = command(&args).output().unwrap();
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
    }
    // A filesystem failure uses the same nonzero/stderr contract as enable.
    fs::create_dir(&path).unwrap();
    let off = command(&["autostart", "off"]).output().unwrap();
    assert!(!off.status.success());
    assert!(!off.stderr.is_empty());
    fs::remove_dir_all(&root).unwrap();
}
