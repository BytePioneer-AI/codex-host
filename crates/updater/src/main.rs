#![forbid(unsafe_code)]

mod install;
#[cfg(any(target_os = "windows", test))]
mod installer_files;
#[cfg(any(target_os = "windows", test))]
mod installer_recovery;
#[cfg(any(target_os = "windows", test))]
mod npm_prepared;
#[cfg(any(target_os = "windows", test))]
mod npm_processes;
#[cfg(any(target_os = "windows", test))]
mod npm_recovery;
#[cfg(any(target_os = "windows", test))]
mod operation_guard;
#[cfg(any(target_os = "windows", test))]
mod operation_lock;
mod prepare_install;
mod remote;
mod request;
mod ssh;
mod status;
#[cfg(any(target_os = "windows", test))]
mod windows_apply;
#[cfg(any(target_os = "windows", test))]
mod windows_console;
#[cfg(any(target_os = "windows", test))]
mod windows_installation;
#[cfg(any(target_os = "windows", test))]
mod windows_launch;
#[cfg(any(target_os = "windows", test))]
mod windows_ready;

#[cfg(target_os = "windows")]
type UpdateHandoff = operation_lock::OperationLock;
#[cfg(not(target_os = "windows"))]
type UpdateHandoff = ();

use std::env;
use std::error::Error;
#[cfg(not(target_os = "windows"))]
use std::fs;
use std::path::Path;
use std::process::ExitCode;
use std::thread;
use std::time::{Duration, Instant};

use codexhost_platform::{process_executable_path, process_exists};
use serde::Deserialize;

#[cfg(not(target_os = "windows"))]
use install::install;
#[cfg(not(target_os = "windows"))]
use install::relaunch;
use request::UpdateRequest;
use status::write_status;

const WAIT_TIMEOUT: Duration = Duration::from_secs(180);
#[cfg(not(target_os = "windows"))]
const RELAUNCH_TIMEOUT: Duration = Duration::from_secs(30);
#[cfg(not(target_os = "windows"))]
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

#[cfg(all(test, target_os = "windows"))]
mod windows_handoff_tests;
#[cfg(all(test, target_os = "windows"))]
mod windows_smoke_tests;

#[cfg(target_os = "windows")]
fn reject_inherited_desktop_job() -> Result<(), Box<dyn Error>> {
    if let Some(key) = std::env::var_os(codexhost_platform::DESKTOP_LAUNCH_JOB_ENV) {
        let job = match codexhost_platform::WindowsLaunchJob::open(&key.to_string_lossy()) {
            Ok(job) => job,
            Err(codexhost_platform::PlatformError::Io(error))
                if error.kind() == std::io::ErrorKind::NotFound =>
            {
                return Ok(());
            }
            Err(error) => return Err(error.into()),
        };
        // The environment is not positive ownership evidence. Only a real
        // membership match denies handoff; it never authorizes cleanup.
        if job.contains_pid(std::process::id())? {
            return Err(
                "Updater inherited the old Desktop Job; request startup through its Launcher"
                    .into(),
            );
        }
    }
    Ok(())
}

fn wait_for_launcher_exit(request: &UpdateRequest) -> Result<UpdateHandoff, Box<dyn Error>> {
    #[cfg(target_os = "windows")]
    reject_inherited_desktop_job()?;
    if !process_exists(request.wait_pid) {
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
    let expected_instance = codexhost_platform::process_snapshot(request.wait_pid)?;
    #[cfg(target_os = "windows")]
    if !request.matches_wait_instance(&expected_instance) {
        return Err("update owner PID was reused before handoff".into());
    }
    #[cfg(target_os = "windows")]
    if let request::Installation::Npm(npm) = &request.installation {
        npm_processes::validate_wait_owner(npm, &expected_instance)?;
        if !request.matches_wait_instance(&codexhost_platform::process_snapshot(request.wait_pid)?)
        {
            return Err("update owner changed during entrypoint verification".into());
        }
    }
    #[cfg(target_os = "windows")]
    let ownership = operation_lock::OperationLock::take(request)?;
    #[cfg(not(target_os = "windows"))]
    let ownership = ();
    // This is the handoff acknowledgement: the owner must remain alive until
    // its identity has been checked, not merely until this process was spawned.
    write_status(request, "waiting-for-exit", None)?;
    let started = Instant::now();
    while process_exists(request.wait_pid) {
        #[cfg(target_os = "windows")]
        match codexhost_platform::process_snapshot(request.wait_pid) {
            Ok(current) if !request.matches_wait_instance(&current) => break,
            Ok(_) => {}
            Err(_) if !process_exists(request.wait_pid) => break,
            Err(error) => return Err(error.into()),
        }
        if started.elapsed() >= WAIT_TIMEOUT {
            return Err("Launcher did not exit before the update timeout".into());
        }
        thread::sleep(Duration::from_millis(100));
    }
    Ok(ownership)
}

#[cfg(not(target_os = "windows"))]
fn relaunched_launcher_is_ready(
    descriptor_launcher_pid: u32,
    previous_launcher_pid: u32,
    process_is_alive: impl FnOnce(u32) -> bool,
) -> bool {
    descriptor_launcher_pid != previous_launcher_pid && process_is_alive(descriptor_launcher_pid)
}

#[cfg(not(target_os = "windows"))]
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

#[cfg(target_os = "windows")]
fn apply(request_path: &Path) -> Result<(), Box<dyn Error>> {
    windows_apply::apply(request_path)
}

#[cfg(not(target_os = "windows"))]
fn apply(request_path: &Path) -> Result<(), Box<dyn Error>> {
    let request = UpdateRequest::parse(request_path)?;
    let result = (|| -> Result<(), Box<dyn Error>> {
        wait_for_launcher_exit(&request)?;
        write_status(&request, "installing", None)?;
        install(&request, || Ok(()))?;
        write_status(&request, "restarting", None)?;
        drop(relaunch(&request)?);
        wait_for_relaunch(&request)?;
        write_status(&request, "succeeded", None)?;
        Ok(())
    })();
    if let Err(error) = &result {
        let _ = write_status(&request, "failed", Some(&error.to_string()));
    }
    result
}

fn usage() {
    eprintln!(
        "usage: codexhost-updater apply --request <absolute-json-file>\n       codexhost-updater prepare-install --install-root <absolute-directory>"
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
    if arguments.len() != 3 || arguments[0] != "apply" || arguments[1] != "--request" {
        usage();
        return Err("invalid updater arguments".into());
    }
    apply(Path::new(&arguments[2]))
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
    #[cfg(not(target_os = "windows"))]
    use super::relaunched_launcher_is_ready;
    use super::wait_for_launcher_exit;
    use crate::request::{Installation, NpmInstallation, UpdateRequest};

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
            launch_via_launcher: false,
            wait_started_at_micros: None,
            runtime_descriptor_path: directory.join("runtime.json"),
            status_path: status_path.clone(),
            installation: Installation::Npm(NpmInstallation {
                node_path: wrong_executable.clone(),
                npm_cli_path: wrong_executable.clone(),
                npm_launcher_path: wrong_executable,
                prefix: None,
                package_root: None,
                installed_version: None,
                prepared: None,
                recovery: None,
            }),
        };
        let error = wait_for_launcher_exit(&request).unwrap_err();
        assert!(error.to_string().contains("not the expected Launcher"));
        assert_eq!(std::fs::read_to_string(status_path).unwrap(), "prepared");
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn accepts_a_live_relaunched_launcher_without_executable_path_matching() {
        assert!(relaunched_launcher_is_ready(42, 41, |pid| pid == 42));
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn rejects_the_previous_launcher_descriptor() {
        assert!(!relaunched_launcher_is_ready(41, 41, |_| true));
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn rejects_a_relaunched_launcher_that_has_exited() {
        assert!(!relaunched_launcher_is_ready(42, 41, |_| false));
    }
}
