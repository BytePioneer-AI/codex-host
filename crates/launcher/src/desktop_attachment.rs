#[cfg(target_os = "windows")]
use std::env;
use std::error::Error;
use std::ffi::OsString;
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::thread;
use std::time::{Duration, Instant};

use codexhost_platform::{descendant_executable_exists, desktop_root_process_ids};
#[cfg(target_os = "windows")]
use codexhost_platform::{process_executable_path, process_exists, terminate_process_by_id};

use crate::ResolvedLaunchOptions;
use crate::runtime_instance::{
    LauncherGuard, RuntimeDescriptor, RuntimeDescriptorGuard, default_descriptor_path,
    default_guard_path, random_nonce, read_descriptor, remove_matching_descriptor,
    try_acquire_launcher_guard,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum CompatibilityUpdateOutcome {
    UpdateStarted,
    Current,
    Unavailable,
}

#[derive(Debug)]
pub(super) struct RuntimeControl {
    pub(super) inspector_endpoint: String,
    pub(super) inspector_argument: OsString,
    pub(super) attachment_port: u16,
    pub(super) nonce: String,
}

pub(super) fn allocate_runtime_control() -> Result<RuntimeControl, Box<dyn Error>> {
    let inspector = TcpListener::bind(("127.0.0.1", 0))?;
    let attachment = TcpListener::bind(("127.0.0.1", 0))?;
    let inspector_port = inspector.local_addr()?.port();
    let attachment_port = attachment.local_addr()?.port();
    drop(attachment);
    drop(inspector);
    Ok(RuntimeControl {
        inspector_endpoint: format!("http://127.0.0.1:{inspector_port}"),
        inspector_argument: OsString::from(format!("--inspect=127.0.0.1:{inspector_port}")),
        attachment_port,
        nonce: random_nonce()?,
    })
}

pub(super) enum LauncherOwnership {
    Acquired(LauncherGuard),
    Attached,
}

pub(super) fn acquire_launcher_ownership(
    timeout: Duration,
) -> Result<LauncherOwnership, Box<dyn Error>> {
    let guard_path = default_guard_path()?;
    if let Some(guard) = try_acquire_launcher_guard(&guard_path)? {
        return Ok(LauncherOwnership::Acquired(guard));
    }

    let descriptor_path = default_descriptor_path()?;
    let started = Instant::now();
    while started.elapsed() < timeout {
        let descriptor = read_descriptor(&descriptor_path).ok().flatten();
        if let Some(descriptor) = &descriptor {
            if try_activate_controlled_instance(descriptor)? {
                return Ok(LauncherOwnership::Attached);
            }
            if desktop_root_process_ids()?.is_empty() {
                stop_stale_launcher(descriptor)?;
                let _ = remove_matching_descriptor(&descriptor_path, descriptor)?;
            }
        }
        if let Some(guard) = try_acquire_launcher_guard(&guard_path)? {
            return Ok(LauncherOwnership::Acquired(guard));
        }
        thread::sleep(Duration::from_millis(100));
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

fn compatibility_update_outcome(
    response: &str,
) -> Result<CompatibilityUpdateOutcome, Box<dyn Error>> {
    match response.trim_end() {
        "update-started" => Ok(CompatibilityUpdateOutcome::UpdateStarted),
        "current" => Ok(CompatibilityUpdateOutcome::Current),
        "unavailable" => Ok(CompatibilityUpdateOutcome::Unavailable),
        "rejected" => Err("Desktop Controller rejected the compatibility update nonce".into()),
        "failed" => Err("Desktop Controller could not check for a compatibility update".into()),
        _ => Err("compatibility update returned an invalid response".into()),
    }
}

pub(super) fn request_compatibility_update(
    control: &RuntimeControl,
) -> Result<CompatibilityUpdateOutcome, Box<dyn Error>> {
    let mut stream = TcpStream::connect_timeout(
        &format!("127.0.0.1:{}", control.attachment_port)
            .parse()
            .expect("valid loopback socket address"),
        Duration::from_secs(2),
    )?;
    stream.set_read_timeout(Some(Duration::from_secs(25)))?;
    stream.set_write_timeout(Some(Duration::from_secs(2)))?;
    writeln!(stream, "COMPATIBILITY_UPDATE {}", control.nonce)?;
    let mut response = String::new();
    BufReader::new(stream).read_line(&mut response)?;
    if response.len() > 32 {
        return Err("Desktop Controller compatibility update response is too long".into());
    }
    compatibility_update_outcome(&response)
}

pub(super) fn publish_runtime_descriptor(
    control: &RuntimeControl,
) -> Result<RuntimeDescriptorGuard, Box<dyn Error>> {
    let descriptor = RuntimeDescriptor::new(
        std::process::id(),
        control.attachment_port,
        control.nonce.clone(),
    )?;
    Ok(RuntimeDescriptorGuard::publish(
        default_descriptor_path()?,
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
    mut stream: TcpStream,
    descriptor: &RuntimeDescriptor,
) -> Result<bool, Box<dyn Error>> {
    stream.set_read_timeout(Some(Duration::from_secs(10)))?;
    stream.set_write_timeout(Some(Duration::from_secs(2)))?;
    writeln!(stream, "ATTACH {}", descriptor.nonce)?;
    let mut response = String::new();
    BufReader::new(stream).read_line(&mut response)?;
    match response.trim_end() {
        "ready" => Ok(true),
        "rejected" => Err("Desktop Controller rejected the attachment nonce".into()),
        "failed" => Err("Desktop Controller could not restore the running Desktop".into()),
        // An empty or malformed status means the Controller was still restoring
        // the Desktop when its socket timeout fired. The acquisition loop treats
        // this as transient and retries rather than failing the whole launch.
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
    let actual = process_executable_path(descriptor.launcher_pid)?.canonicalize()?;
    if actual != expected {
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

#[cfg(test)]
mod tests {
    use std::ffi::OsString;
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;
    use std::thread;

    use super::{CompatibilityUpdateOutcome, RuntimeControl, request_compatibility_update};

    fn request(response: &'static str) -> Result<CompatibilityUpdateOutcome, String> {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind fixture server");
        let port = listener.local_addr().expect("fixture address").port();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept fixture request");
            let mut line = String::new();
            BufReader::new(stream.try_clone().expect("clone fixture stream"))
                .read_line(&mut line)
                .expect("read fixture request");
            assert_eq!(
                line,
                "COMPATIBILITY_UPDATE 0123456789abcdef0123456789abcdef\n"
            );
            writeln!(stream, "{response}").expect("write fixture response");
        });
        let control = RuntimeControl {
            inspector_endpoint: "http://127.0.0.1:1".into(),
            inspector_argument: OsString::from("--inspect=127.0.0.1:1"),
            attachment_port: port,
            nonce: "0123456789abcdef0123456789abcdef".into(),
        };
        let outcome = request_compatibility_update(&control).map_err(|error| error.to_string());
        server.join().expect("join fixture server");
        outcome
    }

    #[test]
    fn parses_only_fixed_compatibility_update_outcomes() {
        assert_eq!(
            request("update-started"),
            Ok(CompatibilityUpdateOutcome::UpdateStarted)
        );
        assert_eq!(request("current"), Ok(CompatibilityUpdateOutcome::Current));
        assert_eq!(
            request("unavailable"),
            Ok(CompatibilityUpdateOutcome::Unavailable)
        );
        assert!(request("unexpected private detail").is_err());
    }
}
