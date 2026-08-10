#![forbid(unsafe_code)]

mod install;
mod request;
mod status;

use std::env;
use std::error::Error;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::thread;
use std::time::{Duration, Instant};

use codexhost_platform::{PlatformError, process_executable_path, process_exists};
use serde::Deserialize;

use install::{install, relaunch};
use request::UpdateRequest;
use status::write_status;

const WAIT_TIMEOUT: Duration = Duration::from_secs(180);
const RELAUNCH_TIMEOUT: Duration = Duration::from_secs(30);
const RUNTIME_DESCRIPTOR_FILE: &str = "desktop-runtime-v1.json";
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
    let started = Instant::now();
    while process_exists(request.wait_pid) {
        if started.elapsed() >= WAIT_TIMEOUT {
            return Err("Launcher did not exit before the update timeout".into());
        }
        thread::sleep(Duration::from_millis(100));
    }
    Ok(())
}

fn runtime_descriptor_path(request: &UpdateRequest) -> Result<PathBuf, Box<dyn Error>> {
    let operation = request
        .status_path
        .parent()
        .ok_or("update status path has no operation directory")?;
    let updates = operation
        .parent()
        .ok_or("update operation has no state directory")?;
    if request
        .status_path
        .file_name()
        .and_then(|name| name.to_str())
        != Some("status-v1.json")
        || updates.file_name().and_then(|name| name.to_str()) != Some("updates")
        || !operation
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("update-"))
    {
        return Err("update status path cannot identify the runtime state directory".into());
    }
    Ok(updates
        .parent()
        .ok_or("updates directory has no runtime state directory")?
        .join(RUNTIME_DESCRIPTOR_FILE))
}

fn expected_launcher_executable(request: &UpdateRequest) -> PathBuf {
    match &request.installation {
        request::Installation::Npm(npm) => npm.node_path.clone(),
        request::Installation::WindowsInstaller(windows) => {
            windows.install_root.join("bin").join("codexhost.exe")
        }
        request::Installation::MacosDmg(macos) => macos
            .app_path
            .join("Contents")
            .join("MacOS")
            .join("codexhost"),
    }
}

fn wait_for_relaunch(request: &UpdateRequest) -> Result<(), Box<dyn Error>> {
    let descriptor_path = runtime_descriptor_path(request)?;
    let expected_executable = expected_launcher_executable(request).canonicalize()?;
    let started = Instant::now();
    while started.elapsed() < RELAUNCH_TIMEOUT {
        let bytes = match fs::symlink_metadata(&descriptor_path) {
            Ok(metadata)
                if metadata.is_file()
                    && !metadata.file_type().is_symlink()
                    && metadata.len() <= MAX_RUNTIME_DESCRIPTOR_BYTES =>
            {
                fs::read(&descriptor_path)?
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
        if descriptor.launcher_pid != request.wait_pid {
            match process_executable_path(descriptor.launcher_pid) {
                Ok(path) if path.canonicalize()? == expected_executable => return Ok(()),
                Ok(_) | Err(PlatformError::NotFound(_)) => {}
                Err(error) => return Err(error.into()),
            }
        }
        thread::sleep(Duration::from_millis(100));
    }
    Err("updated codexhost did not become ready after relaunch".into())
}

fn apply(request_path: &Path) -> Result<(), Box<dyn Error>> {
    let request = UpdateRequest::parse(request_path)?;
    write_status(&request, "waiting-for-exit", None)?;
    let result = (|| -> Result<(), Box<dyn Error>> {
        wait_for_launcher_exit(&request)?;
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
    eprintln!("usage: codexhost-updater apply --request <absolute-json-file>");
}

fn run(arguments: &[String]) -> Result<(), Box<dyn Error>> {
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
