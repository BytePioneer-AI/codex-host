#![forbid(unsafe_code)]

mod handoff;
mod install;
mod prepare_install;
mod remote;
mod request;
mod restart;
mod services;
mod ssh;
mod status;

use std::env;
use std::error::Error;
use std::path::Path;
use std::process::ExitCode;
use std::thread;
use std::time::{Duration, Instant};

use codexhost_platform::process_executable_path;
#[cfg(not(target_os = "windows"))]
use codexhost_platform::{PlatformError, process_exists, process_snapshot};
#[cfg(target_os = "windows")]
use codexhost_platform::{process_instance_exists, process_started_at_micros};
use codexhost_updater::UpdateHandoff;

use install::install;
use request::UpdateRequest;
use status::write_status;

const WAIT_TIMEOUT: Duration = Duration::from_secs(180);
fn same_executable(left: &Path, right: &Path) -> bool {
    let normalize = |path: &Path| {
        let value = path.to_string_lossy().replace('/', "\\");
        if cfg!(target_os = "windows") {
            value.to_lowercase()
        } else {
            value
        }
    };
    normalize(left) == normalize(right)
}

/// Start time of the live process `process_id`, or `None` once it has exited.
/// Inspection failure while the PID still exists is an error, never an exit.
#[cfg(not(target_os = "windows"))]
fn process_started_at_micros(process_id: u32) -> Result<Option<u64>, PlatformError> {
    match process_snapshot(process_id) {
        Ok(snapshot) => Ok(Some(snapshot.started_at_micros)),
        Err(_) if !process_exists(process_id) => Ok(None),
        Err(error) => Err(error),
    }
}

/// Whether the exact process instance that started at `started_at_micros` is
/// still live, so a reused PID is not mistaken for the waiting Launcher.
#[cfg(not(target_os = "windows"))]
fn process_instance_exists(process_id: u32, started_at_micros: u64) -> Result<bool, PlatformError> {
    Ok(process_started_at_micros(process_id)? == Some(started_at_micros))
}

fn wait_for_launcher_exit(request: &UpdateRequest) -> Result<(), Box<dyn Error>> {
    #[cfg(target_os = "windows")]
    let launcher_started_at = process_started_at_micros(request.wait_pid)?;
    #[cfg(not(target_os = "windows"))]
    let Some(launcher_started_at) = process_started_at_micros(request.wait_pid)? else {
        return Err("Launcher exited before the background Updater started".into());
    };
    if !process_instance_exists(request.wait_pid, launcher_started_at)? {
        return Err("Launcher exited before the background Updater started".into());
    }
    let expected = request.wait_executable.canonicalize()?;
    let actual = process_executable_path(request.wait_pid)?.canonicalize()?;
    if !same_executable(&expected, &actual) {
        return Err(format!(
            "refusing update because PID {} is not the expected Launcher",
            request.wait_pid
        )
        .into());
    }
    if !process_instance_exists(request.wait_pid, launcher_started_at)? {
        return Err("Launcher exited before the background Updater was ready".into());
    }
    // This is the handoff acknowledgement: publish readiness only after
    // confirming this is the exact live Launcher, not merely that it spawned us.
    write_status(request, "waiting-for-exit", None, None)?;
    if request.service_managed {
        return handoff::wait_for_ownership(&request.status_path, Duration::from_secs(10));
    }
    let started = Instant::now();
    loop {
        if !process_instance_exists(request.wait_pid, launcher_started_at)? {
            break;
        }
        if started.elapsed() >= WAIT_TIMEOUT {
            return Err("Launcher did not exit before the update timeout".into());
        }
        thread::sleep(Duration::from_millis(100));
    }
    Ok(())
}

fn wait_for_authorized_launcher_exit(
    request: &UpdateRequest,
    request_path: &Path,
    handoff: Option<&UpdateHandoff>,
) -> Result<(), Box<dyn Error>> {
    // A service-managed Updater stops the services itself after ownership is
    // transferred; only a Desktop Launcher handoff carries cleanup authorization.
    if cfg!(any(target_os = "macos", target_os = "windows"))
        && !request.service_managed
        && handoff.is_none()
    {
        return Err("update handoff token is required".into());
    }
    wait_for_launcher_exit(request)?;
    if let Some(handoff) = handoff {
        handoff.verify(request_path)?;
    }
    Ok(())
}

fn apply(request_path: &Path, handoff: Option<&UpdateHandoff>) -> Result<(), Box<dyn Error>> {
    let request = UpdateRequest::parse(request_path)?;
    let _independent = request
        .service_managed
        .then(codexhost_platform::register_independent_service)
        .transpose()?;
    let mut service_stop_output = None;
    let mut stopping_started = false;
    let result = (|| -> Result<(), Box<dyn Error>> {
        wait_for_authorized_launcher_exit(&request, request_path, handoff)?;
        stopping_started = true;
        service_stop_output = services::stop(&request)?;
        write_status(&request, "installing", None, service_stop_output.as_deref())?;
        install(&request)?;
        write_status(&request, "restarting", None, service_stop_output.as_deref())?;
        restart::restore(&request, Some(&request.version))?;
        write_status(&request, "succeeded", None, service_stop_output.as_deref())?;
        Ok(())
    })();
    if let Err(error) = &result {
        let mut message = error.to_string();
        if stopping_started {
            match restart::restore(&request, None) {
                Ok(()) => message.push_str("; service recovery succeeded"),
                Err(recovery) => {
                    message.push_str(&format!("; service recovery failed: {recovery}"))
                }
            }
        }
        let _ = write_status(
            &request,
            "failed",
            Some(&message),
            service_stop_output.as_deref(),
        );
    }
    result
}

fn usage() {
    eprintln!(
        "usage: codexhost-updater apply --request <absolute-json-file> [--handoff-token <token>]\n       codexhost-updater prepare-install --install-root <absolute-directory>"
    );
}

fn run(arguments: &[String]) -> Result<(), Box<dyn Error>> {
    if arguments.len() == 3 && arguments[0] == "prepare-install" && arguments[1] == "--install-root"
    {
        return prepare_install::prepare(Path::new(&arguments[2]));
    }
    if arguments == ["ssh"] {
        return ssh::apply();
    }
    if arguments.len() == 3 && arguments[0] == "remote" && arguments[1] == "--request" {
        return remote::apply(Path::new(&arguments[2]));
    }
    let handoff = match arguments {
        [command, flag, _, token_flag, token]
            if command == "apply" && flag == "--request" && token_flag == "--handoff-token" =>
        {
            Some(UpdateHandoff::from_token(token)?)
        }
        [command, flag, _] if command == "apply" && flag == "--request" => None,
        _ => {
            usage();
            return Err("invalid updater arguments".into());
        }
    };
    apply(Path::new(&arguments[2]), handoff.as_ref())
}

fn main() -> ExitCode {
    let arguments = env::args().skip(1).collect::<Vec<_>>();
    match run(&arguments) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("codexhost updater: {error}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::request::{Installation, NpmInstallation, UpdateRequest};
    use super::{wait_for_authorized_launcher_exit, wait_for_launcher_exit};
    use codexhost_updater::UpdateHandoff;
    use std::fs;
    use std::path::Path;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{Duration, Instant};

    static NEXT_FIXTURE_ID: AtomicU64 = AtomicU64::new(0);

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn binds_the_launcher_wait_to_its_process_start_time() {
        let pid = std::process::id();
        let started_at = super::process_started_at_micros(pid)
            .expect("inspect current process")
            .expect("current process is live");
        assert!(super::process_instance_exists(pid, started_at).expect("same instance"));
        // A reused PID has a different start time and must count as an exit.
        assert!(
            !super::process_instance_exists(pid, started_at.wrapping_add(1))
                .expect("different instance")
        );
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn reports_an_exited_process_as_gone() {
        let mut child = std::process::Command::new("true")
            .spawn()
            .expect("spawn short-lived child");
        let pid = child.id();
        child.wait().expect("reap child");
        assert_eq!(
            super::process_started_at_micros(pid).expect("inspect exited PID"),
            None
        );
    }

    #[test]
    fn does_not_acknowledge_handoff_before_owner_identity_is_validated() {
        let directory =
            std::env::temp_dir().join(format!("codexhost-handoff-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let wrong_executable = directory.join("not-the-owner");
        std::fs::write(&wrong_executable, "fixture").unwrap();
        let status_path = directory.join("status.json");
        std::fs::write(&status_path, "prepared").unwrap();
        let request = UpdateRequest {
            schema_version: 1,
            version: "1.0.0".into(),
            wait_pid: std::process::id(),
            wait_executable: wrong_executable.clone(),
            runtime_descriptor_path: directory.join("runtime.json"),
            restart_target: Default::default(),
            data_directory: None,
            service_managed: false,
            status_path: status_path.clone(),
            installation: Installation::Npm(NpmInstallation {
                node_path: wrong_executable.clone(),
                npm_cli_path: wrong_executable.clone(),
                npm_launcher_path: wrong_executable,
                npm_package_root: directory.clone(),
            }),
        };
        let error = wait_for_launcher_exit(&request).unwrap_err();
        assert!(error.to_string().contains("not the expected Launcher"));
        assert_eq!(std::fs::read_to_string(status_path).unwrap(), "prepared");
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn does_not_report_ready_for_an_exited_launcher() {
        let status_path = std::env::temp_dir().join(format!(
            "codexhost-unpublished-update-status-{}.json",
            std::process::id()
        ));
        let request = UpdateRequest {
            schema_version: 1,
            version: "1.2.3".into(),
            wait_pid: u32::MAX,
            wait_executable: std::env::current_exe().expect("test executable"),
            runtime_descriptor_path: status_path.clone(),
            restart_target: Default::default(),
            data_directory: None,
            service_managed: false,
            status_path: status_path.clone(),
            installation: Installation::Npm(NpmInstallation {
                node_path: status_path.clone(),
                npm_cli_path: status_path.clone(),
                npm_launcher_path: status_path.clone(),
                npm_package_root: status_path.clone(),
            }),
        };

        assert!(wait_for_launcher_exit(&request).is_err());
        assert!(!status_path.exists());
    }

    enum CleanupAuthorization {
        Missing,
        MissingDuringApply,
        Current,
        Previous,
        Partial,
    }

    fn check_launcher_exit_authorization(authorization: CleanupAuthorization) {
        const TOKEN: &str = "0123456789abcdef0123456789abcdef";
        let authorized = matches!(authorization, CleanupAuthorization::Current);
        let run_apply = matches!(authorization, CleanupAuthorization::MissingDuringApply);
        let root = loop {
            let id = NEXT_FIXTURE_ID.fetch_add(1, Ordering::Relaxed);
            let root = std::env::temp_dir().join(format!(
                "codexhost-authorized-exit-{}-{id}",
                std::process::id()
            ));
            match fs::create_dir(&root) {
                Ok(()) => break root,
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => panic!("failed to create Launcher fixture: {error}"),
            }
        };
        let fixture_executable = if cfg!(target_os = "windows") {
            "ping"
        } else {
            "/bin/sleep"
        };
        let mut command = std::process::Command::new(fixture_executable);
        if cfg!(target_os = "windows") {
            command.args(["-n", "60", "127.0.0.1"]);
        } else {
            command.arg("60");
        }
        #[cfg(target_os = "windows")]
        codexhost_platform::configure_background_command(&mut command);
        let mut launcher = command
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("spawn Launcher fixture");
        let request_path = root.join("request-v1.json");
        let status_path = root.join("status-v1.json");
        let install_sentinel = root.join("installation-started");
        let wait_executable = if cfg!(target_os = "windows") {
            codexhost_platform::process_executable_path(launcher.id()).unwrap()
        } else {
            Path::new(fixture_executable).canonicalize().unwrap()
        };
        #[cfg(unix)]
        {
            // spawn can return before exec is visible to process inspection.
            // Wait for the known fixture image before exercising the Updater's
            // strict identity check, just as for an already-running Launcher.
            let started = Instant::now();
            loop {
                let actual = codexhost_platform::process_executable_path(launcher.id())
                    .ok()
                    .and_then(|path| path.canonicalize().ok());
                if actual.as_ref() == Some(&wait_executable) {
                    break;
                }
                if launcher
                    .try_wait()
                    .expect("inspect Launcher fixture")
                    .is_some()
                    || started.elapsed() >= Duration::from_secs(15)
                {
                    let _ = launcher.kill();
                    let _ = launcher.wait();
                    let _ = fs::remove_dir_all(&root);
                    panic!(
                        "Launcher fixture did not exec {wait_executable:?}; observed {actual:?}"
                    );
                }
                std::thread::sleep(Duration::from_millis(1));
            }
        }
        let request = UpdateRequest {
            schema_version: 1,
            version: "1.2.3".into(),
            wait_pid: launcher.id(),
            wait_executable,
            runtime_descriptor_path: root.join("runtime.json"),
            restart_target: Default::default(),
            data_directory: None,
            service_managed: false,
            status_path: status_path.clone(),
            installation: Installation::Npm(NpmInstallation {
                node_path: root.join("unused-node"),
                npm_cli_path: root.join("unused-npm"),
                npm_launcher_path: root.join("unused-launcher"),
                npm_package_root: root.join("unused-package"),
            }),
        };
        if run_apply {
            let Installation::Npm(npm) = &request.installation else {
                unreachable!("the fixture uses npm metadata");
            };
            // Satisfy request validation with inert local files. No npm or
            // installer can run even if a regression bypasses the gate.
            for path in [&npm.node_path, &npm.npm_cli_path, &npm.npm_launcher_path] {
                fs::write(path, b"inert fixture").unwrap();
            }
            fs::write(
                &request_path,
                serde_json::to_vec(&serde_json::json!({
                    "schema_version": request.schema_version,
                    "version": request.version,
                    "wait_pid": request.wait_pid,
                    "wait_executable": request.wait_executable,
                    "runtime_descriptor_path": request.runtime_descriptor_path,
                    "status_path": request.status_path,
                    "installation": {
                        "kind": "npm",
                        "node_path": npm.node_path,
                        "npm_cli_path": npm.npm_cli_path,
                        "npm_launcher_path": npm.npm_launcher_path,
                        "npm_package_root": npm.npm_package_root,
                    },
                }))
                .unwrap(),
            )
            .unwrap();
        }
        let worker_request = request_path.clone();
        let worker_sentinel = install_sentinel.clone();
        let worker = std::thread::spawn(move || {
            let handoff = UpdateHandoff::from_token(TOKEN).unwrap();
            if run_apply {
                super::apply(&worker_request, Some(&handoff))
            } else {
                wait_for_authorized_launcher_exit(&request, &worker_request, Some(&handoff))
            }
            .map_err(|error| error.to_string())?;
            // Represent entry into installation without launching npm or an installer.
            fs::write(worker_sentinel, b"authorized").map_err(|error| error.to_string())
        });
        let started = Instant::now();
        loop {
            let status = fs::read(&status_path)
                .ok()
                .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok());
            if status.is_some_and(|status| status["phase"] == "waiting-for-exit") {
                break;
            }
            if worker.is_finished() {
                let result = worker.join().expect("join early Helper exit");
                let _ = launcher.kill();
                let _ = launcher.wait();
                let _ = fs::remove_dir_all(&root);
                panic!("Helper exited before waiting-for-exit: {result:?}");
            }
            assert!(
                started.elapsed() < Duration::from_secs(15),
                "Helper did not reach waiting-for-exit within 15 seconds; status: {:?}",
                fs::read_to_string(&status_path)
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(
            !worker.is_finished(),
            "authorization must wait for the Launcher to exit"
        );
        assert!(!install_sentinel.exists());
        match authorization {
            CleanupAuthorization::Missing | CleanupAuthorization::MissingDuringApply => {}
            CleanupAuthorization::Current | CleanupAuthorization::Partial => {
                UpdateHandoff::from_token(TOKEN)
                    .unwrap()
                    .publish(&request_path)
                    .unwrap();
                if matches!(authorization, CleanupAuthorization::Partial) {
                    fs::write(root.join("cleanup-complete-v1"), &TOKEN[..16])
                        .expect("simulate an incomplete authorization write");
                }
            }
            CleanupAuthorization::Previous => {
                UpdateHandoff::from_token("fedcba9876543210fedcba9876543210")
                    .unwrap()
                    .publish(&request_path)
                    .unwrap();
            }
        }
        assert!(
            !install_sentinel.exists(),
            "authorization alone must not start installation"
        );
        launcher.kill().expect("simulate Launcher exit");
        launcher.wait().expect("reap Launcher fixture");
        let result = worker.join().expect("join authorization check");
        assert_eq!(
            result.is_ok(),
            authorized,
            "unexpected gate result: {result:?}"
        );
        assert_eq!(install_sentinel.exists(), authorized);
        let status: serde_json::Value =
            serde_json::from_slice(&fs::read(&status_path).unwrap()).unwrap();
        if run_apply {
            assert_eq!(status["phase"], "failed");
            let expected = fs::symlink_metadata(root.join("cleanup-complete-v1"))
                .unwrap_err()
                .to_string();
            assert_eq!(result.unwrap_err(), expected);
            assert_eq!(status["error"], expected);
        } else {
            assert_eq!(status["phase"], "waiting-for-exit");
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn an_unexpected_launcher_exit_does_not_authorize_installation() {
        check_launcher_exit_authorization(CleanupAuthorization::Missing);
    }

    #[test]
    fn cleanup_authorization_only_allows_installation_after_launcher_exit() {
        check_launcher_exit_authorization(CleanupAuthorization::Current);
    }

    #[test]
    fn a_previous_helpers_authorization_does_not_allow_installation_after_launcher_exit() {
        check_launcher_exit_authorization(CleanupAuthorization::Previous);
    }

    #[test]
    fn partial_cleanup_authorization_does_not_allow_installation_after_launcher_exit() {
        check_launcher_exit_authorization(CleanupAuthorization::Partial);
    }

    #[test]
    fn apply_records_failure_when_the_launcher_exits_without_cleanup_authorization() {
        check_launcher_exit_authorization(CleanupAuthorization::MissingDuringApply);
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    #[test]
    fn desktop_handoffs_require_a_token_and_service_handoffs_do_not() {
        let root = std::env::temp_dir().join(format!(
            "codexhost-token-required-{}-{}",
            std::process::id(),
            NEXT_FIXTURE_ID.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).unwrap();
        let status_path = root.join("status-v1.json");
        let mut request = UpdateRequest {
            schema_version: 1,
            version: "1.2.3".into(),
            wait_pid: u32::MAX,
            wait_executable: std::env::current_exe().expect("test executable"),
            runtime_descriptor_path: root.join("runtime.json"),
            restart_target: Default::default(),
            data_directory: Some(root.clone()),
            service_managed: false,
            status_path: status_path.clone(),
            installation: Installation::Npm(NpmInstallation {
                node_path: status_path.clone(),
                npm_cli_path: status_path.clone(),
                npm_launcher_path: status_path.clone(),
                npm_package_root: root.clone(),
            }),
        };
        let request_path = root.join("request-v1.json");
        assert_eq!(
            wait_for_authorized_launcher_exit(&request, &request_path, None)
                .unwrap_err()
                .to_string(),
            "update handoff token is required"
        );
        request.service_managed = true;
        // The service path proceeds to the Launcher identity check instead.
        let error = wait_for_authorized_launcher_exit(&request, &request_path, None)
            .unwrap_err()
            .to_string();
        assert_ne!(error, "update handoff token is required");
        assert!(!status_path.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    #[test]
    fn command_line_rejects_invalid_handoff_tokens() {
        let arguments = [
            "apply",
            "--request",
            "unused-request.json",
            "--handoff-token",
            "invalid",
        ]
        .map(String::from);
        assert!(
            super::run(&arguments)
                .unwrap_err()
                .to_string()
                .contains("32 lowercase hexadecimal")
        );
    }
}
