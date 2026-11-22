use super::*;

#[cfg(target_os = "macos")]
#[path = "autostart_linux.rs"]
mod linux;
#[cfg(target_os = "linux")]
use super::native as linux;

#[cfg(unix)]
#[test]
fn linux_registration_uses_only_the_isolated_user_service() {
    use std::{env, fs, os::unix::fs::PermissionsExt, process::Command};
    if env::var_os("CODEXHOST_AUTOSTART_LINUX_TEST_CHILD").is_none() {
        let home = crate::temporary_directory("autostart-linux-home");
        fs::write(home.join("systemctl"), "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$HOME/systemctl.calls\"\nif [ -f \"$HOME/unavailable\" ]; then echo 'no user bus' >&2; exit 1; fi\n").unwrap();
        fs::set_permissions(home.join("systemctl"), fs::Permissions::from_mode(0o755)).unwrap();
        let output = Command::new(env::current_exe().unwrap())
            .args([
                "--exact",
                "autostart::tests::linux_registration_uses_only_the_isolated_user_service",
                "--nocapture",
            ])
            .env("CODEXHOST_AUTOSTART_LINUX_TEST_CHILD", "1")
            .env("HOME", &home)
            .env("XDG_CONFIG_HOME", home.join("config"))
            .env("PATH", &home)
            .env("CODEXHOST_DATA_DIR", home.join("data"))
            .env("CODEX_HOME", home.join("codex"))
            .env("CODEXHOST_CONSOLE_PORT", "4473")
            .env("SSH_CONNECTION", "smoke")
            .output()
            .unwrap();
        fs::remove_dir_all(home).unwrap();
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        return;
    }
    let home = home().unwrap();
    assert!(home.starts_with(env::temp_dir()));
    let command = AutostartCommand {
        executable: env::current_exe().unwrap(),
        wrapper: None,
    };
    let arguments = command.arguments().unwrap();
    let generated = linux::render(&arguments).unwrap();
    assert!(linux::read().unwrap().is_none());
    linux::remove().unwrap();
    assert!(!home.join("config").exists());
    fs::write(home.join("unavailable"), "fixture").unwrap();
    let error = linux::write(&generated).unwrap_err().to_string();
    assert!(error.contains("systemd user service unavailable"));
    assert!(error.contains("no user bus"));
    assert!(!home.join("config").exists());
    fs::remove_file(home.join("unavailable")).unwrap();
    linux::write(&generated).unwrap();
    let content = linux::read().unwrap().unwrap();
    assert_eq!(content, systemd_unit(&arguments));
    linux::validate(&content).unwrap();
    assert_eq!(linux::read().unwrap().unwrap(), content);
    #[cfg(target_os = "linux")]
    {
        let path = home.join("config/systemd/user/codexhost-autostart.service");
        let unchanged = std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(3600);
        fs::File::open(&path)
            .unwrap()
            .set_modified(unchanged)
            .unwrap();
        let calls = fs::read(home.join("systemctl.calls")).unwrap();
        fs::write(home.join("unavailable"), "no user bus over SSH").unwrap();
        refresh_autostart(&command).unwrap();
        assert_eq!(fs::metadata(&path).unwrap().modified().unwrap(), unchanged);
        assert_eq!(fs::read(home.join("systemctl.calls")).unwrap(), calls);
        fs::remove_file(home.join("unavailable")).unwrap();
    }
    linux::remove().unwrap();
    assert!(linux::read().unwrap().is_none());
    linux::remove().unwrap();
    assert_eq!(
        fs::read_to_string(home.join("systemctl.calls")).unwrap(),
        "--user show-environment\n--user show-environment\n--user enable codexhost-autostart.service\n--user show-environment\n--user disable codexhost-autostart.service\n"
    );
    fs::remove_file(home.join("systemctl")).unwrap();
    assert!(
        linux::write(&generated)
            .unwrap_err()
            .to_string()
            .contains("systemd user service unavailable")
    );
}

#[test]
fn macos_launch_agent_runs_once_without_keepalive() {
    let arguments = vec![
        "/Applications/Codex Host & <test>/codexhost".into(),
        "web".into(),
        "--background".into(),
    ];
    let content = launch_agent(&arguments);
    assert!(content.contains("<key>RunAtLoad</key><true/>"));
    assert!(!content.contains("KeepAlive"));
    assert!(!content.contains("launchctl"));
    assert!(content.contains("/Applications/Codex Host &amp; &lt;test&gt;/codexhost"));
    assert!(content.contains("<string>web</string>\n<string>--background</string>"));
    #[cfg(target_os = "macos")]
    {
        let value = plist::Value::from_reader_xml(content.as_bytes()).unwrap();
        let actual = value.as_dictionary().unwrap()["ProgramArguments"]
            .as_array()
            .unwrap();
        assert_eq!(
            actual
                .iter()
                .map(|value| value.as_string().unwrap())
                .collect::<Vec<_>>(),
            arguments
        );
    }
}

#[test]
fn linux_oneshot_preserves_paths_without_shell_expansion() {
    let arguments = vec![
        "/home/user/node bin/node".into(),
        "/home/user/a\"b\\c%u$HOME/cli.js".into(),
        "web".into(),
        "--background".into(),
    ];
    let content = systemd_unit(&arguments);
    assert!(content.contains("Type=oneshot\nRemainAfterExit=yes\n"));
    assert!(content.contains("WantedBy=default.target"));
    assert!(content.contains("%%u$$HOME"));
    assert!(!content.contains("Restart="));
    assert_eq!(systemd_arguments(&content).unwrap(), arguments);
}

#[test]
fn windows_run_quotes_npm_paths_and_enforces_utf16_limit() {
    assert_eq!(
        windows_run_command(&[
            r"C:\Program Files\codexhost\bin\codexhost-start.exe".into(),
            "--autostart".into()
        ])
        .unwrap(),
        r#""C:\Program Files\codexhost\bin\codexhost-start.exe" --autostart"#
    );
    let arguments = vec![
        r"C:\Program Files\nodejs\node.exe".into(),
        r"C:\Users\user\npm cli\codexhost.js".into(),
        "web".into(),
        "--background".into(),
    ];
    assert_eq!(
        windows_run_command(&arguments).unwrap(),
        r#""C:\Program Files\nodejs\node.exe" "C:\Users\user\npm cli\codexhost.js" web --background"#
    );
    let suffix = " web --background";
    let at_limit = vec![
        "x".repeat(260 - suffix.len()),
        "web".into(),
        "--background".into(),
    ];
    assert_eq!(
        windows_run_command(&at_limit)
            .unwrap()
            .encode_utf16()
            .count(),
        260
    );
    let mut too_long = at_limit.clone();
    too_long[0].push('x');
    assert!(
        windows_run_command(&too_long)
            .unwrap_err()
            .to_string()
            .contains("261 characters; the limit is 260")
    );
    let mut unicode = at_limit;
    unicode[0].replace_range(..1, "😀");
    assert!(windows_run_command(&unicode).is_err());
}

#[cfg(target_os = "windows")]
#[test]
fn windows_packaged_entrypoint_uses_the_gui_launcher_but_npm_keeps_node() {
    let root = crate::temporary_directory("autostart-windows-entrypoint");
    let launcher = root.join("codexhost.exe");
    let start = root.join("codexhost-start.exe");
    let wrapper = root.join("cli.js");
    std::fs::write(&launcher, "fixture").unwrap();
    std::fs::write(&wrapper, "fixture").unwrap();
    let command = AutostartCommand {
        executable: launcher.clone(),
        wrapper: None,
    };
    assert!(command.arguments().is_err());
    std::fs::write(&start, "fixture").unwrap();
    assert_eq!(
        command.arguments().unwrap(),
        [start.to_str().unwrap(), "--autostart"]
    );
    std::fs::remove_file(start).unwrap();
    let npm = AutostartCommand {
        wrapper: Some(wrapper.clone()),
        ..command
    };
    assert_eq!(
        npm.arguments().unwrap(),
        [
            launcher.to_str().unwrap(),
            wrapper.to_str().unwrap(),
            "web",
            "--background"
        ]
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn validates_the_program_and_npm_wrapper_not_just_node() {
    let root = crate::temporary_directory("autostart-paths");
    let node = root.join("node");
    let wrapper = root.join("cli.js");
    std::fs::write(&node, "fixture").unwrap();
    let command = AutostartCommand {
        executable: node,
        wrapper: Some(wrapper.clone()),
    };
    assert!(command.arguments().is_err());
    std::fs::write(&wrapper, "fixture").unwrap();
    let arguments = command.arguments().unwrap();
    validate_arguments(&arguments).unwrap();
    std::fs::remove_file(&wrapper).unwrap();
    assert!(
        validate_arguments(&arguments)
            .unwrap_err()
            .to_string()
            .contains("missing")
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[cfg(target_os = "macos")]
#[test]
fn macos_registration_lifecycle_in_temporary_home() {
    use std::{env, fs, process::Command};
    // Run the public API in a child process so HOME is isolated without mutating
    // the environment of parallel tests. This never loads a LaunchAgent.
    if env::var_os("CODEXHOST_AUTOSTART_TEST_CHILD").is_none() {
        let home = crate::temporary_directory("autostart-home");
        let output = Command::new(env::current_exe().unwrap())
            .args([
                "--exact",
                "autostart::tests::macos_registration_lifecycle_in_temporary_home",
                "--nocapture",
            ])
            .env("CODEXHOST_AUTOSTART_TEST_CHILD", "1")
            .env("HOME", &home)
            .env("CODEXHOST_DATA_DIR", home.join("data"))
            .env("CODEX_HOME", home.join("codex"))
            .env("CODEXHOST_CONSOLE_PORT", "4473")
            .env("SSH_CONNECTION", "smoke")
            .output()
            .unwrap();
        fs::remove_dir_all(home).unwrap();
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        return;
    }
    let home = home().unwrap();
    assert!(home.starts_with(env::temp_dir()));
    let node = home.join("node");
    let wrapper = home.join("cli.js");
    fs::write(&node, "fixture").unwrap();
    fs::write(&wrapper, "fixture").unwrap();
    let command = AutostartCommand {
        executable: node.clone(),
        wrapper: Some(wrapper),
    };
    assert_eq!(autostart_status(), AutostartStatus::Off);
    refresh_autostart(&command).unwrap();
    assert!(!home.join("Library").exists());
    disable_autostart().unwrap();
    enable_autostart(&command).unwrap();
    assert_eq!(autostart_status(), AutostartStatus::On);
    let path = home.join("Library/LaunchAgents/ai.bytepioneer.codexhost.autostart.plist");
    let before = fs::read(&path).unwrap();
    let unchanged = std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(3600);
    fs::File::open(&path)
        .unwrap()
        .set_modified(unchanged)
        .unwrap();
    refresh_autostart(&command).unwrap();
    assert_eq!(fs::metadata(&path).unwrap().modified().unwrap(), unchanged);
    fs::remove_file(node).unwrap();
    assert!(
        matches!(autostart_status(), AutostartStatus::Invalid(reason) if reason.contains("missing"))
    );
    assert_eq!(fs::read(&path).unwrap(), before, "status is read-only");
    assert!(refresh_autostart(&command).is_err());
    assert_eq!(
        fs::read(&path).unwrap(),
        before,
        "failed refresh preserves entry"
    );
    let new_node = home.join("new-node");
    fs::write(&new_node, "fixture").unwrap();
    let command = AutostartCommand {
        executable: new_node.clone(),
        ..command
    };
    refresh_autostart(&command).unwrap();
    assert_eq!(autostart_status(), AutostartStatus::On);
    assert!(
        fs::read_to_string(&path)
            .unwrap()
            .contains(new_node.to_str().unwrap())
    );
    fs::write(&path, "broken plist").unwrap();
    assert!(matches!(autostart_status(), AutostartStatus::Invalid(_)));
    refresh_autostart(&command).unwrap();
    assert_eq!(autostart_status(), AutostartStatus::On);
    disable_autostart().unwrap();
    assert!(!path.exists());
    disable_autostart().unwrap();
    refresh_autostart(&command).unwrap();
    assert_eq!(autostart_status(), AutostartStatus::Off);
}
