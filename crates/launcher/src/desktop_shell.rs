//! Launch and stop the independent native desktop shell.
use std::error::Error;
use std::fs;
use std::io::{ErrorKind, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use codexhost_platform::{
    ProcessIdentity, configure_detached_service_command, process_identity, process_instance,
    terminate_process_identity,
};
use serde::{Deserialize, Serialize};

use crate::{DATA_DIRECTORY_ENV, LAUNCHER_EXECUTABLE_ENV};

const READY: &str = "desktop-shell-ready.json";
const STOP_GRACE: Duration = Duration::from_secs(3);
const STOP_POLL: Duration = Duration::from_millis(25);
const ACTIVATION_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, PartialEq, Eq)]
pub enum AppActivation<'a> {
    Show,
    Onboarding,
    Session(&'a str),
}

pub fn parse_app_activation(arguments: &[String]) -> Result<AppActivation<'_>, &'static str> {
    match arguments {
        [] => Ok(AppActivation::Show),
        [flag] if flag == "--onboarding" => Ok(AppActivation::Onboarding),
        [flag, id] if flag == "--session" => {
            if id.len() <= 1024 && !id.trim().is_empty() && !id.chars().any(char::is_control) {
                Ok(AppActivation::Session(id))
            } else {
                Err("Invalid desktop session ID")
            }
        }
        _ => Err("usage: codexhost app [--onboarding | --session <id>]"),
    }
}

#[derive(Deserialize, Serialize)]
struct ReadyOwner {
    pid: u32,
    started_at_micros: u64,
    executable: PathBuf,
    version: String,
}

fn shell_command(shell: &Path, data: &Path) -> Result<Command, Box<dyn Error>> {
    let mut command = Command::new(shell);
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
    Ok(command)
}

pub fn spawn(shell: &Path, data: &Path, onboarding: bool) -> Result<(), Box<dyn Error>> {
    let mut command = shell_command(shell, data)?;
    if onboarding {
        command.arg("--onboarding");
    }
    command.spawn()?;
    Ok(())
}

pub fn activate_session(shell: &Path, data: &Path, session_id: &str) -> Result<(), Box<dyn Error>> {
    if let Some(bytes) = read_record(&data.join(READY))? {
        let owner: ReadyOwner = serde_json::from_slice(&bytes)
            .map_err(|_| "The desktop shell ready record is invalid")?;
        if process_instance(owner.pid, owner.started_at_micros).is_none()
            && process_identity(owner.pid).is_ok()
        {
            return Err("The desktop shell ready record belongs to a reused process ID".into());
        }
    }
    let mut child = shell_command(shell, data)?
        .args(["--session", session_id])
        .stdout(Stdio::piped())
        .spawn()?;
    let Some(stdout) = child.stdout.take() else {
        return Ok(());
    };
    if shell_explicitly_rejected(stdout, ACTIVATION_TIMEOUT) {
        return Err("The desktop shell rejected the session activation".into());
    }
    Ok(())
}

fn shell_explicitly_rejected(mut stdout: impl Read + Send + 'static, timeout: Duration) -> bool {
    let (send, receive) = mpsc::channel();
    let _ = thread::Builder::new().spawn(move || {
        let mut reply = [0; 3];
        let rejected = stdout.read_exact(&mut reply).is_ok() && &reply == b"no\n";
        let _ = send.send(rejected);
    });
    // Once spawned, a lost reply leaves acceptance unknown.
    matches!(receive.recv_timeout(timeout), Ok(true))
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
    fn app_session_takes_one_bounded_literal_id() {
        let parse = |id: &str| {
            let arguments = ["--session".to_owned(), id.to_owned()];
            parse_app_activation(&arguments) == Ok(AppActivation::Session(id))
        };
        assert!(parse("--data-dir"));
        assert!(parse(&"é".repeat(512)));
        for invalid in ["", " \u{3000}", "a\u{1f}b", "a\u{85}b", &"é".repeat(513)] {
            assert!(!parse(invalid));
        }
        assert!(
            parse_app_activation(&["--session".into(), "id".into(), "--onboarding".into()])
                .is_err()
        );
    }

    #[test]
    fn shell_reply_only_reports_a_complete_explicit_rejection() {
        assert!(shell_explicitly_rejected(&b"no\n"[..], ACTIVATION_TIMEOUT));
        for reply in [&b"ok\n"[..], b"", b"no", b"???"] {
            assert!(!shell_explicitly_rejected(reply, ACTIVATION_TIMEOUT));
        }

        struct DelayedReply(mpsc::Receiver<()>);
        impl Read for DelayedReply {
            fn read(&mut self, _buf: &mut [u8]) -> std::io::Result<usize> {
                let _ = self.0.recv();
                Ok(0)
            }
        }
        let (release, reply) = mpsc::channel();
        assert!(!shell_explicitly_rejected(
            DelayedReply(reply),
            Duration::ZERO,
        ));
        drop(release);
    }

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
        let error = activate_session(&data.join("unused-shell"), &data, "test").unwrap_err();
        assert!(error.to_string().contains("reused process ID"));
        assert!(!stop(&data).unwrap());
        assert!(!path.exists());
        assert!(process_instance(current.id, current.started_at_micros).is_some());
        fs::remove_dir_all(data).unwrap();
    }

    #[test]
    fn activation_rejects_invalid_ready_json_even_with_a_live_pid() {
        let data = std::env::temp_dir().join(format!(
            "codexhost-shell-activation-corrupt-{}",
            std::process::id()
        ));
        fs::create_dir(&data).unwrap();
        let path = data.join(READY);
        let pid = std::process::id();
        assert!(process_identity(pid).is_ok());
        fs::write(&path, format!(r#"{{"pid":{pid},"started_at_micros":"#)).unwrap();

        let shell = data.join("missing-shell");
        let invalid = activate_session(&shell, &data, "test").unwrap_err();
        fs::remove_file(path).unwrap();
        let absent = activate_session(&shell, &data, "test").unwrap_err();
        fs::remove_dir_all(data).unwrap();

        assert_eq!(
            invalid.to_string(),
            "The desktop shell ready record is invalid"
        );
        assert!(absent.is::<std::io::Error>(), "{absent}");
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
