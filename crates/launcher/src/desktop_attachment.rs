#[cfg(target_os = "windows")]
use std::env;
use std::error::Error;
use std::ffi::OsString;
use std::io::{self, BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
#[cfg(target_os = "macos")]
use std::process::Command;
use std::thread;
use std::time::{Duration, Instant};

use codexhost_platform::{
    DesktopInstallation, descendant_executable_exists, desktop_root_process_ids_for_installation,
    process_snapshot, terminate_process_instance,
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
const ORPHANED_CONTROLLER_STOP_GRACE: Duration = Duration::from_secs(2);

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
                recover_stale_controller(descriptor, &descriptor_path)?;
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
    desktop_pid: u32,
    options: &ResolvedLaunchOptions,
    timeout: Duration,
) -> Result<bool, Box<dyn Error>> {
    let started = Instant::now();
    while started.elapsed() < timeout {
        if descendant_executable_exists(desktop_pid, &options.shim)?
            && descendant_executable_exists(desktop_pid, &options.node)?
        {
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

/// Stop a Desktop Controller that outlived its Launcher and Desktop.
///
/// A failed or interrupted `npm start` can kill Desktop while leaving the
/// Controller listening on the recorded attachment port. The next launch then
/// owns the Launcher lock with no Desktop. Only a listener whose command line
/// still carries this descriptor's attachment port and nonce is ours to stop.
pub(super) fn recover_stale_controller(
    descriptor: &RuntimeDescriptor,
    descriptor_path: &Path,
) -> Result<(), Box<dyn Error>> {
    stop_orphaned_controller(descriptor)?;
    stop_stale_launcher(descriptor)?;
    let _ = remove_matching_descriptor(descriptor_path, descriptor)?;
    Ok(())
}

pub(super) fn stop_orphaned_controller(
    descriptor: &RuntimeDescriptor,
) -> Result<(), Box<dyn Error>> {
    let matches = matching_controller_process_ids(descriptor)?;
    if matches.is_empty() {
        return Ok(());
    }
    for process_id in &matches {
        terminate_controller_process(*process_id, false)?;
    }
    if wait_for_controller_exit(descriptor, ORPHANED_CONTROLLER_STOP_GRACE)? {
        return Ok(());
    }
    for process_id in matching_controller_process_ids(descriptor)? {
        terminate_controller_process(process_id, true)?;
    }
    if wait_for_controller_exit(descriptor, ORPHANED_CONTROLLER_STOP_GRACE)? {
        return Ok(());
    }
    Err(format!(
        "leftover Desktop Controller on port {} did not exit before timeout",
        descriptor.control_port
    )
    .into())
}

fn command_line_matches_controller(command: &str, descriptor: &RuntimeDescriptor) -> bool {
    let port = descriptor.control_port.to_string();
    let mut saw_port = false;
    let mut saw_nonce = false;
    let mut arguments = command.split_whitespace();
    while let Some(argument) = arguments.next() {
        match argument {
            "--attachment-port" => {
                saw_port |= arguments.next() == Some(port.as_str());
            }
            "--attachment-nonce" => {
                saw_nonce |= arguments.next() == Some(descriptor.nonce.as_str());
            }
            _ => {}
        }
    }
    saw_port && saw_nonce
}

pub(super) fn matching_controller_process_ids(
    descriptor: &RuntimeDescriptor,
) -> Result<Vec<u32>, Box<dyn Error>> {
    let mut matches = Vec::new();
    for (process_id, command) in process_command_lines()? {
        if process_id == std::process::id() {
            continue;
        }
        if command_line_matches_controller(&command, descriptor) {
            matches.push(process_id);
        }
    }
    Ok(matches)
}

fn terminate_controller_process(process_id: u32, force: bool) -> Result<(), Box<dyn Error>> {
    if process_id == std::process::id() {
        return Ok(());
    }
    match process_snapshot(process_id) {
        Ok(snapshot) => {
            terminate_process_instance(&snapshot, force)?;
            Ok(())
        }
        Err(_) => Ok(()),
    }
}

pub(super) fn wait_for_controller_exit(
    descriptor: &RuntimeDescriptor,
    timeout: Duration,
) -> Result<bool, Box<dyn Error>> {
    wait_for_known_controller_exit(descriptor, &[], timeout)
}

pub(super) fn wait_for_known_controller_exit(
    descriptor: &RuntimeDescriptor,
    known_process_ids: &[u32],
    timeout: Duration,
) -> Result<bool, Box<dyn Error>> {
    let started = Instant::now();
    loop {
        // A Controller can close its socket before its asynchronous cleanup finishes.
        // The Launcher cannot finish shutdown while that process remains alive.
        let known_alive = known_process_ids
            .iter()
            .copied()
            .any(|process_id| process_snapshot(process_id).is_ok());
        if matching_controller_process_ids(descriptor)?.is_empty()
            && !known_alive
            && !endpoint_ready(descriptor.control_port, Duration::from_millis(50))
        {
            return Ok(true);
        }
        if started.elapsed() >= timeout {
            return Ok(false);
        }
        thread::sleep(Duration::from_millis(20));
    }
}

#[cfg(target_os = "macos")]
fn process_command_lines() -> Result<Vec<(u32, String)>, Box<dyn Error>> {
    let output = Command::new("/bin/ps")
        .args(["-axww", "-o", "pid=,command="])
        .output()?;
    if !output.status.success() {
        return Err("cannot list process command lines".into());
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            let (pid, command) = line.split_once(char::is_whitespace)?;
            Some((pid.parse().ok()?, command.trim().to_owned()))
        })
        .collect())
}

#[cfg(target_os = "linux")]
fn process_command_lines() -> Result<Vec<(u32, String)>, Box<dyn Error>> {
    let mut commands = Vec::new();
    for entry in std::fs::read_dir("/proc")?.filter_map(Result::ok) {
        let Some(process_id) = entry
            .file_name()
            .to_str()
            .and_then(|name| name.parse::<u32>().ok())
        else {
            continue;
        };
        let Ok(bytes) = std::fs::read(entry.path().join("cmdline")) else {
            continue;
        };
        let command = bytes
            .split(|byte| *byte == 0)
            .filter(|argument| !argument.is_empty())
            .map(|argument| String::from_utf8_lossy(argument).into_owned())
            .collect::<Vec<_>>()
            .join(" ");
        if !command.is_empty() {
            commands.push((process_id, command));
        }
    }
    Ok(commands)
}

#[cfg(target_os = "windows")]
fn process_command_lines() -> Result<Vec<(u32, String)>, Box<dyn Error>> {
    Ok(Vec::new())
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    fn descriptor(port: u16) -> RuntimeDescriptor {
        RuntimeDescriptor::new(10, port, "0123456789abcdef0123456789abcdef".into())
            .expect("runtime descriptor")
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

    #[test]
    fn controller_command_matches_exact_attachment_port_and_nonce() {
        let descriptor = descriptor(60218);
        assert!(command_line_matches_controller(
            "node release-main.js --attachment-port 60218 --attachment-nonce 0123456789abcdef0123456789abcdef",
            &descriptor
        ));
        assert!(
            !command_line_matches_controller(
                "node release-main.js --attachment-port 602181 --attachment-nonce 0123456789abcdef0123456789abcdef",
                &descriptor
            ),
            "port 60218 must not match 602181"
        );
        assert!(!command_line_matches_controller(
            "node release-main.js --attachment-port 60218 --attachment-nonce ffffffffffffffffffffffffffffffff",
            &descriptor
        ));
        assert!(!command_line_matches_controller(
            "node console-server.mjs serve",
            &descriptor
        ));
    }

    #[cfg(unix)]
    fn spawn_matching_listener(port: u16, nonce: &str, close_only: bool) -> std::process::Child {
        let signal_handler = if close_only {
            "signal.signal(signal.SIGTERM, lambda *_: server.close())\n"
        } else {
            ""
        };
        let script = format!(
            "import socket, time, signal\n\
             server = socket.socket()\n\
             server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)\n\
             server.bind(('127.0.0.1', {port}))\n\
             server.listen(1)\n\
             {signal_handler}\
             while True:\n\
             \ttime.sleep(0.2)\n"
        );
        let mut command = std::process::Command::new("python3");
        command
            .args([
                "-c",
                &script,
                "--attachment-port",
                &port.to_string(),
                "--attachment-nonce",
                nonce,
            ])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        command.spawn().expect("start leftover Controller fixture")
    }

    #[cfg(unix)]
    fn wait_until_listening(port: u16) {
        let started = Instant::now();
        while !endpoint_ready(port, Duration::from_millis(50)) {
            assert!(
                started.elapsed() < Duration::from_secs(2),
                "leftover Controller fixture did not listen"
            );
            thread::sleep(Duration::from_millis(20));
        }
    }

    #[cfg(unix)]
    #[test]
    fn stop_orphaned_controller_terminates_a_matching_listener() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("reserve port");
        let port = listener.local_addr().expect("reserved address").port();
        drop(listener);
        let descriptor = descriptor(port);
        let mut child = spawn_matching_listener(port, &descriptor.nonce, false);
        wait_until_listening(port);

        let result = stop_orphaned_controller(&descriptor);
        let _ = child.kill();
        let _ = child.wait();
        result.expect("stop leftover Controller");
        assert!(
            !endpoint_ready(port, Duration::from_millis(50)),
            "matching leftover Controller kept its attachment port"
        );
    }

    #[cfg(unix)]
    #[test]
    fn stop_orphaned_controller_escalates_after_socket_closes_but_process_stays_alive() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("reserve port");
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let descriptor = descriptor(port);
        let mut child = spawn_matching_listener(port, &descriptor.nonce, true);
        wait_until_listening(port);
        let result = stop_orphaned_controller(&descriptor);
        let exited = child.try_wait().unwrap().is_some();
        let _ = child.kill();
        let _ = child.wait();
        result.expect("stop Controller whose socket closed during cleanup");
        assert!(exited, "Controller process survived shutdown");
    }

    #[cfg(unix)]
    #[test]
    fn stop_orphaned_controller_leaves_an_unrelated_listener() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("unrelated listener");
        let port = listener.local_addr().expect("unrelated address").port();
        let descriptor = descriptor(port);

        stop_orphaned_controller(&descriptor).expect("ignore unrelated listener");
        assert!(
            endpoint_ready(port, Duration::from_millis(50)),
            "unrelated listener on the recorded port was terminated"
        );
        drop(listener);
    }
}
