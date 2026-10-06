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
    #[serde(default)]
    uninstall_package: bool,
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
    // The login shell has loaded the user's version manager. Existing installations keep
    // their recorded runtime ahead of that default, provided the executable still exists.
    let node = r#"if [ -n "${CODEXHOST_HOST_NODE_PATH:-}" ] && [ -x "$CODEXHOST_HOST_NODE_PATH" ]; then PATH="$(dirname "$CODEXHOST_HOST_NODE_PATH"):$PATH"; export PATH; fi;
command -v node >/dev/null 2>&1 || exit 45;
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major === 24 || (major === 22 && minor >= 19) ? 0 : 1)' >/dev/null 2>&1 || exit 55;
"#;
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
    let probe = "if [ -f \"$HOME/.codexhost/remote/manifest.json\" ]; then printf '\\n__CODEXHOST_SSH_STATE__=installed\\n'; else printf '\\n__CODEXHOST_SSH_STATE__=not-installed\\n'; fi";
    match request.action.as_str() {
        "inspect" => Ok(probe.into()),
        "install" => {
            let version = release_version(request)?;
            Ok(format!(
                "{node}set -e; {lock}[ ! -f \"$HOME/.codexhost/remote/manifest.json\" ] || exit 43; case $(uname -s) in Darwin|Linux) ;; *) exit 44;; esac; command -v npm >/dev/null 2>&1 || exit 56; command -v codex >/dev/null 2>&1 || exit 57; npm install -g @codexhost/cli@{version} >/dev/null 2>&1 || exit 46; codexhost remote install >/dev/null 2>&1 || exit 47; codexhost remote start >/dev/null 2>&1 || {started} || exit 48; printf '\\n__CODEXHOST_SSH_STATE__=installed\\n'"
            ))
        }
        // For services too old to update themselves. A newer CLI refuses to stop an installation
        // written in an older format, so the old CLI stops the service when it is available, and
        // the new CLI migrates the installation before stopping whatever is still running.
        "update" => {
            let version = release_version(request)?;
            Ok(format!(
                "{node}set -e; {lock}[ -f \"$HOME/.codexhost/remote/manifest.json\" ] || exit 52; command -v npm >/dev/null 2>&1 || exit 56; npm view @codexhost/cli@{version} version --fetch-retries=0 --fetch-timeout=30000 >/dev/null 2>&1 || exit 53; if command -v codexhost >/dev/null; then codexhost remote stop >/dev/null 2>&1 || true; fi; npm install -g @codexhost/cli@{version} >/dev/null 2>&1 || {{ codexhost remote start >/dev/null 2>&1 || true; exit 46; }}; command -v codexhost >/dev/null || exit 54; codexhost remote install >/dev/null 2>&1 || exit 47; codexhost remote stop >/dev/null 2>&1 || {stock} || exit 50; codexhost remote start >/dev/null 2>&1 || {started} || exit 48; printf '\\n__CODEXHOST_SSH_STATE__=installed\\n'"
            ))
        }
        // A damaged installation is exactly what the CLI refuses to stop, so the first stop is
        // best effort; once the installation is rewritten, the second one must succeed.
        "repair" => Ok(format!(
            "{node}set -e; command -v codexhost >/dev/null 2>&1 || exit 58; {lock}codexhost remote stop >/dev/null 2>&1 || true; codexhost remote uninstall >/dev/null 2>&1 || exit 51; codexhost remote install >/dev/null 2>&1 || exit 47; codexhost remote stop >/dev/null 2>&1 || {stock} || exit 50; codexhost remote start >/dev/null 2>&1 || {started} || exit 48; printf '\\n__CODEXHOST_SSH_STATE__=installed\\n'"
        )),
        "uninstall" => {
            let package_check = if request.uninstall_package {
                r#"command -v npm >/dev/null 2>&1 || exit 56;
NPM_ROOT=$(npm root --global 2>/dev/null) || exit 59;
CLI=$(command -v codexhost) || exit 58;
node -e 'const fs = require("node:fs"), path = require("node:path"); try { const expected = path.join(process.argv[1], "@codexhost/cli/bin/codexhost.js"); process.exit(fs.realpathSync(expected) === fs.realpathSync(process.argv[2]) ? 0 : 1); } catch { process.exit(1); }' "$NPM_ROOT" "$CLI" >/dev/null 2>&1 || exit 59;
"#
            } else {
                ""
            };
            let package_remove = if request.uninstall_package {
                "npm uninstall --global @codexhost/cli >/dev/null 2>&1 || exit 60; [ ! -e \"$NPM_ROOT/@codexhost/cli/package.json\" ] || exit 60;"
            } else {
                ""
            };
            // Keep the npm package until its CLI has stopped the service and removed the
            // managed entrypoint/profile (and the macOS broker). No user data is deleted.
            Ok(format!(
                "{node}set -e; {lock}command -v codexhost >/dev/null 2>&1 || exit 58; {package_check}if [ -f \"$HOME/.codexhost/remote/manifest.json\" ]; then codexhost remote stop >/dev/null 2>&1 || {{ {stock}; }} || exit 50; fi; codexhost remote uninstall >/dev/null 2>&1 || exit 51; [ ! -f \"$HOME/.codexhost/remote/manifest.json\" ] || exit 51; {package_remove}printf '\\n__CODEXHOST_SSH_STATE__=not-installed\\n'"
            ))
        }
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
        remote_command(request, script),
    ]);
    args
}
fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}
fn remote_command(request: &Request, script: &str) -> String {
    if request.action == "inspect" {
        return format!("exec /bin/sh -c {}", shell_quote(script));
    }
    // Load the same interactive login environment as native Codex SSH, then execute the
    // fixed operation in sh so fish/csh syntax and user aliases cannot change the payload.
    let login = r#"CODEXHOST_SSH_SCRIPT="$1"; export CODEXHOST_SSH_SCRIPT;
case "${SHELL##*/}" in
csh|tcsh) exec "$SHELL" -i -c 'set loginsh=1; if ( -r /etc/csh.login ) source /etc/csh.login; if ( -r ~/.login ) source ~/.login; exec /bin/sh -c "$CODEXHOST_SSH_SCRIPT"' ;;
nu) exec "$SHELL" -l -i -c 'exec /bin/sh -c $env.CODEXHOST_SSH_SCRIPT' ;;
*) exec "${SHELL:-/bin/sh}" -l -i -c 'exec /bin/sh -c "$CODEXHOST_SSH_SCRIPT"' ;;
esac"#;
    format!(
        "exec /bin/sh -c {} sh {}",
        shell_quote(login),
        shell_quote(script)
    )
}
// Shell startup files can print banners. Drain stdout while SSH runs so they cannot fill
// its pipe, retaining only a bounded tail containing the operation's final state marker.
fn read_output_tail(mut input: impl Read) -> io::Result<Vec<u8>> {
    const LIMIT: usize = 16_384;
    let mut output = Vec::new();
    let mut buffer = [0; 4096];
    loop {
        let count = input.read(&mut buffer)?;
        if count == 0 {
            return Ok(output);
        }
        output.extend_from_slice(&buffer[..count]);
        if output.len() > LIMIT {
            output.drain(..output.len() - LIMIT);
        }
    }
}
fn response_state(output: &[u8]) -> Result<&str, Box<dyn Error>> {
    match String::from_utf8_lossy(output)
        .trim_end()
        .rsplit('\n')
        .next()
    {
        Some("__CODEXHOST_SSH_STATE__=installed") => Ok("installed"),
        Some("__CODEXHOST_SSH_STATE__=not-installed") => Ok("not-installed"),
        _ => Err("Unexpected SSH inspection response".into()),
    }
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
    let stdout = child.stdout.take().ok_or("SSH output unavailable")?;
    let output = thread::spawn(move || read_output_tail(stdout));
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
            Some(45) => "Node.js was not detected over SSH. Install it on the remote computer or add it to the login shell PATH, then retry",
            Some(56) => "npm was not detected over SSH. Install it on the remote computer or add it to the login shell PATH, then retry",
            Some(57) => "Codex CLI was not detected over SSH. Install the command-line tool on the remote computer or add it to the login shell PATH, then retry. Codex Desktop is not required",
            Some(58) => "codexhost was not detected over SSH. Install it on the remote computer or add it to the login shell PATH, then retry",
            Some(59) => "The active codexhost does not match the global npm installation. Uninstall only the remote service, or remove the package manually on the remote computer",
            Some(60) => "The remote service was uninstalled, but removing the codexhost package failed. Check npm permissions on the remote computer and retry",
            Some(55) => "Remote Node.js is unsupported. Select Node.js 22.19 or later in the 22.x series, or Node.js 24.x",
            Some(46) => "npm installation failed. Check network access and global installation permissions",
            Some(47) => "Remote service configuration failed. Check Codex CLI and the remote desktop login",
            Some(50) => "Remote service could not stop. Check the remote service before retrying",
            Some(51) => "Remote connection configuration could not be removed. Check file permissions",
            Some(49) => "Another remote installation is in progress. Wait and check again",
            Some(48) => "Remote service was installed but could not start. Check the remote service and retry connecting",
            _ => "SSH failed. Check the address, key authentication and trusted host key",
        }.into());
    }
    let output = output.join().map_err(|_| "SSH output reader failed")??;
    let state = response_state(&output)?;
    println!("{}", serde_json::json!({"state":state}));
    Ok(())
}
#[cfg(test)]
mod tests;
