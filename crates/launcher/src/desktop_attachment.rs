#[cfg(target_os = "windows")]
use std::env;
use std::error::Error;
use std::ffi::OsString;
use std::io::{self, BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant};

use codexhost_platform::{
    DesktopInstallation, ProcessSnapshot, descendant_executable_pair_exists,
    desktop_root_process_ids_for_installation,
};
#[cfg(target_os = "windows")]
use codexhost_platform::{process_executable_path, process_exists, terminate_process_by_id};

use crate::ResolvedLaunchOptions;
use crate::runtime_instance::{
    LauncherGuard, RuntimeDescriptor, RuntimeDescriptorGuard, default_descriptor_path,
    default_guard_path, random_nonce, read_descriptor, remove_matching_descriptor,
    try_acquire_launcher_guard,
};

const ATTACHMENT_RETRY_INITIAL_DELAY: Duration = Duration::from_millis(100);
const ATTACHMENT_RETRY_MAX_DELAY: Duration = Duration::from_secs(1);

#[derive(Debug)]
pub(super) struct RuntimeControl {
    pub(super) renderer_cdp_endpoint: String,
    pub(super) renderer_cdp_arguments: [OsString; 2],
    pub(super) attachment_port: u16,
    pub(super) nonce: String,
}

pub(super) fn allocate_runtime_control() -> Result<RuntimeControl, Box<dyn Error>> {
    let renderer_cdp = TcpListener::bind(("127.0.0.1", 0))?;
    let attachment = TcpListener::bind(("127.0.0.1", 0))?;
    let renderer_cdp_port = renderer_cdp.local_addr()?.port();
    let attachment_port = attachment.local_addr()?.port();
    drop(attachment);
    drop(renderer_cdp);
    Ok(RuntimeControl {
        renderer_cdp_endpoint: format!("http://127.0.0.1:{renderer_cdp_port}"),
        renderer_cdp_arguments: [
            OsString::from("--remote-debugging-address=127.0.0.1"),
            OsString::from(format!("--remote-debugging-port={renderer_cdp_port}")),
        ],
        attachment_port,
        nonce: random_nonce()?,
    })
}

pub(super) enum LauncherOwnership {
    Acquired(LauncherGuard),
    Attached,
}

pub(super) fn acquire_launcher_ownership(
    installation: &DesktopInstallation,
    timeout: Duration,
) -> Result<LauncherOwnership, Box<dyn Error>> {
    let guard_path = default_guard_path()?;
    if let Some(guard) = try_acquire_launcher_guard(&guard_path)? {
        return Ok(LauncherOwnership::Acquired(guard));
    }

    let descriptor_path = default_descriptor_path()?;
    let started = Instant::now();
    let mut retry_delay = ATTACHMENT_RETRY_INITIAL_DELAY;
    while started.elapsed() < timeout {
        let descriptor = read_descriptor(&descriptor_path).ok().flatten();
        if let Some(descriptor) = &descriptor {
            if try_activate_controlled_instance(descriptor)? {
                return Ok(LauncherOwnership::Attached);
            }
            if desktop_root_process_ids_for_installation(installation)?.is_empty() {
                stop_stale_launcher(descriptor)?;
                let _ = remove_matching_descriptor(&descriptor_path, descriptor)?;
            }
        }
        if let Some(guard) = try_acquire_launcher_guard(&guard_path)? {
            return Ok(LauncherOwnership::Acquired(guard));
        }
        // A recovering Controller reports busy while one attachment owns the
        // recovery work. Back off retries so another Launcher cannot create a
        // connection storm while the healthy owner keeps its guard.
        let remaining = timeout.saturating_sub(started.elapsed());
        if remaining.is_zero() {
            break;
        }
        thread::sleep(retry_delay.min(remaining));
        retry_delay = retry_delay
            .saturating_mul(2)
            .min(ATTACHMENT_RETRY_MAX_DELAY);
    }
    Err("another codexhost Launcher did not become attachable before timeout".into())
}

pub(super) fn endpoint_ready(port: u16, timeout: Duration) -> bool {
    TcpStream::connect_timeout(
        &format!("127.0.0.1:{port}")
            .parse()
            .expect("valid loopback socket address"),
        timeout,
    )
    .is_ok()
}

pub(super) fn wait_for_host_chain(
    desktop: &ProcessSnapshot,
    options: &ResolvedLaunchOptions,
    timeout: Duration,
) -> Result<bool, Box<dyn Error>> {
    let started = Instant::now();
    while started.elapsed() < timeout {
        if descendant_executable_pair_exists(desktop, &options.shim, &options.node)? {
            return Ok(true);
        }
        thread::sleep(Duration::from_millis(100));
    }
    Ok(false)
}

pub(super) fn publish_runtime_descriptor(
    descriptor_path: &Path,
    control: &RuntimeControl,
) -> Result<RuntimeDescriptorGuard, Box<dyn Error>> {
    let descriptor = RuntimeDescriptor::new(
        std::process::id(),
        control.attachment_port,
        control.nonce.clone(),
    )?;
    Ok(RuntimeDescriptorGuard::publish(
        descriptor_path.to_path_buf(),
        descriptor,
    )?)
}

fn connect_controlled_instance(descriptor: &RuntimeDescriptor) -> std::io::Result<TcpStream> {
    TcpStream::connect_timeout(
        &format!("127.0.0.1:{}", descriptor.control_port)
            .parse()
            .expect("valid loopback socket address"),
        Duration::from_secs(2),
    )
}

fn send_controlled_attachment(
    stream: TcpStream,
    descriptor: &RuntimeDescriptor,
) -> Result<bool, Box<dyn Error>> {
    send_controlled_attachment_with_timeout(stream, descriptor, Duration::from_secs(10))
}

fn send_controlled_attachment_with_timeout(
    mut stream: TcpStream,
    descriptor: &RuntimeDescriptor,
    read_timeout: Duration,
) -> Result<bool, Box<dyn Error>> {
    stream.set_read_timeout(Some(read_timeout))?;
    stream.set_write_timeout(Some(Duration::from_secs(2)))?;
    writeln!(stream, "ATTACH {}", descriptor.nonce)?;
    let mut response = String::new();
    match BufReader::new(stream).read_line(&mut response) {
        Ok(_) => {}
        // An orderly Controller close is an empty response, but Winsock may surface the same
        // close as WSAECONNRESET. Both mean the controlled Desktop is not attachable yet.
        Err(error)
            if matches!(
                error.kind(),
                io::ErrorKind::ConnectionAborted
                    | io::ErrorKind::ConnectionReset
                    | io::ErrorKind::TimedOut
                    | io::ErrorKind::WouldBlock
            ) =>
        {
            return Ok(false);
        }
        Err(error) => return Err(error.into()),
    }
    match response.trim_end() {
        "ready" => Ok(true),
        "busy" => Ok(false),
        "rejected" => Err("Desktop Controller rejected the attachment nonce".into()),
        "failed" => Err("Desktop Controller could not restore the running Desktop".into()),
        // An empty or malformed status can come from a Controller that is still
        // restoring the Desktop. Treat it as transient rather than abandoning
        // the healthy Launcher that still owns the runtime guard.
        _ => Ok(false),
    }
}

pub(super) fn try_activate_controlled_instance(
    descriptor: &RuntimeDescriptor,
) -> Result<bool, Box<dyn Error>> {
    let stream = match connect_controlled_instance(descriptor) {
        Ok(stream) => stream,
        Err(_) => return Ok(false),
    };
    send_controlled_attachment(stream, descriptor)
}

#[cfg(target_os = "windows")]
pub(super) fn stop_stale_launcher(descriptor: &RuntimeDescriptor) -> Result<(), Box<dyn Error>> {
    if descriptor.launcher_pid == std::process::id() || !process_exists(descriptor.launcher_pid) {
        return Ok(());
    }
    let expected = env::current_exe()?.canonicalize()?;
    if !recorded_launcher_is_current(process_executable_path(descriptor.launcher_pid), &expected) {
        return Ok(());
    }
    terminate_process_by_id(descriptor.launcher_pid)?;
    let started = Instant::now();
    while process_exists(descriptor.launcher_pid) && started.elapsed() < Duration::from_secs(2) {
        thread::sleep(Duration::from_millis(20));
    }
    if process_exists(descriptor.launcher_pid) {
        return Err(format!(
            "stale codexhost launcher PID {} did not exit before timeout",
            descriptor.launcher_pid
        )
        .into());
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
pub(super) fn stop_stale_launcher(_descriptor: &RuntimeDescriptor) -> Result<(), Box<dyn Error>> {
    Ok(())
}

/// A recorded launcher PID may since have been reused by an unrelated process.
/// Only an inspected executable matching this launcher proves ownership; a PID
/// the current user cannot inspect (for example a reused SYSTEM service PID)
/// is not ours to stop and must not block startup.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn recorded_launcher_is_current<E>(inspected: Result<PathBuf, E>, expected: &Path) -> bool {
    inspected
        .ok()
        .and_then(|path| path.canonicalize().ok())
        .is_some_and(|path| path == expected)
}

pub(super) fn managed_processes(
    data: &Path,
) -> Result<
    Option<(
        codexhost_platform::ProcessSnapshot,
        codexhost_platform::ProcessSnapshot,
    )>,
    Box<dyn Error>,
> {
    let Some(descriptor) = read_descriptor(&default_descriptor_path()?)? else {
        return Ok(None);
    };
    if !endpoint_ready(descriptor.control_port, Duration::from_millis(300)) {
        return Ok(None);
    }
    let document: serde_json::Value = serde_json::from_slice(&std::fs::read(
        data.join("diagnostics/desktop-controller-v1.json"),
    )?)?;
    let pid = document["pid"]
        .as_u64()
        .and_then(|pid| u32::try_from(pid).ok())
        .ok_or("Invalid Desktop Controller pid")?;
    let launcher = codexhost_platform::process_snapshot(descriptor.launcher_pid)?;
    let controller = codexhost_platform::process_snapshot(pid)?;
    if controller.parent_id != launcher.id {
        return Err("Desktop Controller does not belong to the recorded Launcher".into());
    }
    Ok(Some((launcher, controller)))
}

pub(super) fn stop_managed(data: &Path) -> Result<bool, Box<dyn Error>> {
    let Some((launcher, controller)) = managed_processes(data)? else {
        return Ok(false);
    };
    codexhost_platform::terminate_process_instance(&controller, false)?;
    crate::host_service::wait_for_shutdown(
        None,
        Some(&(&launcher).into()),
        Duration::from_secs(10),
    )?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    fn descriptor(port: u16) -> RuntimeDescriptor {
        RuntimeDescriptor::new(10, port, "0123456789abcdef0123456789abcdef".into())
            .expect("runtime descriptor")
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn host_chain_does_not_accept_unrelated_sibling_processes() {
        use codexhost_platform::{process_snapshot, spawn_supervised};
        use std::process::{Command, Stdio};

        let sleep = Path::new("/bin/sleep").canonicalize().unwrap();
        let mut command = Command::new("/bin/bash");
        command
            .args(["-c", "\"$1\" 30 & \"$1\" 30 & wait", "fixture"])
            .arg(&sleep)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let mut root = spawn_supervised(&mut command).unwrap();
        let snapshot = process_snapshot(root.id()).unwrap();
        let started = Instant::now();
        while codexhost_platform::process_snapshots()
            .unwrap()
            .iter()
            .filter(|process| process.parent_id == snapshot.id && process.executable == sleep)
            .count()
            < 2
        {
            assert!(
                started.elapsed() < Duration::from_secs(2),
                "sibling fixture did not start"
            );
            thread::sleep(Duration::from_millis(10));
        }
        let options = ResolvedLaunchOptions {
            shim: sleep.clone(),
            node: sleep.clone(),
            host_runtime: sleep.clone(),
            desktop_controller: sleep.clone(),
            renderer_extension: sleep,
            pi: None,
        };
        // A pair of sibling executables is not a parent -> child runtime chain.
        let ready = wait_for_host_chain(&snapshot, &options, Duration::from_millis(200)).unwrap();
        root.force_terminate().unwrap();
        root.wait().unwrap();
        assert!(
            !ready,
            "unrelated descendants must not satisfy Host chain readiness"
        );
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn host_chain_accepts_the_selected_child_of_a_descendant() {
        use codexhost_platform::{process_snapshot, spawn_supervised};
        use std::process::{Command, Stdio};

        let shell = Path::new("/bin/bash").canonicalize().unwrap();
        let sleep = Path::new("/bin/sleep").canonicalize().unwrap();
        let mut command = Command::new(&shell);
        command
            .args([
                "-c",
                "\"$1\" -c '\"$1\" 30 & wait' fixture \"$2\" & wait",
                "fixture",
            ])
            .arg(&shell)
            .arg(&sleep)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let mut root = spawn_supervised(&mut command).unwrap();
        let snapshot = process_snapshot(root.id()).unwrap();
        let options = ResolvedLaunchOptions {
            shim: shell,
            node: sleep.clone(),
            host_runtime: sleep.clone(),
            desktop_controller: sleep.clone(),
            renderer_extension: sleep,
            pi: None,
        };
        let ready = wait_for_host_chain(&snapshot, &options, Duration::from_secs(2)).unwrap();
        root.force_terminate().unwrap();
        root.wait().unwrap();
        assert!(
            ready,
            "the selected parent and child must satisfy Host chain readiness"
        );
    }

    #[test]
    fn recorded_launcher_requires_an_inspectable_matching_executable() {
        let expected = env::current_exe()
            .expect("current executable")
            .canonicalize()
            .expect("canonical current executable");

        let access_denied: Result<PathBuf, io::Error> =
            Err(io::Error::from(io::ErrorKind::PermissionDenied));
        assert!(!recorded_launcher_is_current(access_denied, &expected));

        let missing = expected.with_file_name("codexhost-missing-launcher-executable");
        assert!(!recorded_launcher_is_current(
            Ok::<_, io::Error>(missing),
            &expected
        ));

        let other = expected
            .parent()
            .expect("executable directory")
            .to_path_buf();
        assert!(!recorded_launcher_is_current(
            Ok::<_, io::Error>(other),
            &expected
        ));

        assert!(recorded_launcher_is_current(
            Ok::<_, io::Error>(expected.clone()),
            &expected
        ));
    }

    #[test]
    fn controlled_attachment_treats_busy_as_transient() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("attachment listener");
        let descriptor = descriptor(listener.local_addr().expect("attachment address").port());
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("attachment connection");
            let mut request = String::new();
            BufReader::new(stream.try_clone().expect("clone stream"))
                .read_line(&mut request)
                .expect("attachment request");
            writeln!(stream, "busy").expect("attachment response");
        });

        assert!(!try_activate_controlled_instance(&descriptor).expect("busy Controller"));
        server.join().expect("attachment server");
    }

    #[test]
    fn controlled_attachment_treats_read_timeout_as_transient() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("attachment listener");
        let descriptor = descriptor(listener.local_addr().expect("attachment address").port());
        let server = thread::spawn(move || {
            let (stream, _) = listener.accept().expect("attachment connection");
            let mut request = String::new();
            BufReader::new(stream.try_clone().expect("clone stream"))
                .read_line(&mut request)
                .expect("attachment request");
            thread::sleep(Duration::from_millis(100));
            drop(stream);
        });
        let stream = connect_controlled_instance(&descriptor).expect("Controller connection");

        assert!(
            !send_controlled_attachment_with_timeout(
                stream,
                &descriptor,
                Duration::from_millis(20)
            )
            .expect("timed-out Controller")
        );
        server.join().expect("attachment server");
    }
}
