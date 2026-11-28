#![forbid(unsafe_code)]

mod diagnostics;
mod handoff;
mod install;
mod npm;
mod prepare_install;
mod remote;
mod request;
mod restart;
mod services;
mod ssh;
mod status;
#[cfg(target_os = "windows")]
mod windows_install;

use std::env;
use std::error::Error;
use std::path::Path;
use std::process::ExitCode;
use std::thread;
use std::time::{Duration, Instant};

use codexhost_platform::{process_executable_path, process_exists};

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

fn wait_for_launcher_exit(request: &UpdateRequest) -> Result<(), Box<dyn Error>> {
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
    // This is the handoff acknowledgement: the owner must remain alive until
    // its identity has been checked, not merely until this process was spawned.
    write_status(request, "waiting-for-exit", None, None)?;
    if request.service_managed {
        return handoff::wait_for_ownership(&request.status_path, Duration::from_secs(10));
    }
    let started = Instant::now();
    while process_exists(request.wait_pid) {
        if started.elapsed() >= WAIT_TIMEOUT {
            return Err("Launcher did not exit before the update timeout".into());
        }
        thread::sleep(Duration::from_millis(100));
    }
    Ok(())
}

fn apply(request_path: &Path) -> Result<(), Box<dyn Error>> {
    let mut request = UpdateRequest::parse(request_path)?;
    let _independent = request
        .service_managed
        .then(codexhost_platform::register_independent_service)
        .transpose()?;
    let mut service_stop_output = None;
    let mut stopping_started = false;
    let mut services_restored = false;
    let mut old_shell = None;
    #[cfg(windows)]
    let mut windows = None;
    #[cfg(windows)]
    let mut installer_started = false;
    #[cfg(windows)]
    let mut installation_verified = false;
    let mut recovery_version = None;
    let result = (|| -> Result<(), Box<dyn Error>> {
        // A refusal before acknowledgement leaves the owner running.
        let npm_layout = install::preflight(&request)?;
        #[cfg(windows)]
        if let request::Installation::WindowsInstaller(installation) = &request.installation {
            let transaction = windows_install::WindowsUpdate::inspect(&request, installation)?;
            recovery_version = Some(transaction.previous_version.clone());
            windows = Some(transaction);
        }
        if matches!(request.installation, request::Installation::Npm(_)) {
            recovery_version =
                install::installed_version(&request.installation.resources_root(), "npm").ok();
        }
        old_shell = restart::current_desktop_shell(&request)?;
        // A released Windows Launcher may not set this flag yet.
        if cfg!(windows) && request.service_managed && old_shell.is_some() {
            request.restart_desktop_shell = true;
        }
        wait_for_launcher_exit(&request)?;
        stopping_started = true;
        service_stop_output = services::stop(&request)?;
        write_status(&request, "installing", None, service_stop_output.as_deref())?;
        #[cfg(windows)]
        if let Some(transaction) = &windows {
            transaction.backup()?;
            installer_started = true;
        }
        install(&mut request, npm_layout.as_ref())?;
        recovery_version = Some(request.version.clone());
        #[cfg(windows)]
        {
            installation_verified = true;
        }
        write_status(&request, "restarting", None, service_stop_output.as_deref())?;
        restart::restore(&request, Some(&request.version))?;
        services_restored = true;
        if request.restart_desktop_shell {
            restart::relaunch_desktop_shell(&request, Some(&request.version), old_shell, false)?;
        }
        write_status(&request, "succeeded", None, service_stop_output.as_deref())?;
        #[cfg(windows)]
        if let Some(transaction) = &windows {
            transaction.discard_backup();
        }
        Ok(())
    })();
    if let Err(error) = result {
        let mut message = error.to_string();
        let recover = stopping_started && !services_restored;
        #[cfg(windows)]
        let recover = match &windows {
            Some(transaction) if installation_verified => {
                message.push_str(&format!(
                    "; previous installation retained at {}",
                    transaction.backup_path().display()
                ));
                false
            }
            Some(transaction) if installer_started => match transaction.rollback() {
                Ok(()) => {
                    message.push_str(&format!(
                        "; rolled back to {}",
                        transaction.previous_version
                    ));
                    recover
                }
                Err(rollback) => {
                    message.push_str(&format!(
                        "; rollback failed: {rollback}; backup path: {}",
                        transaction.backup_path().display(),
                    ));
                    false
                }
            },
            _ => recover,
        };
        if recover {
            match restart::restore(&request, recovery_version.as_deref()) {
                Ok(()) => {
                    message.push_str("; service recovery succeeded");
                    if request.restart_desktop_shell {
                        let _ = write_status(
                            &request,
                            "restarting",
                            None,
                            service_stop_output.as_deref(),
                        );
                        if let Err(error) = restart::relaunch_desktop_shell(
                            &request,
                            recovery_version.as_deref(),
                            old_shell,
                            true,
                        ) {
                            message.push_str(&format!("; desktop shell recovery failed: {error}"));
                        }
                    }
                }
                Err(recovery) => {
                    message.push_str(&format!("; service recovery failed: {recovery}"));
                }
            }
        }
        let _ = write_status(
            &request,
            "failed",
            Some(&message),
            service_stop_output.as_deref(),
        );
        return Err(message.into());
    }
    Ok(())
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
            runtime_descriptor_path: directory.join("runtime.json"),
            restart_target: Default::default(),
            restart_desktop_shell: false,
            data_directory: None,
            service_managed: false,
            status_path: status_path.clone(),
            installation: Installation::Npm(NpmInstallation {
                node_path: wrong_executable.clone(),
                npm_cli_path: wrong_executable.clone(),
                npm_launcher_path: wrong_executable,
                npm_package_root: directory.clone(),
                npm_config_sha256: None,
            }),
        };
        let error = wait_for_launcher_exit(&request).unwrap_err();
        assert!(error.to_string().contains("not the expected Launcher"));
        assert_eq!(std::fs::read_to_string(status_path).unwrap(), "prepared");
        std::fs::remove_dir_all(directory).unwrap();
    }
}
