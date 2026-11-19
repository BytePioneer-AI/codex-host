//! One-shot launchd handoff into the current user's desktop security session.
//! Caller arguments and environment travel only over an owner-private Unix socket.
use std::ffi::OsString;
use std::fs::{self, DirBuilder, File, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::ffi::{OsStrExt, OsStringExt};
use std::os::unix::fs::{DirBuilderExt, FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::macos_native_harness_broker::xml_text;
use crate::{PlatformError, ProcessSnapshot, process_snapshot};

pub const AQUA_SPAWN_ARGUMENT: &str = "--codexhost-aqua-spawn";
const TIMEOUT: Duration = Duration::from_secs(10);
const MAX_REQUEST_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Serialize, Deserialize)]
struct Request {
    program: Vec<u8>,
    arguments: Vec<Vec<u8>>,
    environment: Vec<(Vec<u8>, Vec<u8>)>,
    directory: Vec<u8>,
}

#[derive(Serialize, Deserialize)]
enum Reply {
    Started { pid: u32, started_at_micros: u64 },
    Failed(String),
}

fn invalid(message: impl Into<String>) -> PlatformError {
    PlatformError::Invalid(message.into())
}

fn write_frame(mut stream: &UnixStream, value: &[u8]) -> Result<(), PlatformError> {
    stream.write_all(&(value.len() as u32).to_be_bytes())?;
    stream.write_all(value)?;
    Ok(())
}

fn read_frame(mut stream: &UnixStream, maximum: u64) -> Result<Vec<u8>, PlatformError> {
    let mut size = [0_u8; 4];
    stream.read_exact(&mut size)?;
    let size = u32::from_be_bytes(size) as u64;
    if size > maximum {
        return Err(invalid("desktop launch frame is too large"));
    }
    let mut value = vec![0; size as usize];
    stream.read_exact(&mut value)?;
    Ok(value)
}

fn desktop_uid() -> Result<u32, PlatformError> {
    let uid = nix::unistd::Uid::effective().as_raw();
    if uid == 0 || fs::metadata("/dev/console")?.uid() != uid {
        return Err(invalid(
            "desktop session mode requires the current user to be logged in to the macOS desktop; screen lock is supported",
        ));
    }
    if !Command::new("/bin/launchctl")
        .args(["print", &format!("gui/{uid}")])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()?
        .success()
    {
        return Err(invalid(
            "the current user's macOS desktop session is unavailable",
        ));
    }
    Ok(uid)
}

struct Handoff {
    directory: PathBuf,
    target: String,
}

impl Drop for Handoff {
    fn drop(&mut self) {
        // On a rejected handoff the helper must see the closed socket and finish
        // stopping its unacknowledged child before launchd unloads the helper.
        let deadline = Instant::now() + Duration::from_secs(6);
        while Instant::now() < deadline {
            let running = Command::new("/bin/launchctl")
                .args(["print", &self.target])
                .stderr(Stdio::null())
                .output()
                .is_ok_and(|output| {
                    output.status.success()
                        && String::from_utf8_lossy(&output.stdout)
                            .lines()
                            .any(|line| line.trim().starts_with("pid = "))
                });
            if !running {
                break;
            }
            thread::sleep(Duration::from_millis(20));
        }
        // The one-shot helper abandons its process group; unloading it must not stop
        // the listener, which retains its existing native supervisor and stop path.
        let _ = Command::new("/bin/launchctl")
            .args(["bootout", &self.target])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        let _ = fs::remove_dir_all(&self.directory);
    }
}

fn plist(helper: &Path, socket: &Path, label: &str) -> Result<String, PlatformError> {
    let helper = helper
        .to_str()
        .ok_or_else(|| invalid("Aqua helper path must be UTF-8"))?;
    let socket = socket
        .to_str()
        .ok_or_else(|| invalid("Aqua socket path must be UTF-8"))?;
    Ok(format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<plist version=\"1.0\"><dict>\n\
<key>Label</key><string>{}</string>\n\
<key>ProgramArguments</key><array><string>{}</string><string>{AQUA_SPAWN_ARGUMENT}</string><string>{}</string></array>\n\
<key>LimitLoadToSessionType</key><string>Aqua</string>\n\
<key>RunAtLoad</key><true/>\n\
<key>KeepAlive</key><false/>\n\
<key>AbandonProcessGroup</key><true/>\n\
<key>StandardOutPath</key><string>/dev/null</string>\n\
<key>StandardErrorPath</key><string>/dev/null</string>\n\
</dict></plist>\n",
        xml_text(label),
        xml_text(helper),
        xml_text(socket),
    ))
}

/// Launch the native helper once through launchd, preserving the caller's command
/// without storing its environment or arguments in a LaunchAgent property list.
pub fn spawn_in_desktop_session(command: &Command) -> Result<ProcessSnapshot, PlatformError> {
    let uid = desktop_uid()?;
    let program = Path::new(command.get_program()).canonicalize()?;
    let request = Request {
        program: program.as_os_str().as_bytes().to_vec(),
        arguments: command
            .get_args()
            .map(|arg| arg.as_bytes().to_vec())
            .collect(),
        environment: command
            .get_envs()
            .filter_map(|(key, value)| {
                value.map(|value| (key.as_bytes().to_vec(), value.as_bytes().to_vec()))
            })
            .collect(),
        directory: command
            .get_current_dir()
            .ok_or_else(|| invalid("desktop command requires an explicit working directory"))?
            .as_os_str()
            .as_bytes()
            .to_vec(),
    };
    let encoded = serde_json::to_vec(&request).map_err(|error| invalid(error.to_string()))?;
    if encoded.len() as u64 > MAX_REQUEST_BYTES {
        return Err(invalid("desktop launch request is too large"));
    }
    let mut random = [0_u8; 8];
    File::open("/dev/urandom")?.read_exact(&mut random)?;
    let nonce = random
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let label = format!("ai.bytepioneer.codexhost.remote-launch.{nonce}");
    let directory = std::env::temp_dir().join(format!("ch-aqua-{nonce}"));
    DirBuilder::new().mode(0o700).create(&directory)?;
    let handoff = Handoff {
        directory,
        target: format!("gui/{uid}/{label}"),
    };
    let socket = handoff.directory.join("ipc");
    let listener = UnixListener::bind(&socket)?;
    fs::set_permissions(&socket, fs::Permissions::from_mode(0o600))?;
    listener.set_nonblocking(true)?;
    let plist_path = handoff.directory.join("launch.plist");
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&plist_path)?
        .write_all(plist(&program, &socket, &label)?.as_bytes())?;
    let mut bootstrap = Command::new("/bin/launchctl")
        .args(["bootstrap", &format!("gui/{uid}")])
        .arg(&plist_path)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    let deadline = Instant::now() + TIMEOUT;
    let stream = loop {
        match listener.accept() {
            Ok((stream, _)) => break stream,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
            Err(error) => return Err(error.into()),
        }
        if let Some(status) = bootstrap.try_wait()?
            && !status.success()
        {
            return Err(invalid(format!(
                "could not launch the macOS desktop helper: {status}"
            )));
        }
        if Instant::now() >= deadline {
            let _ = bootstrap.kill();
            let _ = bootstrap.wait();
            return Err(invalid(
                "macOS desktop launch helper did not connect within 10 seconds",
            ));
        }
        thread::sleep(Duration::from_millis(20));
    };
    stream.set_nonblocking(false)?;
    stream.set_read_timeout(Some(TIMEOUT))?;
    stream.set_write_timeout(Some(TIMEOUT))?;
    write_frame(&stream, &encoded)?;
    let reply: Reply = serde_json::from_slice(&read_frame(&stream, 4096)?)
        .map_err(|error| invalid(format!("desktop launch failed: {error}")))?;
    let (pid, started_at_micros) = match reply {
        Reply::Started {
            pid,
            started_at_micros,
        } => (pid, started_at_micros),
        Reply::Failed(message) => return Err(invalid(format!("desktop launch failed: {message}"))),
    };
    let snapshot = process_snapshot(pid)?;
    if snapshot.started_at_micros != started_at_micros || snapshot.executable != program {
        return Err(invalid(
            "desktop listener process identity changed during launch",
        ));
    }
    (&stream).write_all(&[1])?;
    let mut finished = [0];
    if (&stream).read(&mut finished)? != 0 {
        return Err(invalid(
            "unexpected data after desktop launch acknowledgement",
        ));
    }
    let _ = bootstrap.wait();
    Ok(snapshot)
}

/// Internal native helper entry point; the private socket conveys one command.
pub fn run_aqua_spawn_helper(socket: &Path) -> Result<(), PlatformError> {
    let uid = desktop_uid()?;
    let directory = socket
        .parent()
        .ok_or_else(|| invalid("Aqua handoff directory is missing"))?;
    let metadata = fs::symlink_metadata(directory)?;
    let endpoint = fs::symlink_metadata(socket)?;
    if !metadata.is_dir()
        || metadata.uid() != uid
        || metadata.mode() & 0o077 != 0
        || !endpoint.file_type().is_socket()
        || endpoint.uid() != uid
        || endpoint.mode() & 0o077 != 0
    {
        return Err(invalid(
            "Aqua handoff must use a current-user private directory and socket",
        ));
    }
    let stream = UnixStream::connect(socket)?;
    stream.set_read_timeout(Some(TIMEOUT))?;
    stream.set_write_timeout(Some(TIMEOUT))?;
    let launched = (|| {
        let encoded = read_frame(&stream, MAX_REQUEST_BYTES)?;
        let request: Request = serde_json::from_slice(&encoded)
            .map_err(|_| invalid("invalid desktop launch request"))?;
        Command::new(OsString::from_vec(request.program))
            .args(request.arguments.into_iter().map(OsString::from_vec))
            .env_clear()
            .envs(
                request
                    .environment
                    .into_iter()
                    .map(|(key, value)| (OsString::from_vec(key), OsString::from_vec(value))),
            )
            .current_dir(OsString::from_vec(request.directory))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(PlatformError::from)
    })();
    let mut child = match launched {
        Ok(child) => child,
        Err(error) => {
            let reply = Reply::Failed(error.to_string().chars().take(600).collect());
            if let Ok(encoded) = serde_json::to_vec(&reply) {
                let _ = write_frame(&stream, &encoded);
            }
            return Err(error);
        }
    };
    let reply = (|| {
        // A listener that exits before its snapshot is read is a failed launch: say so,
        // instead of closing the socket and leaving the caller with a bare EOF.
        let snapshot = match process_snapshot(child.id()) {
            Ok(snapshot) => snapshot,
            Err(error) => {
                let failed = Reply::Failed(error.to_string().chars().take(600).collect());
                if let Ok(encoded) = serde_json::to_vec(&failed) {
                    let _ = write_frame(&stream, &encoded);
                }
                return Err(error);
            }
        };
        let reply = Reply::Started {
            pid: snapshot.id,
            started_at_micros: snapshot.started_at_micros,
        };
        let reply = serde_json::to_vec(&reply).map_err(|error| invalid(error.to_string()))?;
        write_frame(&stream, &reply)?;
        let mut acknowledged = [0];
        (&stream).read_exact(&mut acknowledged)?;
        if acknowledged != [1] {
            return Err(invalid("desktop launch was not acknowledged"));
        }
        Ok::<_, PlatformError>(())
    })();
    if reply.is_err() {
        if let Ok(snapshot) = process_snapshot(child.id()) {
            let _ = crate::terminate_process_instance(&snapshot, false);
        }
        // The listener supervisor first gives its descendants two seconds to exit.
        // Keep it alive through escalation, and finish before Handoff unloads us.
        let deadline = Instant::now() + Duration::from_secs(5);
        while child.try_wait()?.is_none() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(20));
        }
        if child.try_wait()?.is_none() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
    reply
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plist_only_contains_the_private_handoff_endpoint_and_native_helper() {
        let xml = plist(
            Path::new("/native & tools/shim"),
            Path::new("/private & data/ipc"),
            "test-label",
        )
        .unwrap();
        let value = plist::Value::from_reader_xml(xml.as_bytes()).unwrap();
        let values = value.as_dictionary().unwrap();
        assert!(values.get("EnvironmentVariables").is_none());
        assert_eq!(
            values
                .get("AbandonProcessGroup")
                .and_then(plist::Value::as_boolean),
            Some(true)
        );
        assert_eq!(
            values.get("KeepAlive").and_then(plist::Value::as_boolean),
            Some(false)
        );
        assert!(xml.contains("/native &amp; tools/shim"));
    }

    #[test]
    fn handoff_frames_are_bounded_before_allocating_the_request() {
        let (mut writer, reader) = UnixStream::pair().unwrap();
        writer.write_all(&u32::MAX.to_be_bytes()).unwrap();
        assert!(
            read_frame(&reader, MAX_REQUEST_BYTES)
                .unwrap_err()
                .to_string()
                .contains("too large")
        );
    }

    #[test]
    fn handoff_preserves_bytes_that_are_not_utf8() {
        let request = Request {
            program: b"/shim".to_vec(),
            arguments: vec![vec![0xff, b' ']],
            environment: vec![(b"VALUE".to_vec(), vec![0xfe])],
            directory: b"/workspace".to_vec(),
        };
        let (writer, reader) = UnixStream::pair().unwrap();
        write_frame(&writer, &serde_json::to_vec(&request).unwrap()).unwrap();
        let decoded: Request =
            serde_json::from_slice(&read_frame(&reader, MAX_REQUEST_BYTES).unwrap()).unwrap();
        assert_eq!(decoded.arguments, request.arguments);
        assert_eq!(decoded.environment, request.environment);
    }
}
