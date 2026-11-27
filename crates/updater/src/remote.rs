//! npm installation and lifecycle switching for the headless SSH service.
use serde::Deserialize;
use serde_json::json;
use std::{
    error::Error,
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
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
fn run(command: &mut Command) -> Result<(), Box<dyn Error>> {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    let start = Instant::now();
    loop {
        if let Some(status) = child.try_wait()? {
            return if status.success() {
                Ok(())
            } else {
                Err(format!("remote update command failed ({status})").into())
            };
        }
        if start.elapsed() > Duration::from_secs(300) {
            let _ = child.kill();
            let _ = child.wait();
            return Err("remote update command timed out".into());
        }
        thread::sleep(Duration::from_millis(100));
    }
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
    run(Command::new(&request.node)
        .arg(&request.launcher)
        .args(["remote", action]))
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
        let before: serde_json::Value = serde_json::from_slice(&fs::read(
            request.package_root.join("app/codexhost-distribution.json"),
        )?)?;
        if before["version"].as_str() != Some(&request.installed_version) {
            return Err("The remote installation changed before the update acquired its lock; refresh and retry".into());
        }
        if !request.restart_only {
            let layout = crate::npm::global_installation(
                &request.node,
                &request.npm,
                &request.launcher,
                &request.package_root,
            )?
            .ok_or("npm uses a different global installation; update this remote manually")?;
            let specs = layout.required_specs(&request.version);
            for package in &specs {
                run(Command::new(&request.node).arg(&request.npm).args([
                    "cache",
                    "add",
                    package,
                    "--fetch-retries=0",
                    "--fetch-timeout=30000",
                ]))
                .map_err(|error| {
                    format!("Could not download {package} before updating the remote: {error}")
                })?;
            }
            status(request, "installing", None)?;
            let mut command = Command::new(&request.node);
            command
                .arg(&request.npm)
                .args([
                    "install",
                    "--global",
                    "--prefer-offline",
                    "--include=optional",
                    "--no-audit",
                    "--no-fund",
                ])
                .arg(&specs[0]);
            if !layout.uses_nested_platform(&request.package_root) {
                command.arg(&specs[1]);
            }
            run(&mut command).map_err(|error| format!("npm installation failed; check remote network access and write permissions: {error}"))?;
        }
        let metadata: serde_json::Value = serde_json::from_slice(&fs::read(
            request.package_root.join("app/codexhost-distribution.json"),
        )?)?;
        if metadata["version"].as_str() != Some(&request.version) {
            return Err("Installed remote version does not match the requested version".into());
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
    fn fixture(missing_package: Option<&str>) -> Fixture {
        let root = std::env::temp_dir().join(format!(
            "codexhost-remote-updater-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let cli_root = root.join("node_modules/@codexhost/cli");
        let package_root = cli_root.join("node_modules/@codexhost/cli-darwin-arm64");
        let launcher = cli_root.join("bin/codexhost.js");
        fs::create_dir_all(package_root.join("app")).unwrap();
        fs::create_dir_all(launcher.parent().unwrap()).unwrap();
        fs::write(
            package_root.join("app/codexhost-distribution.json"),
            br#"{"version":"0.11.0"}"#,
        )
        .unwrap();
        // Interpret fixture scripts with the installed shell instead of executing a newly
        // written file, which can race with parallel child spawns on Linux (ETXTBSY).
        // These scripts record commands without invoking npm or a real service.
        let source = format!(
            r#"printf '%s\n' "$*" >> '{}'
missing='{}'
case "$1" in
  root) printf '%s\n' '{}' ;;
  cache) [ "$3" != "$missing" ] || exit 1 ;;
  install) [ -z "$missing" ] || rm -f '{}' ;;
esac
exit 0
"#,
            root.join("calls").display(),
            missing_package.unwrap_or_default(),
            root.join("node_modules").display(),
            package_root
                .join("app/codexhost-distribution.json")
                .display(),
        );
        fs::write(root.join("npm"), &source).unwrap();
        fs::write(&launcher, &source).unwrap();
        let request = Request {
            version: "0.11.0".into(),
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
    fn unavailable_release_leaves_the_installation_and_service_untouched() {
        for missing in [
            "@codexhost/cli@0.11.0",
            "@codexhost/cli-darwin-arm64@0.11.0",
        ] {
            let f = fixture(Some(missing));
            let metadata = f
                .request
                .package_root
                .join("app/codexhost-distribution.json");
            let before = fs::read(&metadata).unwrap();
            let error = apply_locked(&f.request).unwrap_err().to_string();
            let calls = fs::read_to_string(f.root.join("calls")).unwrap();
            assert!(
                calls
                    .lines()
                    .all(|call| call.starts_with("root ") || call.starts_with("cache add ")),
                "{calls}"
            );
            assert!(calls.contains(&format!("cache add {missing} ")), "{calls}");
            assert!(error.contains(missing), "unexpected failure: {error}");
            assert_eq!(fs::read(metadata).unwrap(), before);
            assert!(
                !f.request
                    .lock_directory
                    .join("active-update-v1.lock")
                    .exists()
            );
        }
    }
    #[test]
    fn same_version_restart_skips_npm_and_reinstalls_the_manifest() {
        let mut f = fixture(None);
        f.request.restart_only = true;
        apply_locked(&f.request).unwrap();
        assert_eq!(
            fs::read_to_string(f.root.join("calls")).unwrap(),
            "remote stop\nremote install\nremote start\n"
        );
        let status: serde_json::Value =
            serde_json::from_slice(&fs::read(&f.request.status_path).unwrap()).unwrap();
        assert_eq!(status["phase"], "succeeded");
    }
    #[test]
    fn prepares_both_packages_and_preserves_the_nested_payload_path() {
        let f = fixture(None);
        apply_locked(&f.request).unwrap();
        let calls = fs::read_to_string(f.root.join("calls")).unwrap();
        assert_eq!(
            calls.lines().collect::<Vec<_>>(),
            [
                "root --global",
                "cache add @codexhost/cli@0.11.0 --fetch-retries=0 --fetch-timeout=30000",
                "cache add @codexhost/cli-darwin-arm64@0.11.0 --fetch-retries=0 --fetch-timeout=30000",
                "install --global --prefer-offline --include=optional --no-audit --no-fund @codexhost/cli@0.11.0",
                "remote stop",
                "remote install",
                "remote start",
            ],
        );
    }
    #[test]
    fn refuses_concurrent_desktop_update() {
        let f = fixture(None);
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
        let mut f = fixture(None);
        f.request.restart_only = true;
        f.request.version = "0.12.0".into();
        assert!(
            apply_locked(&f.request)
                .unwrap_err()
                .to_string()
                .contains("does not match")
        );
        assert!(!f.root.join("calls").exists());
    }
}
