//! Launch and stop the independent native desktop shell.
use std::error::Error;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use codexhost_platform::{
    ProcessIdentity, configure_detached_service_command, process_instance,
    terminate_process_identity,
};
use serde::{Deserialize, Serialize};

use crate::{DATA_DIRECTORY_ENV, LAUNCHER_EXECUTABLE_ENV};

const READY: &str = "desktop-shell-ready.json";
const STOP_GRACE: Duration = Duration::from_secs(3);
const STOP_POLL: Duration = Duration::from_millis(25);

#[derive(Deserialize, Serialize)]
struct ReadyOwner {
    pid: u32,
    started_at_micros: u64,
    executable: PathBuf,
    version: String,
}

pub fn spawn(shell: &Path, data: &Path, onboarding: bool) -> Result<(), Box<dyn Error>> {
    let mut command = Command::new(shell);
    if onboarding {
        command.arg("--onboarding");
    }
    command
        .env(
            LAUNCHER_EXECUTABLE_ENV,
            std::env::current_exe()?.canonicalize()?,
        )
        .env(DATA_DIRECTORY_ENV, data)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    configure_detached_service_command(&mut command)?;
    command.spawn()?;
    Ok(())
}

fn wait_for_exit(owner: ProcessIdentity, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while process_instance(owner.id, owner.started_at_micros).is_some() {
        if Instant::now() >= deadline {
            return false;
        }
        thread::sleep(STOP_POLL);
    }
    true
}

fn stop_instance(owner: ProcessIdentity) -> Result<(), Box<dyn Error>> {
    terminate_process_identity(&owner, false)?;
    if wait_for_exit(owner, STOP_GRACE) {
        return Ok(());
    }
    // Windows uses exact-instance TerminateProcess for the first request.
    #[cfg(unix)]
    {
        terminate_process_identity(&owner, true)?;
        if wait_for_exit(owner, STOP_GRACE) {
            return Ok(());
        }
    }
    Err("Desktop shell shutdown timed out".into())
}

fn read_record(path: &Path) -> std::io::Result<Option<Vec<u8>>> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

pub fn stop(data: &Path) -> Result<bool, Box<dyn Error>> {
    let path = data.join(READY);
    let Some(bytes) = read_record(&path)? else {
        return Ok(false);
    };
    let owner = serde_json::from_slice::<ReadyOwner>(&bytes)
        .ok()
        .and_then(|record| process_instance(record.pid, record.started_at_micros));
    if let Some(owner) = owner {
        stop_instance(owner)?;
    }
    // The shell may clean up its own record or a new launch may replace it.
    if read_record(&path)?.as_deref() == Some(&bytes)
        && let Err(error) = fs::remove_file(path)
        && error.kind() != ErrorKind::NotFound
    {
        return Err(error.into());
    }
    Ok(owner.is_some())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn stop_ignores_absent_record_and_removes_a_reused_pids_record() {
        let data =
            std::env::temp_dir().join(format!("codexhost-shell-stop-{}", std::process::id()));
        fs::create_dir(&data).unwrap();
        assert!(!stop(&data).unwrap());

        let current = codexhost_platform::process_identity(std::process::id()).unwrap();
        let fixture = json!({
            "pid": current.id,
            "started_at_micros": current.started_at_micros + 1,
            "executable": std::env::current_exe().unwrap(),
            "version": "0.24.0",
        });
        let record: ReadyOwner = serde_json::from_value(fixture.clone()).unwrap();
        assert_eq!(serde_json::to_value(&record).unwrap(), fixture);
        let path = data.join(READY);
        fs::write(&path, serde_json::to_vec(&record).unwrap()).unwrap();
        assert!(!stop(&data).unwrap());
        assert!(!path.exists());
        assert!(process_instance(current.id, current.started_at_micros).is_some());
        fs::remove_dir_all(data).unwrap();
    }

    #[test]
    fn stop_cleans_a_corrupt_ready_record_without_an_error() {
        let data =
            std::env::temp_dir().join(format!("codexhost-shell-corrupt-{}", std::process::id()));
        fs::create_dir(&data).unwrap();
        let path = data.join(READY);
        fs::write(&path, b"{\"pid\":").unwrap();

        assert!(!stop(&data).unwrap());
        assert!(!path.exists());
        fs::remove_dir_all(data).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn stop_waits_for_the_shell_to_exit_on_sigterm_and_cleans_its_record() {
        use std::io::{BufRead, BufReader};

        let data =
            std::env::temp_dir().join(format!("codexhost-shell-term-{}", std::process::id()));
        fs::create_dir(&data).unwrap();
        let mut shell = Command::new("sh")
            .args([
                "-c",
                "trap 'exit 0' TERM; echo ready; for n in 1 2 3 4 5; do sleep 1; done; exit 1",
            ])
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut ready = String::new();
        BufReader::new(shell.stdout.take().unwrap())
            .read_line(&mut ready)
            .unwrap();
        assert_eq!(ready, "ready\n");
        let shell_identity = codexhost_platform::process_snapshot(shell.id()).unwrap();
        let record = ReadyOwner {
            pid: shell_identity.id,
            started_at_micros: shell_identity.started_at_micros,
            executable: shell_identity.executable,
            version: "0.24.0".into(),
        };
        let path = data.join(READY);
        fs::write(&path, serde_json::to_vec(&record).unwrap()).unwrap();
        let reaper = thread::spawn(move || shell.wait().unwrap());
        assert!(stop(&data).unwrap());
        assert!(reaper.join().unwrap().success());
        assert!(!path.exists());
        fs::remove_dir_all(data).unwrap();
    }
}
