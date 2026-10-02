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
fn status(request: &Request, phase: &str, error: Option<String>) -> Result<(), Box<dyn Error>> {
    let temporary = request.status_path.with_extension("tmp");
    fs::write(
        &temporary,
        serde_json::to_vec(
            &json!({"phase":phase,"targetVersion":request.version,"error":error,"updaterPid":std::process::id()}),
        )?,
    )?;
    fs::rename(temporary, &request.status_path)?;
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
    let result = apply_locked(&request);
    if let Err(error) = &result {
        let _ = status(&request, "failed", Some(error.to_string()));
    }
    result
}
fn apply_locked(request: &Request) -> Result<(), Box<dyn Error>> {
    fs::create_dir_all(&request.lock_directory)?;
    let lock = request.lock_directory.join("active-update-v1.lock");
    // Same lock as Desktop's updater; never install into one npm prefix concurrently.
    if let Ok(bytes) = fs::read(&lock) {
        if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) {
            if value["remoteUpdate"].as_bool() == Some(true) {
                if let Some(pid) = value["ownerPid"]
                    .as_u64()
                    .and_then(|pid| u32::try_from(pid).ok())
                {
                    if pid > 0 && !codexhost_platform::process_exists(pid) {
                        let _ = fs::remove_file(&lock);
                    }
                }
            }
        }
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
        let before: serde_json::Value = serde_json::from_slice(&fs::read(
            request.package_root.join("app/codexhost-distribution.json"),
        )?)?;
        if before["version"].as_str() != Some(&request.installed_version) {
            return Err("The remote installation changed before the update acquired its lock; refresh and retry".into());
        }
        if !request.restart_only {
            // Check that npm belongs to the installation being replaced, not another Node prefix.
            let output = Command::new(&request.node)
                .arg(&request.npm)
                .args(["root", "--global"])
                .output()?;
            if !output.status.success() {
                return Err("Could not identify the global npm installation".into());
            }
            let prefix = PathBuf::from(String::from_utf8(output.stdout)?.trim());
            let global_platform =
                request.package_root.parent().and_then(Path::parent) == Some(prefix.as_path());
            let launcher_root = request
                .launcher
                .parent()
                .and_then(Path::parent)
                .ok_or("Invalid npm launcher path")?;
            if !global_platform
                && !(launcher_root.parent().and_then(Path::parent) == Some(prefix.as_path())
                    && request
                        .package_root
                        .starts_with(launcher_root.join("node_modules")))
            {
                return Err(
                    "npm uses a different global installation; update this remote manually".into(),
                );
            }
            let package = format!("@codexhost/cli@{}", request.version);
            // Unpublished local builds fail here, before touching the installation or service.
            run(Command::new(&request.node).arg(&request.npm).args([
                "view",
                &package,
                "version",
                "--fetch-retries=0",
                "--fetch-timeout=30000",
            ]))
            .map_err(|error| {
                format!(
                    "The requested release is unavailable or npm cannot reach the registry: {error}"
                )
            })?;
            status(request, "installing", None)?;
            let mut command = Command::new(&request.node);
            command.arg(&request.npm).args([
                "install",
                "--global",
                "--no-audit",
                "--no-fund",
                &package,
            ]);
            if global_platform {
                let name = request
                    .package_root
                    .file_name()
                    .and_then(|name| name.to_str())
                    .ok_or("Invalid platform package path")?;
                if ![
                    "cli-darwin-arm64",
                    "cli-darwin-x64",
                    "cli-linux-arm64",
                    "cli-linux-x64",
                ]
                .contains(&name)
                {
                    return Err("Unknown remote platform package".into());
                }
                command.arg(format!("@codexhost/{name}@{}", request.version));
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
    use std::os::unix::fs::PermissionsExt;
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
    fn fixture(view_failure: bool) -> Fixture {
        let root = std::env::temp_dir().join(format!(
            "codexhost-remote-updater-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let package_root = root.join("node_modules/@codexhost/cli-darwin-arm64");
        fs::create_dir_all(package_root.join("app")).unwrap();
        fs::write(
            package_root.join("app/codexhost-distribution.json"),
            br#"{"version":"0.11.0"}"#,
        )
        .unwrap();
        let node = root.join("node");
        // This fixture records commands; it never invokes npm or a real service.
        fs::write(&node, format!("#!/bin/sh\necho \"$2\" >> '{}'\nif [ \"$2\" = root ]; then echo '{}'; fi\nif [ \"$2\" = view ]; then exit {}; fi\nexit 0\n", root.join("calls").display(), root.join("node_modules").display(), if view_failure {1} else {0})).unwrap();
        fs::set_permissions(&node, fs::Permissions::from_mode(0o700)).unwrap();
        let request = Request {
            version: "0.11.0".into(),
            installed_version: "0.11.0".into(),
            restart_only: false,
            node,
            npm: root.join("npm"),
            launcher: root.join("launcher"),
            package_root,
            status_path: root.join("status.json"),
            lock_directory: root.join("updates"),
        };
        Fixture { root, request }
    }
    #[test]
    fn unavailable_release_never_stops_the_service() {
        let f = fixture(true);
        assert!(apply_locked(&f.request).is_err());
        let calls = fs::read_to_string(f.root.join("calls")).unwrap();
        assert_eq!(calls, "root\nview\n");
        assert!(
            !f.request
                .lock_directory
                .join("active-update-v1.lock")
                .exists()
        );
    }
    #[test]
    fn same_version_restart_skips_npm_and_reinstalls_the_manifest() {
        let mut f = fixture(false);
        f.request.restart_only = true;
        apply_locked(&f.request).unwrap();
        assert_eq!(
            fs::read_to_string(f.root.join("calls")).unwrap(),
            "remote\nremote\nremote\n"
        );
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
