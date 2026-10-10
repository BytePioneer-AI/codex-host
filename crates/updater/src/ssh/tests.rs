use super::*;

#[cfg(unix)]
fn executable(path: &std::path::Path, source: &str) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::write(path, source).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
}

#[cfg(unix)]
#[test]
fn missing_tools_report_specific_failures_before_installation_or_service_changes() {
    let root = std::env::temp_dir().join(format!("codexhost-ssh-missing-{}", std::process::id()));
    for (action, missing, expected) in [
        ("install", "node", 45),
        ("install", "npm", 56),
        ("install", "codex", 57),
        ("update", "node", 45),
        ("update", "npm", 56),
        ("repair", "node", 45),
        ("repair", "codexhost", 58),
    ] {
        let home = root.join(format!("{action}-{missing}"));
        let bin = home.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        if action != "install" {
            std::fs::create_dir_all(home.join(".codexhost/remote")).unwrap();
            std::fs::write(home.join(".codexhost/remote/manifest.json"), "{}").unwrap();
        }
        // Restrict PATH to this fixture: a tool installed on the test host must not mask
        // a missing remote prerequisite. Only filesystem/OS helpers are real executables.
        for tool in ["mkdir", "rmdir", "uname"] {
            let source = ["/bin", "/usr/bin"]
                .iter()
                .map(|directory| std::path::Path::new(directory).join(tool))
                .find(|file| file.is_file())
                .unwrap();
            std::os::unix::fs::symlink(source, bin.join(tool)).unwrap();
        }
        for tool in ["node", "npm", "codex", "codexhost"] {
            if tool != missing {
                let source = if tool == "node" {
                    "#!/bin/sh\nexit 0\n"
                } else {
                    "#!/bin/sh\nprintf '%s\\n' called >> \"$HOME/calls\"\nexit 0\n"
                };
                executable(&bin.join(tool), source);
            }
        }
        let mut r = request();
        r.action = action.into();
        r.version = Some("1.2.3".into());
        let result = Command::new("/bin/sh")
            .args(["-c", &script(&r).unwrap()])
            .env_clear()
            .env("HOME", &home)
            .env("PATH", &bin)
            .output()
            .unwrap();
        assert_eq!(result.status.code(), Some(expected), "{action}: {missing}");
        assert!(!home.join("calls").exists(), "{action}: {missing}");
        assert!(!home.join(".codexhost/ssh-setup.lock").exists());
    }
    std::fs::remove_dir_all(root).unwrap();
}

#[cfg(unix)]
#[test]
fn login_environment_finds_tools_despite_a_system_node_and_noisy_startup() {
    let root = std::env::temp_dir().join(format!("codexhost-ssh-login-{}", std::process::id()));
    let system = root.join("system");
    let selected = root.join("selected node's bin");
    std::fs::create_dir_all(&system).unwrap();
    std::fs::create_dir_all(&selected).unwrap();
    executable(&system.join("node"), "#!/bin/sh\nexit 1\n");
    for tool in ["node", "npm", "codex", "codexhost"] {
        executable(&selected.join(tool), "#!/bin/sh\nexit 0\n");
    }
    // A shell fixture loads a version manager only when both login and interactive flags
    // are present. Its output exceeds a pipe buffer and contains non-UTF8 bytes.
    let shell = root.join("user shell");
    executable(
        &shell,
        r#"#!/bin/sh
[ "$1" = -l ] && [ "$2" = -i ] && [ "$3" = -c ] || exit 99
head -c 100000 /dev/zero
printf '\377welcome\n'
PATH="$SELECTED_BIN:$PATH"; export PATH
exec /bin/sh -c "$4"
"#,
    );
    let mut r = request();
    r.action = "install".into();
    r.version = Some("1.2.3".into());
    let run = |recorded: &std::path::Path| {
        Command::new("/bin/sh")
            .args(["-c", &remote_command(&r, &script(&r).unwrap())])
            .env_clear()
            .env("HOME", &root)
            .env("SHELL", &shell)
            .env("PATH", format!("{}:/usr/bin:/bin", system.display()))
            .env("SELECTED_BIN", &selected)
            .env("CODEXHOST_HOST_NODE_PATH", recorded)
            .output()
            .unwrap()
    };
    let result = run(&root.join("removed-node"));
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let tail = read_output_tail(result.stdout.as_slice()).unwrap();
    assert_eq!(tail.len(), 16_384);
    assert_eq!(response_state(&tail).unwrap(), "installed");
    // A still-executable recorded runtime wins over the shell default. Unsupported versions
    // stop before installation instead of silently moving the existing service to another npm.
    assert_eq!(run(&system.join("node")).status.code(), Some(55));
    std::fs::remove_file(selected.join("codex")).unwrap();
    assert_eq!(run(&root.join("removed-node")).status.code(), Some(57));
    std::fs::remove_dir_all(root).unwrap();
}

#[cfg(unix)]
#[test]
fn inspect_does_not_require_a_shell_or_node_and_requires_a_state_marker() {
    let root = std::env::temp_dir().join(format!("codexhost-ssh-inspect-{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    let r = request();
    let run = || {
        Command::new("/bin/sh")
            .args(["-c", &remote_command(&r, &script(&r).unwrap())])
            .env_clear()
            .env("HOME", &root)
            .env("SHELL", "/missing-shell")
            .output()
            .unwrap()
    };
    assert_eq!(response_state(&run().stdout).unwrap(), "not-installed");
    std::fs::create_dir_all(root.join(".codexhost/remote")).unwrap();
    std::fs::write(root.join(".codexhost/remote/manifest.json"), "{}").unwrap();
    assert_eq!(response_state(&run().stdout).unwrap(), "installed");
    for invalid in ["installed", "welcome", "__CODEXHOST_SSH_STATE__=unexpected"] {
        assert!(response_state(invalid.as_bytes()).is_err());
    }
    std::fs::remove_dir_all(root).unwrap();
}
fn request() -> Request {
    Request {
        hostname: "user@host".into(),
        port: Some(2222),
        identity: Some("/tmp/key with spaces".into()),
        action: "inspect".into(),
        version: None,
        uninstall_package: false,
    }
}

#[cfg(unix)]
#[test]
fn uninstall_stops_before_removing_setup_and_only_removes_an_explicit_matching_package() {
    let root = std::env::temp_dir().join(format!("codexhost-ssh-uninstall-{}", std::process::id()));
    let mocks = r#"
node(){ case "$2" in *realpathSync*) return "${MATCH_CODE:-0}";; *) return 0;; esac; }
npm(){
  case "$1" in
    root) printf '%s\n' "$HOME/npm";;
    uninstall) printf '%s\n' 'npm uninstall' >> "$HOME/calls"; [ "${FAIL:-}" != npm ] || return 1; rm "$HOME/npm/@codexhost/cli/package.json";;
    *) return 99;;
  esac
}
codexhost(){
  printf '%s\n' "$*" >> "$HOME/calls"
  case "$2" in
    stop) [ "${FAIL:-}" != stop ];;
    status) printf '%s\n' '{"protocol": "codexhost"}';;
    uninstall) [ "${FAIL:-}" != uninstall ] || return 1; rm -f "$HOME/.codexhost/remote/manifest.json";;
    *) return 99;;
  esac
}
"#;
    for (name, remove_package, failure, match_code, code, expected_calls) in [
        (
            "service",
            false,
            "",
            "0",
            0,
            "remote stop\nremote uninstall\n",
        ),
        (
            "package",
            true,
            "",
            "0",
            0,
            "remote stop\nremote uninstall\nnpm uninstall\n",
        ),
        ("mismatch", true, "", "1", 59, ""),
        (
            "stop-failure",
            true,
            "stop",
            "0",
            50,
            "remote stop\nremote status\n",
        ),
        (
            "uninstall-failure",
            true,
            "uninstall",
            "0",
            51,
            "remote stop\nremote uninstall\n",
        ),
        (
            "npm-failure",
            true,
            "npm",
            "0",
            60,
            "remote stop\nremote uninstall\nnpm uninstall\n",
        ),
    ] {
        let home = root.join(name);
        let remote = home.join(".codexhost/remote");
        let package = home.join("npm/@codexhost/cli");
        std::fs::create_dir_all(remote.join("data")).unwrap();
        std::fs::create_dir_all(&package).unwrap();
        std::fs::write(remote.join("manifest.json"), "{}").unwrap();
        std::fs::write(remote.join("data/chat"), "keep").unwrap();
        std::fs::write(package.join("package.json"), "{}").unwrap();
        let mut r = request();
        r.action = "uninstall".into();
        r.uninstall_package = remove_package;
        let result = Command::new("/bin/sh")
            .args(["-c", &format!("{mocks}{}", script(&r).unwrap())])
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("HOME", &home)
            .env("FAIL", failure)
            .env("MATCH_CODE", match_code)
            .output()
            .unwrap();
        assert_eq!(
            result.status.code(),
            Some(code),
            "{name}: {}",
            String::from_utf8_lossy(&result.stderr)
        );
        assert_eq!(
            std::fs::read_to_string(home.join("calls")).unwrap_or_default(),
            expected_calls,
            "{name}"
        );
        assert_eq!(
            package.join("package.json").exists(),
            !(remove_package && code == 0),
            "{name}"
        );
        assert_eq!(
            remote.join("manifest.json").exists(),
            code != 0 && code != 60,
            "{name}"
        );
        assert_eq!(
            std::fs::read_to_string(remote.join("data/chat")).unwrap(),
            "keep"
        );
        assert!(!home.join(".codexhost/ssh-setup.lock").exists());
        if code == 0 {
            assert_eq!(response_state(&result.stdout).unwrap(), "not-installed");
        }
    }
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn passes_identity_and_destination_as_separate_arguments() {
    let r = request();
    let args = arguments(&r, &script(&r).unwrap());
    assert!(args.windows(2).any(|a| a == ["-i", "/tmp/key with spaces"]));
    assert!(args.windows(2).any(|a| a == ["--", "user@host"]));
}
#[test]
fn refuses_options_and_unpublished_versions() {
    let mut r = request();
    r.hostname = "-oProxyCommand=x".into();
    assert!(script(&r).is_err());
    r.hostname = "host".into();
    r.action = "install".into();
    r.version = Some("1.2.3;echo bad".into());
    assert!(script(&r).is_err());
    r.version = Some("1.2.3-dev".into());
    assert!(script(&r).is_err());
    r.action = "update".into();
    assert!(script(&r).is_err());
    r.version = None;
    assert!(script(&r).is_err());
}
#[cfg(unix)]
#[test]
fn maintenance_finds_tools_beside_the_recorded_node() {
    let root = std::env::temp_dir().join(format!("codexhost-ssh-node-{}", std::process::id()));
    let bin = root.join("node/bin");
    let system = root.join("system");
    std::fs::create_dir_all(&system).unwrap();
    executable(&system.join("node"), "#!/bin/sh\nexit 1\n");
    std::fs::create_dir_all(&bin).unwrap();
    std::fs::create_dir_all(root.join(".codexhost/remote")).unwrap();
    std::fs::write(root.join(".codexhost/remote/manifest.json"), "{}").unwrap();
    for tool in ["node", "npm", "codexhost"] {
        use std::os::unix::fs::PermissionsExt;
        let path = bin.join(tool);
        std::fs::write(&path, "#!/bin/sh\nexit 0\n").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    let mut r = request();
    for (action, version) in [("update", Some("1.2.3")), ("repair", None)] {
        r.action = action.into();
        r.version = version.map(Into::into);
        let run = |node: Option<&std::path::Path>| {
            let mut command = Command::new("/bin/sh");
            command
                .args(["-c", &script(&r).unwrap()])
                .env_clear()
                .env("HOME", &root)
                .env("PATH", format!("{}:/usr/bin:/bin", system.display()));
            if let Some(node) = node {
                command.env("CODEXHOST_HOST_NODE_PATH", node);
            }
            command.output().unwrap()
        };
        assert_eq!(run(None).status.code(), Some(55), "{action}");
        assert!(run(Some(&bin.join("node"))).status.success(), "{action}");
    }
    std::fs::remove_dir_all(root).unwrap();
}
#[cfg(unix)]
#[test]
fn takes_over_a_lock_left_by_an_interrupted_run() {
    let root = std::env::temp_dir().join(format!("codexhost-ssh-lock-{}", std::process::id()));
    let lock = root.join(".codexhost/ssh-setup.lock");
    std::fs::create_dir_all(&lock).unwrap();
    let mut r = request();
    r.action = "repair".into();
    let mocks = "node(){ :; }; codexhost(){ :; }; ";
    let run = || {
        Command::new("/bin/sh")
            .args(["-c", &format!("{mocks}{}", script(&r).unwrap())])
            .env("HOME", &root)
            .output()
            .unwrap()
    };
    // A lock that could belong to a run still in progress is respected.
    assert_eq!(run().status.code(), Some(49));
    assert!(lock.exists());
    let stale = std::time::SystemTime::now() - Duration::from_secs(20 * 60);
    std::fs::File::open(&lock)
        .unwrap()
        .set_modified(stale)
        .unwrap();
    assert!(run().status.success());
    assert!(!lock.exists());
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn install_refuses_to_replace_existing_remote_services() {
    let mut r = request();
    r.action = "install".into();
    r.version = Some("1.2.3".into());
    let value = script(&r).unwrap();
    assert!(value.contains("exit 43"));
    assert!(value.contains("@codexhost/cli@1.2.3"));
    assert!(!value.contains("remote stop"));
}
#[cfg(unix)]
#[test]
fn executes_initial_setup_and_refuses_an_existing_installation() {
    let root = std::env::temp_dir().join(format!(
        "codexhost-ssh-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let mut r = request();
    r.action = "install".into();
    r.version = Some("1.2.3".into());
    let mocks = r#"node(){ :; }; npm(){ printf '%s\n' "$*" >> "$HOME/calls"; }; codex(){ :; }; codexhost(){ printf '%s\n' "$*" >> "$HOME/calls"; }; "#;
    let value = format!("{mocks}{}", script(&r).unwrap());
    let first = Command::new("sh")
        .args(["-c", &value])
        .env("HOME", &root)
        .output()
        .unwrap();
    assert!(first.status.success());
    let calls = std::fs::read_to_string(root.join("calls")).unwrap();
    assert_eq!(
        calls,
        "install -g @codexhost/cli@1.2.3\nremote install\nremote start\n"
    );
    std::fs::create_dir_all(root.join(".codexhost/remote")).unwrap();
    std::fs::write(root.join(".codexhost/remote/manifest.json"), "{}").unwrap();
    let second = Command::new("sh")
        .args(["-c", &value])
        .env("HOME", &root)
        .output()
        .unwrap();
    assert_eq!(second.status.code(), Some(43));
    assert_eq!(std::fs::read_to_string(root.join("calls")).unwrap(), calls);
    assert!(!root.join(".codexhost/ssh-setup.lock").exists());
    r.action = "update".into();
    r.version = Some("1.2.4".into());
    let update = format!("{mocks}{}", script(&r).unwrap());
    let updated = Command::new("sh")
        .args(["-c", &update])
        .env("HOME", &root)
        .output()
        .unwrap();
    assert!(updated.status.success());
    let calls = format!(
        "{calls}view @codexhost/cli@1.2.4 version --fetch-retries=0 --fetch-timeout=30000\nremote stop\ninstall -g @codexhost/cli@1.2.4\nremote install\nremote stop\nremote start\n"
    );
    assert_eq!(std::fs::read_to_string(root.join("calls")).unwrap(), calls);
    assert!(!root.join(".codexhost/ssh-setup.lock").exists());
    r.action = "repair".into();
    r.version = None;
    let repair = format!("{mocks}{}", script(&r).unwrap());
    let repaired = Command::new("sh")
        .args(["-c", &repair])
        .env("HOME", &root)
        .output()
        .unwrap();
    assert!(repaired.status.success());
    assert_eq!(
        std::fs::read_to_string(root.join("calls")).unwrap(),
        format!(
            "{calls}remote stop\nremote uninstall\nremote install\nremote stop\nremote start\n"
        )
    );
    std::fs::remove_dir_all(root).unwrap();
}
