//! npm installation and lifecycle switching for the headless SSH service.
use serde::Deserialize;
use serde_json::json;
use std::{
    error::Error,
    fs,
    io::{self, Read},
    path::{Path, PathBuf},
    process::{Command, ExitStatus, Stdio},
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
enum CommandFailure {
    TimedOut,
    Exited { status: ExitStatus, stderr: String },
}
fn read_tail(mut input: impl Read) -> io::Result<Vec<u8>> {
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
fn run_with_stderr(command: &mut Command) -> Result<Result<(), CommandFailure>, Box<dyn Error>> {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()?;
    let stderr = child
        .stderr
        .take()
        .map(|pipe| thread::spawn(move || read_tail(pipe)));
    let start = Instant::now();
    loop {
        if let Some(status) = child.try_wait()? {
            let text = stderr
                .and_then(|handle| handle.join().ok())
                .and_then(Result::ok)
                .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
                .unwrap_or_default();
            return Ok(if status.success() {
                Ok(())
            } else {
                Err(CommandFailure::Exited {
                    status,
                    stderr: text,
                })
            });
        }
        if start.elapsed() > Duration::from_secs(300) {
            let _ = child.kill();
            let _ = child.wait();
            if let Some(handle) = stderr {
                let _ = handle.join();
            }
            return Ok(Err(CommandFailure::TimedOut));
        }
        thread::sleep(Duration::from_millis(100));
    }
}
fn run(command: &mut Command) -> Result<(), Box<dyn Error>> {
    match run_with_stderr(command)? {
        Ok(()) => Ok(()),
        Err(CommandFailure::TimedOut) => Err("remote update command timed out".into()),
        Err(CommandFailure::Exited { status, .. }) => {
            Err(format!("remote update command failed ({status})").into())
        }
    }
}
fn has_word(text: &str, needle: &str) -> bool {
    let bytes = text.as_bytes();
    let is_word = |byte: u8| byte.is_ascii_alphanumeric() || byte == b'_';
    text.match_indices(needle).any(|(start, _)| {
        let left_ok = start == 0 || !is_word(bytes[start - 1]);
        let end = start + needle.len();
        let right_ok = end == bytes.len() || !is_word(bytes[end]);
        left_ok && right_ok
    })
}
fn missing_from_registry(stderr: &str) -> bool {
    has_word(stderr, "E404") || has_word(stderr, "ETARGET")
}
fn is_timeout_error(stderr: &str) -> bool {
    has_word(stderr, "ETIMEDOUT")
        || has_word(stderr, "ESOCKETTIMEDOUT")
        || has_word(stderr, "ERR_SOCKET_TIMEOUT")
        || stderr.to_ascii_lowercase().contains("network timeout")
}
fn read_distribution(package_root: &Path) -> Result<serde_json::Value, Box<dyn Error>> {
    let path = package_root.join("app/codexhost-distribution.json");
    let bytes = fs::read(&path).map_err(|error| {
        if error.kind() == io::ErrorKind::NotFound {
            format!(
                "The remote platform package is missing; reinstall codexhost on the remote computer: {}",
                path.display()
            )
        } else {
            error.to_string()
        }
    })?;
    Ok(serde_json::from_slice(&bytes)?)
}
fn prefetch_package(request: &Request, package: &str) -> Result<(), Box<dyn Error>> {
    let mut command = Command::new(&request.node);
    command.arg(&request.npm).args([
        "cache",
        "add",
        package,
        "--fetch-retries=0",
        "--fetch-timeout=30000",
    ]);
    match run_with_stderr(&mut command)? {
        Ok(()) => Ok(()),
        Err(CommandFailure::TimedOut) => Err(format!(
            "Checking or downloading the release from npm timed out; retry later: {package}"
        )
        .into()),
        Err(CommandFailure::Exited { status, stderr }) => {
            if missing_from_registry(&stderr) {
                Err(format!(
                    "The requested release packages are not all available on npm yet; retry later: {package} ({status})"
                )
                .into())
            } else if is_timeout_error(&stderr) {
                Err(format!(
                    "Checking or downloading the release from npm timed out; retry later: {package} ({status})"
                )
                .into())
            } else {
                Err(format!(
                    "The requested release is unavailable or npm cannot reach the registry: {package} ({status})"
                )
                .into())
            }
        }
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
        let before = read_distribution(&request.package_root)?;
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
                prefetch_package(request, package)?;
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
        let metadata = read_distribution(&request.package_root)?;
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
    struct FixtureOptions<'a> {
        nested: bool,
        cache_failure: Option<(&'a str, &'a str)>,
        drop_distribution_on_install: bool,
    }
    fn fixture(options: FixtureOptions<'_>) -> Fixture {
        let root = std::env::temp_dir().join(format!(
            "codexhost-remote-updater-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let cli_root = root.join("node_modules/@codexhost/cli");
        let package_root = if options.nested {
            cli_root.join("node_modules/@codexhost/cli-darwin-arm64")
        } else {
            root.join("node_modules/@codexhost/cli-darwin-arm64")
        };
        let launcher = cli_root.join("bin/codexhost.js");
        fs::create_dir_all(package_root.join("app")).unwrap();
        fs::create_dir_all(launcher.parent().unwrap()).unwrap();
        fs::write(
            package_root.join("app/codexhost-distribution.json"),
            br#"{"version":"0.11.0"}"#,
        )
        .unwrap();
        let (missing_package, cache_stderr) = options.cache_failure.unwrap_or(("", ""));
        // Interpret fixture scripts with the installed shell instead of executing a newly
        // written file, which can race with parallel child spawns on Linux (ETXTBSY).
        // These scripts record commands without invoking npm or a real service.
        let source = format!(
            r#"printf '%s\n' "$*" >> '{}'
missing='{}'
cache_stderr='{}'
drop_dist='{}'
case "$1" in
  root) printf '%s\n' '{}' ;;
  cache)
    if [ "$3" = "$missing" ]; then
      printf '%s\n' "$cache_stderr" >&2
      exit 1
    fi
    ;;
  install)
    if [ "$drop_dist" = 1 ]; then
      rm -f '{}'
    fi
    ;;
esac
exit 0
"#,
            root.join("calls").display(),
            missing_package,
            cache_stderr,
            if options.drop_distribution_on_install {
                "1"
            } else {
                "0"
            },
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
            let mut f = fixture(FixtureOptions {
                nested: true,
                cache_failure: Some((missing, "npm error code E404")),
                drop_distribution_on_install: false,
            });
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
            assert!(
                error.starts_with(
                    "The requested release packages are not all available on npm yet; retry later:"
                ),
                "unexpected failure: {error}"
            );
            assert!(error.contains(missing), "unexpected failure: {error}");
            assert_eq!(fs::read(&metadata).unwrap(), before);
            assert!(
                !f.request
                    .lock_directory
                    .join("active-update-v1.lock")
                    .exists()
            );
            // The preserved installation must still be able to restart cleanly.
            f.request.restart_only = true;
            apply_locked(&f.request).unwrap();
        }
    }
    #[test]
    fn prefetch_timeout_and_registry_errors_are_classified_separately() {
        for (stderr, expected_prefix) in [
            (
                "npm error code ETIMEDOUT",
                "Checking or downloading the release from npm timed out; retry later:",
            ),
            (
                "npm error code ECONNREFUSED",
                "The requested release is unavailable or npm cannot reach the registry:",
            ),
        ] {
            let f = fixture(FixtureOptions {
                nested: true,
                cache_failure: Some(("@codexhost/cli-darwin-arm64@0.11.0", stderr)),
                drop_distribution_on_install: false,
            });
            let error = apply_locked(&f.request).unwrap_err().to_string();
            assert!(
                error.starts_with(expected_prefix),
                "stderr={stderr}, got={error}"
            );
            let calls = fs::read_to_string(f.root.join("calls")).unwrap();
            assert!(!calls.contains("install "), "{calls}");
            assert!(!calls.contains("remote "), "{calls}");
        }
    }
    #[test]
    fn same_version_restart_skips_npm_and_reinstalls_the_manifest() {
        let mut f = fixture(FixtureOptions {
            nested: true,
            cache_failure: None,
            drop_distribution_on_install: false,
        });
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
    fn prepares_both_packages_and_preserves_each_layout() {
        for (nested, expected_install) in [
            (
                true,
                "install --global --prefer-offline --include=optional --no-audit --no-fund @codexhost/cli@0.11.0",
            ),
            (
                false,
                "install --global --prefer-offline --include=optional --no-audit --no-fund @codexhost/cli@0.11.0 @codexhost/cli-darwin-arm64@0.11.0",
            ),
        ] {
            let f = fixture(FixtureOptions {
                nested,
                cache_failure: None,
                drop_distribution_on_install: false,
            });
            apply_locked(&f.request).unwrap();
            let calls = fs::read_to_string(f.root.join("calls")).unwrap();
            assert_eq!(
                calls.lines().collect::<Vec<_>>(),
                [
                    "root --global",
                    "cache add @codexhost/cli@0.11.0 --fetch-retries=0 --fetch-timeout=30000",
                    "cache add @codexhost/cli-darwin-arm64@0.11.0 --fetch-retries=0 --fetch-timeout=30000",
                    expected_install,
                    "remote stop",
                    "remote install",
                    "remote start",
                ],
                "nested={nested}"
            );
        }
    }
    #[test]
    fn missing_platform_package_after_install_reports_clear_error() {
        let f = fixture(FixtureOptions {
            nested: true,
            cache_failure: None,
            drop_distribution_on_install: true,
        });
        let error = apply_locked(&f.request).unwrap_err().to_string();
        assert!(
            error.starts_with(
                "The remote platform package is missing; reinstall codexhost on the remote computer:"
            ),
            "unexpected error: {error}"
        );
        let calls = fs::read_to_string(f.root.join("calls")).unwrap();
        assert!(!calls.contains("remote "), "{calls}");
    }
    #[test]
    fn refuses_concurrent_desktop_update() {
        let f = fixture(FixtureOptions {
            nested: true,
            cache_failure: None,
            drop_distribution_on_install: false,
        });
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
        let mut f = fixture(FixtureOptions {
            nested: true,
            cache_failure: None,
            drop_distribution_on_install: false,
        });
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
