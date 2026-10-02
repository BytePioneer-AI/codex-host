//! Installation and explicit repair over SSH; active conversations may be interrupted.
use serde::Deserialize;
use std::{
    error::Error,
    io::{self, Read},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    hostname: String,
    port: Option<u16>,
    identity: Option<String>,
    action: String,
    version: Option<String>,
}
fn script(request: &Request) -> Result<String, Box<dyn Error>> {
    if request.hostname.is_empty()
        || request.hostname.starts_with('-')
        || request.hostname.chars().any(char::is_whitespace)
        || request.port == Some(0)
    {
        return Err("Invalid SSH address or port".into());
    }
    let probe = "if [ -f \"$HOME/.codexhost/remote/manifest.json\" ]; then printf installed; else printf not-installed; fi";
    match request.action.as_str() {
        "inspect" => Ok(probe.into()),
        "install" => {
            let version = request
                .version
                .as_deref()
                .ok_or("A release version is required")?;
            let parts: Vec<_> = version.split('.').collect();
            if parts.len() != 3
                || parts
                    .iter()
                    .any(|part| part.is_empty() || !part.bytes().all(|byte| byte.is_ascii_digit()))
            {
                return Err("Install requires a published stable version".into());
            }
            Ok(format!(
                "set -e; mkdir -p \"$HOME/.codexhost\"; mkdir \"$HOME/.codexhost/ssh-setup.lock\" 2>/dev/null || exit 49; trap 'rmdir \"$HOME/.codexhost/ssh-setup.lock\"' EXIT; [ ! -f \"$HOME/.codexhost/remote/manifest.json\" ] || exit 43; case $(uname -s) in Darwin|Linux) ;; *) exit 44;; esac; command -v node >/dev/null && command -v npm >/dev/null && command -v codex >/dev/null || exit 45; npm install -g @codexhost/cli@{version} >/dev/null 2>&1 || exit 46; codexhost remote install >/dev/null 2>&1 || exit 47; codexhost remote start >/dev/null 2>&1 || exit 48; printf installed"
            ))
        }
        "repair" => Ok("set -e; command -v codexhost >/dev/null || exit 45; mkdir -p \"$HOME/.codexhost\"; mkdir \"$HOME/.codexhost/ssh-setup.lock\" 2>/dev/null || exit 49; trap 'rmdir \"$HOME/.codexhost/ssh-setup.lock\"' EXIT; codexhost remote stop >/dev/null 2>&1 || exit 50; codexhost remote uninstall >/dev/null 2>&1 || exit 51; codexhost remote install >/dev/null 2>&1 || exit 47; codexhost remote start >/dev/null 2>&1 || exit 48; printf installed".into()),
        _ => Err("Unknown SSH action".into()),
    }
}
fn arguments(request: &Request, script: &str) -> Vec<String> {
    let mut args = vec![
        "-o".into(),
        "BatchMode=yes".into(),
        "-o".into(),
        "ConnectTimeout=10".into(),
        "-o".into(),
        "StrictHostKeyChecking=yes".into(),
    ];
    if let Some(port) = request.port {
        args.extend(["-p".into(), port.to_string()]);
    }
    if let Some(identity) = &request.identity {
        args.extend(["-i".into(), identity.clone()]);
    }
    args.extend([
        "--".into(),
        request.hostname.clone(),
        format!(
            "exec \"${{SHELL:-/bin/sh}}\" -lc '{}'",
            script.replace('\'', "'\\''")
        ),
    ]);
    args
}
pub fn apply() -> Result<(), Box<dyn Error>> {
    let mut bytes = Vec::new();
    io::stdin().take(16 * 1024).read_to_end(&mut bytes)?;
    let request: Request = serde_json::from_slice(&bytes)?;
    let script = script(&request)?;
    let mut child = Command::new("ssh")
        .args(arguments(&request, &script))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    let start = Instant::now();
    let limit = if request.action != "inspect" { 300 } else { 20 };
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if start.elapsed() > Duration::from_secs(limit) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(
                "SSH operation timed out; check the remote computer before retrying".into(),
            );
        }
        thread::sleep(Duration::from_millis(50));
    };
    if !status.success() {
        return Err(match status.code() {
            Some(43) => "Remote service is already installed. Connect and use its update button; older services require a manual update",
            Some(44) => "Only Mac and Linux remote computers are supported",
            Some(45) => "Install Node.js, npm and Codex CLI on the remote computer first",
            Some(46) => "npm installation failed. Check network access and global installation permissions",
            Some(47) => "Remote service configuration failed. Check Codex CLI and the remote desktop login",
            Some(50) => "Remote service could not stop. Check the remote service before retrying",
            Some(51) => "Remote connection configuration could not be removed. Check file permissions",
            Some(49) => "Another remote installation is in progress. Wait and check again",
            Some(48) => "Remote service was installed but could not start. Check the remote service and retry connecting",
            _ => "SSH failed. Check the address, key authentication and trusted host key",
        }.into());
    }
    let mut output = String::new();
    child
        .stdout
        .take()
        .ok_or("SSH output unavailable")?
        .take(16 * 1024)
        .read_to_string(&mut output)?;
    let state = output.trim();
    if state != "installed" && state != "not-installed" {
        return Err("Unexpected SSH inspection response".into());
    }
    println!("{}", serde_json::json!({"state":state}));
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    fn request() -> Request {
        Request {
            hostname: "user@host".into(),
            port: Some(2222),
            identity: Some("/tmp/key with spaces".into()),
            action: "inspect".into(),
            version: None,
        }
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
            format!("{calls}remote stop\nremote uninstall\nremote install\nremote start\n")
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
