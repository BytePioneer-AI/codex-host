//! npm installation and lifecycle switching for the headless SSH service.
use serde::Deserialize;
use serde_json::json;
use std::{
    error::Error,
    fs,
    io::{self, Read},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    version: String,
    installed_version: String,
    restart_only: bool,
    node: PathBuf,
    npm: PathBuf,
    launcher: PathBuf,
    package_root: PathBuf,
    status_path: PathBuf,
    lock_directory: PathBuf,
}
fn run(command: &mut Command, stdout: Stdio) -> Result<String, Box<dyn Error>> {
    const OUTPUT_LIMIT: u64 = 16 * 1024;
    let timeout = Duration::from_secs(300);
    let mut child = command
        .stdin(Stdio::null())
        .stdout(stdout)
        .stderr(Stdio::null())
        .spawn()?;
    let start = Instant::now();
    // Drain captured output while npm runs. A descendant may keep the pipe open after npm exits.
    let output = child.stdout.take().map(|stdout| {
        let (sender, receiver) = mpsc::channel();
        thread::spawn(move || {
            let _ = sender.send(io::read_to_string(stdout.take(OUTPUT_LIMIT + 1)));
        });
        receiver
    });
    loop {
        if let Some(status) = child.try_wait()? {
            if !status.success() {
                return Err(format!("remote update command failed ({status})").into());
            }
            break;
        }
        if start.elapsed() >= timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Err("remote update command timed out".into());
        }
        thread::sleep(Duration::from_millis(100));
    }
    let Some(output) = output else {
        return Ok(String::new());
    };
    let text = output.recv_timeout(timeout.saturating_sub(start.elapsed()))??;
    if text.len() as u64 > OUTPUT_LIMIT {
        return Err("remote update command output is too large".into());
    }
    Ok(text)
}
fn cancel_path(request: &Request) -> PathBuf {
    request.status_path.with_extension("cancel")
}
fn cancel_requested(request: &Request) -> bool {
    let Ok(bytes) = fs::read(cancel_path(request)) else {
        return false;
    };
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
        return false;
    };
    value["targetVersion"].as_str() == Some(request.version.as_str())
}
fn status(request: &Request, phase: &str, error: Option<String>) -> Result<(), Box<dyn Error>> {
    // Host writes remote-update.cancel before recording failed. That marker is the
    // source of truth for cancellation: the helper must not install after it appears,
    // even if a late rename briefly overwrites the JSON status file.
    if phase != "failed" && (cancel_requested(request) || status_already_failed(request)?) {
        return Err("Remote update was cancelled before the helper started".into());
    }
    let temporary = request.status_path.with_extension("tmp");
    fs::write(
        &temporary,
        serde_json::to_vec(
            &json!({"phase":phase,"targetVersion":request.version,"error":error,"updaterPid":std::process::id()}),
        )?,
    )?;
    // Re-check immediately before publishing so a Host cancel during the write still wins.
    if phase != "failed" && (cancel_requested(request) || status_already_failed(request)?) {
        let _ = fs::remove_file(&temporary);
        return Err("Remote update was cancelled before the helper started".into());
    }
    fs::rename(temporary, &request.status_path)?;
    if phase != "failed" && cancel_requested(request) {
        return Err("Remote update was cancelled before the helper started".into());
    }
    Ok(())
}
fn remote(request: &Request, action: &str) -> Result<(), Box<dyn Error>> {
    run(
        Command::new(&request.node)
            .arg(&request.launcher)
            .args(["remote", action]),
        Stdio::null(),
    )
    .map(|_| ())
    .map_err(|error| format!("Remote {action} failed: {error}").into())
}
pub(crate) fn apply(path: &Path) -> Result<(), Box<dyn Error>> {
    if cfg!(target_os = "windows") {
        return Err("Windows SSH targets are not supported".into());
    }
    if fs::metadata(path)?.len() > 16 * 1024 {
        return Err("remote update request is too large".into());
    }
    let request: Request = serde_json::from_slice(&fs::read(path)?)?;
    crate::request::validate_version(&request.version)?;
    crate::request::validate_version(&request.installed_version)?;
    for file in [
        &request.node,
        &request.npm,
        &request.launcher,
        &request.package_root,
        &request.status_path,
        &request.lock_directory,
    ] {
        if !file.is_absolute() {
            return Err("remote updater paths must be absolute".into());
        }
    }
    // If the Host already timed out (cancel marker and/or failed status), do not install.
    if status_already_failed(&request)? || cancel_requested(&request) {
        return Err("Remote update was cancelled before the helper started".into());
    }
    // Record this process first: the service that started it only knows it by this PID.
    status(&request, "installing", None)?;
    // Host may have timed out between the check and this write; bail before installing.
    if status_already_failed(&request)? || cancel_requested(&request) {
        return Err("Remote update was cancelled before the helper started".into());
    }
    let result = apply_locked(&request);
    if let Err(error) = &result {
        let _ = status(&request, "failed", Some(error.to_string()));
    }
    result
}
fn status_already_failed(request: &Request) -> Result<bool, Box<dyn Error>> {
    let Ok(bytes) = fs::read(&request.status_path) else {
        return Ok(false);
    };
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
        return Ok(false);
    };
    Ok(value["phase"].as_str() == Some("failed")
        && value["targetVersion"].as_str() == Some(request.version.as_str()))
}
const VERSION_MISMATCH: &str = "Installed remote version does not match the requested version";
const INSTALL_FAILED: &str =
    "npm installation failed; check remote network access and write permissions";

fn metadata_version(path: &Path) -> io::Result<String> {
    #[derive(Deserialize)]
    struct Metadata {
        version: String,
    }
    let bytes = fs::read(path)?;
    Ok(serde_json::from_slice::<Metadata>(&bytes)?.version)
}

fn distribution_version(root: &Path) -> io::Result<String> {
    metadata_version(&root.join("app/codexhost-distribution.json"))
}

fn resolve_platform_root(candidates: &[PathBuf]) -> Option<&Path> {
    // The launcher resolves the first package.json before it opens the platform payload.
    candidates
        .iter()
        .map(PathBuf::as_path)
        .find(|root| root.join("package.json").is_file())
}

fn canonical_or_original(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_owned())
}

fn install_release(request: &Request, platform_name: &str) -> Result<String, Box<dyn Error>> {
    let npm = || {
        let mut command = Command::new(&request.node);
        command.arg(&request.npm);
        command
    };
    let root = run(npm().args(["root", "--global"]), Stdio::piped())
        .map_err(|error| format!("Could not identify the global npm installation: {error}"))?;
    let prefix = Path::new(root.trim());
    if !prefix.is_absolute() {
        return Err(
            "Could not identify the global npm installation: expected an absolute path".into(),
        );
    }
    let prefix = canonical_or_original(prefix);
    let launcher_root = request
        .launcher
        .parent()
        .and_then(Path::parent)
        .ok_or("Could not identify the global npm installation: invalid launcher path")?;
    let launcher_root = canonical_or_original(launcher_root);
    let package_root = canonical_or_original(&request.package_root);
    let platform = format!("@codexhost/{platform_name}");
    let hoisted = prefix.join(&platform);
    let global_platform = package_root == hoisted;
    if launcher_root.parent().and_then(Path::parent) != Some(&prefix)
        || (!global_platform && !package_root.starts_with(launcher_root.join("node_modules")))
    {
        return Err("npm uses a different global installation; update this remote manually".into());
    }

    for name in ["@codexhost/cli", &platform] {
        let spec = format!("{name}@{}", request.version);
        let unavailable = "The requested release is unavailable or npm cannot reach the registry";
        let output = run(
            npm().args([
                "view",
                &spec,
                "version",
                "--fetch-retries=0",
                "--fetch-timeout=30000",
            ]),
            Stdio::piped(),
        )
        .map_err(|error| format!("{unavailable}: {spec}: {error}"))?;
        if output.trim() != request.version {
            return Err(
                format!("{unavailable}: {spec} did not report the requested version").into(),
            );
        }
    }

    status(request, "installing", None)?;
    let install = |version: &str| {
        let mut command = npm();
        command
            .args([
                "install",
                "--global",
                "--no-audit",
                "--no-fund",
                "--include=optional",
            ])
            .arg(format!("@codexhost/cli@{version}"));
        if global_platform {
            command.arg(format!("{platform}@{version}"));
        }
        run(&mut command, Stdio::null())
    };
    let result = install(&request.version);
    let mut roots = vec![launcher_root.join("node_modules").join(&platform), hoisted];
    if !roots.contains(&package_root) {
        roots.push(package_root.clone());
    }
    if let Some(root) = resolve_platform_root(&roots) {
        result.map_err(|error| format!("{INSTALL_FAILED}: {error}"))?;
        match distribution_version(root) {
            Ok(version) => {
                if metadata_version(&root.join("package.json")).map_err(|_| VERSION_MISMATCH)?
                    != request.version
                {
                    return Err(VERSION_MISMATCH.into());
                }
                return Ok(version);
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(_) => return Err(VERSION_MISMATCH.into()),
        }
    }
    if install(&request.installed_version).is_ok()
        && let Some(restored) = resolve_platform_root(&roots)
        && canonical_or_original(restored) != package_root
        && distribution_version(restored).ok().as_ref() == Some(&request.installed_version)
    {
        // Keep the running service's manifest pointed at the restored shim and runtime.
        let _ = remote(request, "install");
    }
    Err(format!("{INSTALL_FAILED}: platform package was not installed").into())
}

fn apply_locked(request: &Request) -> Result<(), Box<dyn Error>> {
    fs::create_dir_all(&request.lock_directory)?;
    let lock = request.lock_directory.join("active-update-v1.lock");
    // Same lock as Desktop's updater; never install into one npm prefix concurrently.
    if let Ok(bytes) = fs::read(&lock)
        && let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes)
        && value["remoteUpdate"].as_bool() == Some(true)
        && let Some(pid) = value["ownerPid"]
            .as_u64()
            .and_then(|pid| u32::try_from(pid).ok())
        && pid > 0
        && !codexhost_platform::process_exists(pid)
    {
        let _ = fs::remove_file(&lock);
    }
    let file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&lock)
        .map_err(|_| "Another codexhost update is active; finish it before retrying")?;
    drop(file);
    let result = (|| -> Result<(), Box<dyn Error>> {
        fs::write(
            &lock,
            serde_json::to_vec(
                &json!({"ownerPid":std::process::id(),"statusPath":null,"remoteUpdate":true}),
            )?,
        )?;
        if cancel_requested(request) || status_already_failed(request)? {
            return Err("Remote update was cancelled before the helper started".into());
        }
        if distribution_version(&request.package_root).ok().as_ref()
            != Some(&request.installed_version)
        {
            return Err("The remote installation changed before the update acquired its lock; refresh and retry".into());
        }
        let platform_name = request
            .package_root
            .file_name()
            .and_then(|name| name.to_str())
            .filter(|name| {
                matches!(
                    *name,
                    "cli-darwin-arm64" | "cli-darwin-x64" | "cli-linux-arm64" | "cli-linux-x64"
                )
            })
            .ok_or(
                "Could not identify the global npm installation: unknown remote platform package",
            )?;
        let version = if request.restart_only {
            distribution_version(&request.package_root).map_err(|_| VERSION_MISMATCH)?
        } else {
            install_release(request, platform_name)?
        };
        if version != request.version {
            return Err(VERSION_MISMATCH.into());
        }
        status(request, "restarting", None)?;
        remote(request, "stop")?;
        // Refresh the manifest with the installed package paths before starting a new service.
        if let Err(error) = remote(request, "install").and_then(|_| remote(request, "start")) {
            let _ = remote(request, "start");
            return Err(error);
        }
        status(request, "succeeded", None)?;
        Ok(())
    })();
    let _ = fs::remove_file(lock);
    result
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    static COUNTER: AtomicUsize = AtomicUsize::new(0);
    struct Fixture {
        root: PathBuf,
        request: Request,
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }
    const PLATFORM: &str = "cli-darwin-arm64";
    const METADATA: &str = "app/codexhost-distribution.json";

    impl Fixture {
        fn npm(&self, behavior: &str) {
            let source = format!(
                r#"set -eu
root=$(dirname "$0")
prefix="$root/node_modules"
hoisted="$prefix/@codexhost/{PLATFORM}"
nested="$prefix/@codexhost/cli/node_modules/@codexhost/{PLATFORM}"
write_package() {{
  mkdir -p "$1/app"
  printf '{{"version":"%s"}}\n' "$2" > "$1/package.json"
  cp "$1/package.json" "$1/{METADATA}"
}}
echo "$*" >> "$root/calls"
if [ "$1" = root ]; then echo "$prefix"; exit 0; fi
{behavior}
"#
            );
            fs::write(&self.request.npm, source).unwrap();
        }

        fn calls(&self) -> String {
            fs::read_to_string(self.root.join("calls")).unwrap_or_default()
        }
    }

    fn fixture(nested: bool) -> Fixture {
        let root = std::env::temp_dir().join(format!(
            "codexhost-remote-updater-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let prefix = root.join("node_modules");
        let launcher_root = prefix.join("@codexhost/cli");
        let modules = if nested {
            launcher_root.join("node_modules")
        } else {
            prefix
        };
        let package_root = modules.join("@codexhost").join(PLATFORM);
        fs::create_dir_all(package_root.join("app")).unwrap();
        for file in ["package.json", METADATA] {
            fs::write(package_root.join(file), br#"{"version":"0.11.0"}"#).unwrap();
        }
        let launcher = launcher_root.join("bin/codexhost.js");
        fs::create_dir_all(launcher.parent().unwrap()).unwrap();
        fs::write(
            &launcher,
            format!("echo \"$*\" >> '{}'\n", root.join("calls").display()),
        )
        .unwrap();
        let request = Request {
            version: "0.12.0".into(),
            installed_version: "0.11.0".into(),
            restart_only: false,
            node: PathBuf::from("/bin/sh"),
            npm: root.join("npm"),
            launcher,
            package_root,
            status_path: root.join("status.json"),
            lock_directory: root.join("updates"),
        };
        Fixture { root, request }
    }
    #[test]
    fn unavailable_or_inexact_release_never_installs_or_stops_the_service() {
        for (spec, reply) in [
            ("@codexhost/cli@0.12.0", "exit 1"),
            ("@codexhost/cli@0.12.0", "exit 0"),
            ("@codexhost/cli-darwin-arm64@0.12.0", "exit 1"),
            ("@codexhost/cli-darwin-arm64@0.12.0", "echo 0.11.0"),
        ] {
            let f = fixture(true);
            f.npm(&format!(
                r#"if [ "$1" = view ]; then
  if [ "$2" = '{spec}' ]; then {reply}; else echo 0.12.0; fi
fi"#
            ));
            let error = apply_locked(&f.request).unwrap_err().to_string();
            assert!(
                error.starts_with(
                    "The requested release is unavailable or npm cannot reach the registry: "
                ),
                "{spec}: {error}"
            );
            let calls = f.calls();
            assert!(calls.contains(&format!(
                "view {spec} version --fetch-retries=0 --fetch-timeout=30000"
            )));
            assert!(!calls.contains("install --global") && !calls.contains("remote stop"));
            assert!(
                !f.request
                    .lock_directory
                    .join("active-update-v1.lock")
                    .exists()
            );
        }
    }
    #[test]
    fn missing_platform_after_install_restores_the_previous_release_before_reporting_failure() {
        for nested in [true, false] {
            let f = fixture(nested);
            f.npm(
                r#"case "$1" in
  view) echo 0.12.0;;
  install)
    case "$*" in
      *@0.12.0*) rm -rf "$nested" "$hoisted";;
      *@0.11.0*)
        case "$*" in *cli-darwin-arm64@*) location=$hoisted;; *) location=$nested;; esac
        write_package "$location" 0.11.0;;
    esac;;
esac"#,
            );
            let error = apply_locked(&f.request).unwrap_err().to_string();
            assert_eq!(
                error,
                "npm installation failed; check remote network access and write permissions: platform package was not installed"
            );
            let calls = f.calls();
            let installs: Vec<_> = calls
                .lines()
                .filter(|call| call.starts_with("install "))
                .collect();
            let expected = ["0.12.0", "0.11.0"].map(|version| {
                let mut args = format!("install --global --no-audit --no-fund --include=optional @codexhost/cli@{version}");
                if !nested {
                    args.push_str(&format!(" @codexhost/{PLATFORM}@{version}"));
                }
                args
            });
            assert_eq!(installs, expected);
            assert_eq!(
                fs::read_to_string(f.request.package_root.join(METADATA))
                    .unwrap()
                    .trim(),
                r#"{"version":"0.11.0"}"#
            );
            assert!(!calls.lines().any(|call| call.starts_with("remote ")));
        }
    }
    #[test]
    fn incomplete_nested_package_shadows_a_complete_hoisted_release() {
        let f = fixture(true);
        f.npm(
            r#"case "$1" in
  view) echo 0.12.0;;
  install)
    case "$*" in
      *@0.12.0*)
        write_package "$nested" 0.12.0
        rm "$nested/app/codexhost-distribution.json"
        write_package "$hoisted" 0.12.0;;
      *@0.11.0*) write_package "$nested" 0.11.0;;
    esac;;
esac"#,
        );
        assert_eq!(
            apply_locked(&f.request).unwrap_err().to_string(),
            format!("{INSTALL_FAILED}: platform package was not installed")
        );
        assert_eq!(
            distribution_version(&f.request.package_root).unwrap(),
            "0.11.0"
        );
        assert!(!f.calls().lines().any(|call| call.starts_with("remote ")));
    }
    #[test]
    fn rejects_a_package_version_that_the_launcher_would_refuse() {
        let f = fixture(true);
        f.npm(
            r#"case "$1" in
  view) echo 0.12.0;;
  install) echo '{"version":"0.12.0"}' > "$nested/app/codexhost-distribution.json";;
esac"#,
        );
        assert_eq!(
            apply_locked(&f.request).unwrap_err().to_string(),
            VERSION_MISMATCH
        );
        assert!(!f.calls().lines().any(|call| call.starts_with("remote ")));
    }
    #[test]
    fn rollback_refreshes_the_manifest_when_the_restored_package_moves() {
        let f = fixture(true);
        f.npm(
            r#"case "$1" in
  view) echo 0.12.0;;
  install)
    case "$*" in
      *@0.12.0*) rm -rf "$nested";;
      *@0.11.0*) write_package "$hoisted" 0.11.0;;
    esac;;
esac"#,
        );
        assert_eq!(
            apply_locked(&f.request).unwrap_err().to_string(),
            format!("{INSTALL_FAILED}: platform package was not installed")
        );
        let calls = f.calls();
        let service_actions: Vec<_> = calls
            .lines()
            .filter(|call| call.starts_with("remote "))
            .collect();
        assert_eq!(service_actions, ["remote install"]);
    }
    #[test]
    fn restarts_after_npm_moves_the_platform_within_the_global_prefix() {
        for nested in [true, false] {
            let mut f = fixture(nested);
            // npm and the runtime may report different spellings of the same prefix.
            std::os::unix::fs::symlink(f.root.join("node_modules"), f.root.join("alias")).unwrap();
            f.request.package_root = f.root.join("alias").join(
                f.request
                    .package_root
                    .strip_prefix(f.root.join("node_modules"))
                    .unwrap(),
            );
            f.npm(
                r#"case "$1" in
  view) echo 0.12.0;;
  install)
    if [ -d "$nested" ]; then rm -rf "$nested"; location=$hoisted
    else rm -rf "$hoisted"; location=$nested; fi
    write_package "$location" 0.12.0;;
esac"#,
            );
            apply_locked(&f.request).unwrap();
            assert!(
                f.calls()
                    .ends_with("remote stop\nremote install\nremote start\n")
            );
        }
    }
    #[test]
    fn missing_metadata_before_install_reports_a_changed_installation() {
        let f = fixture(true);
        fs::remove_file(f.request.package_root.join(METADATA)).unwrap();
        assert_eq!(
            apply_locked(&f.request).unwrap_err().to_string(),
            "The remote installation changed before the update acquired its lock; refresh and retry"
        );
        assert!(f.calls().is_empty());
    }
    #[test]
    fn same_version_restart_skips_npm_and_reinstalls_the_manifest() {
        let mut f = fixture(false);
        f.request.restart_only = true;
        f.request.version.clone_from(&f.request.installed_version);
        apply_locked(&f.request).unwrap();
        assert_eq!(f.calls(), "remote stop\nremote install\nremote start\n");
        let status: serde_json::Value =
            serde_json::from_slice(&fs::read(&f.request.status_path).unwrap()).unwrap();
        assert_eq!(status["phase"], "succeeded");
    }
    #[test]
    fn refuses_concurrent_desktop_update() {
        let f = fixture(false);
        fs::create_dir_all(&f.request.lock_directory).unwrap();
        fs::write(
            f.request.lock_directory.join("active-update-v1.lock"),
            "desktop-owned",
        )
        .unwrap();
        assert!(
            apply_locked(&f.request)
                .unwrap_err()
                .to_string()
                .contains("Another")
        );
        assert!(!f.root.join("calls").exists());
    }
    #[test]
    fn mismatched_installation_is_not_restarted() {
        let mut f = fixture(false);
        f.request.restart_only = true;
        assert!(
            apply_locked(&f.request)
                .unwrap_err()
                .to_string()
                .contains("does not match")
        );
        assert!(!f.root.join("calls").exists());
    }
}
