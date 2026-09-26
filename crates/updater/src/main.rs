#![forbid(unsafe_code)]

mod install;
mod request;
mod status;

use std::env;
use std::error::Error;
use std::fs;
use std::path::Path;
use std::process::ExitCode;
use std::thread;
use std::time::{Duration, Instant};

use codexhost_platform::{process_executable_path, process_exists};
#[cfg(target_os = "windows")]
use codexhost_platform::{process_instance_exists, process_started_at_micros};
use codexhost_updater::UpdateHandoff;
use serde::Deserialize;

use install::{install, relaunch};
use request::UpdateRequest;
use status::write_status;

const WAIT_TIMEOUT: Duration = Duration::from_secs(180);
const RELAUNCH_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_RUNTIME_DESCRIPTOR_BYTES: u64 = 4 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RuntimeDescriptorProbe {
    schema_version: u8,
    launcher_pid: u32,
    control_port: u16,
    nonce: String,
}

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

fn wait_for_launcher_exit(request: &UpdateRequest) -> Result<(), Box<dyn Error>> {
    #[cfg(target_os = "windows")]
    let launcher_started_at = process_started_at_micros(request.wait_pid)?;
    #[cfg(target_os = "windows")]
    let launcher_exists = process_instance_exists(request.wait_pid, launcher_started_at)?;
    #[cfg(not(target_os = "windows"))]
    let launcher_exists = process_exists(request.wait_pid);
    if !launcher_exists {
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
    #[cfg(target_os = "windows")]
    if !process_instance_exists(request.wait_pid, launcher_started_at)? {
        return Err("Launcher exited before the background Updater was ready".into());
    }
    // Publish readiness only after confirming this is the exact live Launcher.
    write_status(request, "waiting-for-exit", None)?;
    let started = Instant::now();
    loop {
        #[cfg(target_os = "windows")]
        let launcher_exists = process_instance_exists(request.wait_pid, launcher_started_at)?;
        #[cfg(not(target_os = "windows"))]
        let launcher_exists = process_exists(request.wait_pid);
        if !launcher_exists {
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
    if cfg!(any(target_os = "macos", target_os = "windows")) && handoff.is_none() {
        return Err("update handoff token is required".into());
    }
    wait_for_launcher_exit(request)?;
    if let Some(handoff) = handoff {
        handoff.verify(request_path)?;
    }
    Ok(())
}

fn relaunched_launcher_is_ready(
    descriptor_launcher_pid: u32,
    previous_launcher_pid: u32,
    process_is_alive: impl FnOnce(u32) -> bool,
) -> bool {
    descriptor_launcher_pid != previous_launcher_pid && process_is_alive(descriptor_launcher_pid)
}

fn wait_for_relaunch(request: &UpdateRequest) -> Result<(), Box<dyn Error>> {
    let descriptor_path = &request.runtime_descriptor_path;
    let started = Instant::now();
    while started.elapsed() < RELAUNCH_TIMEOUT {
        let bytes = match fs::symlink_metadata(descriptor_path) {
            Ok(metadata)
                if metadata.is_file()
                    && !metadata.file_type().is_symlink()
                    && metadata.len() <= MAX_RUNTIME_DESCRIPTOR_BYTES =>
            {
                fs::read(descriptor_path)?
            }
            Ok(_) => return Err("runtime descriptor is not a bounded regular file".into()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                thread::sleep(Duration::from_millis(100));
                continue;
            }
            Err(error) => return Err(error.into()),
        };
        let descriptor = serde_json::from_slice::<RuntimeDescriptorProbe>(&bytes)?;
        if descriptor.schema_version != 1
            || descriptor.launcher_pid == 0
            || descriptor.control_port == 0
            || descriptor.nonce.len() != 32
            || !descriptor
                .nonce
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        {
            return Err("runtime descriptor is invalid".into());
        }
        if relaunched_launcher_is_ready(descriptor.launcher_pid, request.wait_pid, process_exists) {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(100));
    }
    Err("updated codexhost did not become ready after relaunch".into())
}

fn apply(request_path: &Path, handoff: Option<&UpdateHandoff>) -> Result<(), Box<dyn Error>> {
    let request = UpdateRequest::parse(request_path)?;
    let result = (|| -> Result<(), Box<dyn Error>> {
        wait_for_authorized_launcher_exit(&request, request_path, handoff)?;
        write_status(&request, "installing", None)?;
        install(&request)?;
        write_status(&request, "restarting", None)?;
        relaunch(&request)?;
        wait_for_relaunch(&request)?;
        write_status(&request, "succeeded", None)?;
        Ok(())
    })();
    if let Err(error) = &result {
        let message = error.to_string();
        let _ = write_status(&request, "failed", Some(&message));
    }
    result
}

fn usage() {
    eprintln!(
        "usage: codexhost-updater apply --request <absolute-json-file> --handoff-token <token>"
    );
}

fn run(arguments: &[String]) -> Result<(), Box<dyn Error>> {
    let handoff = match arguments {
        [command, flag, _, token_flag, token]
            if command == "apply" && flag == "--request" && token_flag == "--handoff-token" =>
        {
            Some(UpdateHandoff::from_token(token)?)
        }
        #[cfg(target_os = "linux")]
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
    use super::{
        relaunched_launcher_is_ready, wait_for_authorized_launcher_exit, wait_for_launcher_exit,
    };
    use codexhost_updater::UpdateHandoff;
    use std::fs;
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

    #[test]
    fn accepts_a_live_relaunched_launcher_without_executable_path_matching() {
        assert!(relaunched_launcher_is_ready(42, 41, |pid| pid == 42));
    }

    #[test]
    fn rejects_the_previous_launcher_descriptor() {
        assert!(!relaunched_launcher_is_ready(41, 41, |_| true));
    }

    #[test]
    fn rejects_a_relaunched_launcher_that_has_exited() {
        assert!(!relaunched_launcher_is_ready(42, 41, |_| false));
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
            status_path: status_path.clone(),
            installation: Installation::Npm(NpmInstallation {
                node_path: status_path.clone(),
                npm_cli_path: status_path.clone(),
                npm_launcher_path: status_path.clone(),
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
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "codexhost-authorized-exit-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir(&root).unwrap();
        let mut command = std::process::Command::new(if cfg!(target_os = "windows") {
            "ping"
        } else {
            "/bin/sleep"
        });
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
        let request = UpdateRequest {
            schema_version: 1,
            version: "1.2.3".into(),
            wait_pid: launcher.id(),
            wait_executable: codexhost_platform::process_executable_path(launcher.id()).unwrap(),
            runtime_descriptor_path: root.join("runtime.json"),
            status_path: status_path.clone(),
            installation: Installation::Npm(NpmInstallation {
                node_path: root.join("unused-node"),
                npm_cli_path: root.join("unused-npm"),
                npm_launcher_path: root.join("unused-launcher"),
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
            assert!(
                started.elapsed() < Duration::from_secs(5),
                "Helper did not reach waiting-for-exit"
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
    fn command_line_rejects_missing_or_invalid_handoff_tokens() {
        let arguments = ["apply", "--request", "unused-request.json"].map(String::from);
        assert_eq!(
            super::run(&arguments).unwrap_err().to_string(),
            "invalid updater arguments"
        );
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
