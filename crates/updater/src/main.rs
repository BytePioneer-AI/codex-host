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

#[cfg(test)]
mod tests {
    use super::relaunched_launcher_is_ready;

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
}
