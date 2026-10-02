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
/// Only published stable releases are installed over SSH; the value is interpolated into a script.
fn release_version(request: &Request) -> Result<&str, Box<dyn Error>> {
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
    Ok(version)
}
fn script(request: &Request) -> Result<String, Box<dyn Error>> {
    if request.hostname.is_empty()
        || request.hostname.starts_with('-')
        || request.hostname.chars().any(char::is_whitespace)
        || request.port == Some(0)
    {
        return Err("Invalid SSH address or port".into());
    }
    // Version managers such as nvm are usually loaded only by interactive shells, so a
    // non-interactive SSH session often has no Node.js on PATH. An installed service records
    // its Node.js in the SSH profile; use that (and the npm and codexhost beside it). Otherwise
    // fall back to loading nvm, which is where Node.js most often is on a fresh computer.
    let node = "if [ -n \"${CODEXHOST_HOST_NODE_PATH:-}\" ]; then PATH=\"$(dirname \"$CODEXHOST_HOST_NODE_PATH\"):$PATH\"; export PATH; fi; if ! command -v node >/dev/null 2>&1 && [ -s \"${NVM_DIR:-$HOME/.nvm}/nvm.sh\" ]; then . \"${NVM_DIR:-$HOME/.nvm}/nvm.sh\" >/dev/null 2>&1 || true; fi; ";
    // With a damaged installation SSH sessions fall through to stock Codex, which then owns the
    // control socket. There is no managed service to stop in that case; starting replaces it.
    let stock = "codexhost remote status 2>/dev/null | grep -q '\"protocol\": \"stock-codex\"'";
    // The desktop reconnects while the service starts, and on a slow computer the two can replace
    // each other's listener for a while, outlasting the start command's own wait. What matters
    // is that a managed service ends up running, so look again before reporting a failed start.
    let started = "{ sleep 20; codexhost remote status 2>/dev/null | grep -q '\"protocol\": \"codexhost\"'; } || { sleep 20; codexhost remote status 2>/dev/null | grep -q '\"protocol\": \"codexhost\"'; }";
    // One installation at a time. A dropped connection can kill the script before it releases
    // the lock, and nothing else would ever remove it, so a lock older than any run can last
    // (runs are limited to five minutes) is taken over.
    let lock = "mkdir -p \"$HOME/.codexhost\"; L=\"$HOME/.codexhost/ssh-setup.lock\"; mkdir \"$L\" 2>/dev/null || { [ -n \"$(find \"$L\" -maxdepth 0 -mmin +15 2>/dev/null)\" ] && rmdir \"$L\" 2>/dev/null && mkdir \"$L\" 2>/dev/null; } || exit 49; trap 'rmdir \"$L\"' EXIT; ";
    let probe = "if [ -f \"$HOME/.codexhost/remote/manifest.json\" ]; then printf installed; else printf not-installed; fi";
    match request.action.as_str() {
        "inspect" => Ok(probe.into()),
        "install" => {
            let version = release_version(request)?;
            Ok(format!(
                "{node}set -e; {lock}[ ! -f \"$HOME/.codexhost/remote/manifest.json\" ] || exit 43; case $(uname -s) in Darwin|Linux) ;; *) exit 44;; esac; command -v node >/dev/null && command -v npm >/dev/null && command -v codex >/dev/null || exit 45; npm install -g @codexhost/cli@{version} >/dev/null 2>&1 || exit 46; codexhost remote install >/dev/null 2>&1 || exit 47; codexhost remote start >/dev/null 2>&1 || {started} || exit 48; printf installed"
            ))
        }
        // For services too old to update themselves. A newer CLI refuses to stop an installation
        // written in an older format, so the old CLI stops the service when it is available, and
        // the new CLI migrates the installation before stopping whatever is still running.
        "update" => {
            let version = release_version(request)?;
            Ok(format!(
                "{node}set -e; {lock}[ -f \"$HOME/.codexhost/remote/manifest.json\" ] || exit 52; command -v node >/dev/null && command -v npm >/dev/null || exit 45; npm view @codexhost/cli@{version} version --fetch-retries=0 --fetch-timeout=30000 >/dev/null 2>&1 || exit 53; if command -v codexhost >/dev/null; then codexhost remote stop >/dev/null 2>&1 || true; fi; npm install -g @codexhost/cli@{version} >/dev/null 2>&1 || {{ codexhost remote start >/dev/null 2>&1 || true; exit 46; }}; command -v codexhost >/dev/null || exit 54; codexhost remote install >/dev/null 2>&1 || exit 47; codexhost remote stop >/dev/null 2>&1 || {stock} || exit 50; codexhost remote start >/dev/null 2>&1 || {started} || exit 48; printf installed"
            ))
        }
        // A damaged installation is exactly what the CLI refuses to stop, so the first stop is
        // best effort; once the installation is rewritten, the second one must succeed.
        "repair" => Ok(format!(
            "{node}set -e; command -v codexhost >/dev/null || exit 45; {lock}codexhost remote stop >/dev/null 2>&1 || true; codexhost remote uninstall >/dev/null 2>&1 || exit 51; codexhost remote install >/dev/null 2>&1 || exit 47; codexhost remote stop >/dev/null 2>&1 || {stock} || exit 50; codexhost remote start >/dev/null 2>&1 || {started} || exit 48; printf installed"
        )),
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
            Some(43) => "Remote service is already installed. Connect and use its update button",
            Some(52) => "Remote service is not installed. Use Install and connect instead",
            Some(53) => "This release is not published on npm, or the remote computer cannot reach the registry",
            Some(54) => "codexhost was installed but is not on the remote PATH. Update this remote manually",
            Some(44) => "Only Mac and Linux remote computers are supported",
            Some(45) => "Node.js, npm or Codex CLI was not found over SSH. Install them on the remote computer and make sure non-interactive SSH sessions have them on PATH",
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
                    .env("PATH", "/usr/bin:/bin");
                if let Some(node) = node {
                    command.env("CODEXHOST_HOST_NODE_PATH", node);
                }
                command.output().unwrap()
            };
            assert_eq!(run(None).status.code(), Some(45), "{action}");
            assert!(run(Some(&bin.join("node"))).status.success(), "{action}");
        }
        // Without a recorded Node.js, nvm is loaded when it is present.
        std::fs::create_dir_all(root.join(".nvm")).unwrap();
        std::fs::write(
            root.join(".nvm/nvm.sh"),
            format!("PATH=\"{}:$PATH\"; export PATH\n", bin.display()),
        )
        .unwrap();
        let loaded = Command::new("/bin/sh")
            .args(["-c", &script(&r).unwrap()])
            .env_clear()
            .env("HOME", &root)
            .env("PATH", "/usr/bin:/bin")
            .output()
            .unwrap();
        assert!(loaded.status.success());
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
        let mocks = "codexhost(){ :; }; ";
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
}
