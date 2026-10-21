//! Restart only the runtime authenticated by this installation's descriptor.
use std::error::Error;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::thread;
use std::time::{Duration, Instant};

use codexhost_platform::process_executable_path;

use crate::runtime_instance::{
    RuntimeDescriptor, default_descriptor_path, default_guard_path, read_descriptor,
    try_acquire_launcher_guard,
};

fn request_stop(descriptor: &RuntimeDescriptor) -> Result<(), Box<dyn Error>> {
    let address = format!("127.0.0.1:{}", descriptor.control_port).parse()?;
    let mut stream = match TcpStream::connect_timeout(&address, Duration::from_secs(2)) {
        Ok(stream) => stream,
        Err(error) if error.kind() == std::io::ErrorKind::ConnectionRefused => {
            return crate::desktop_attachment::stop_orphaned_controller(descriptor);
        }
        Err(error) => return Err(error.into()),
    };
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    stream.set_write_timeout(Some(Duration::from_secs(2)))?;
    writeln!(stream, "STOP {}", descriptor.nonce)?;
    let mut response = String::new();
    BufReader::new(stream).take(128).read_line(&mut response)?;
    if response.trim_end() == "rejected" {
        // Older controllers have no STOP command. Only the process whose command
        // line matches this descriptor's port and nonce is eligible for shutdown.
        return crate::desktop_attachment::stop_orphaned_controller(descriptor);
    }
    if response.trim_end() != "stopping" {
        return Err("Controller cannot restart this runtime; fully quit and reopen codexhost once to load the new controller".into());
    }
    if crate::desktop_attachment::wait_for_controller_exit(descriptor, Duration::from_secs(2))? {
        return Ok(());
    }
    crate::desktop_attachment::stop_orphaned_controller(descriptor)
}

pub(super) fn stop_managed_runtime() -> Result<(), Box<dyn Error>> {
    stop_managed_runtime_at(
        &default_descriptor_path()?,
        &default_guard_path()?,
        &std::env::current_exe()?.canonicalize()?,
        Duration::from_secs(45),
    )
}

fn stop_managed_runtime_at(
    descriptor_path: &std::path::Path,
    guard_path: &std::path::Path,
    expected: &std::path::Path,
    timeout: Duration,
) -> Result<(), Box<dyn Error>> {
    let descriptor = read_descriptor(descriptor_path)?.ok_or("No managed Desktop is running")?;
    if process_executable_path(descriptor.launcher_pid)?.canonicalize()? != expected {
        return Err("The running Desktop belongs to another codexhost installation".into());
    }
    request_stop(&descriptor)?;
    let started = Instant::now();
    while started.elapsed() < timeout {
        if let Some(_guard) = try_acquire_launcher_guard(guard_path)?
            && read_descriptor(descriptor_path)?.is_none()
        {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(100));
    }
    Err("Managed Desktop did not stop before the restart timeout".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn stop_authenticates_and_requires_explicit_acknowledgment() {
        for (reply, accepted) in [
            ("stopping\n", true),
            ("ready\n", false),
            ("failed\n", false),
        ] {
            let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
            let descriptor = RuntimeDescriptor::new(
                1,
                listener.local_addr().unwrap().port(),
                "0123456789abcdef0123456789abcdef".into(),
            )
            .unwrap();
            let server = thread::spawn(move || {
                let (mut socket, _) = listener.accept().unwrap();
                let mut line = String::new();
                BufReader::new(socket.try_clone().unwrap())
                    .read_line(&mut line)
                    .unwrap();
                assert_eq!(line, "STOP 0123456789abcdef0123456789abcdef\n");
                socket.write_all(reply.as_bytes()).unwrap();
            });
            assert_eq!(request_stop(&descriptor).is_ok(), accepted);
            server.join().unwrap();
        }
    }

    #[cfg(unix)]
    #[test]
    fn acknowledged_stop_escalates_when_controller_closes_socket_but_remains_alive() {
        use std::process::{Command, Stdio};
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let descriptor =
            RuntimeDescriptor::new(1, port, crate::runtime_instance::random_nonce().unwrap())
                .unwrap();
        let mut child = Command::new("python3")
            .args([
                "-c",
                "import socket,signal,time,sys\nsignal.signal(signal.SIGTERM,signal.SIG_IGN)\ns=socket.socket()\ns.bind(('127.0.0.1',int(sys.argv[2])))\ns.listen(1)\nprint('ready',flush=True)\nc,_=s.accept()\nline=c.makefile('rb').readline()\nassert line == ('STOP '+sys.argv[4]+'\\n').encode()\nc.sendall(b'stopping\\n')\nc.close()\ns.close()\nwhile True: time.sleep(0.1)",
                "--attachment-port",
                &port.to_string(),
                "--attachment-nonce",
                &descriptor.nonce,
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let mut ready = String::new();
        BufReader::new(child.stdout.take().unwrap())
            .read_line(&mut ready)
            .unwrap();
        assert_eq!(ready.trim(), "ready");
        let result = request_stop(&descriptor);
        let exited = child.try_wait().unwrap().is_some();
        let _ = child.kill();
        let _ = child.wait();
        result.expect("finish acknowledged Controller stop");
        assert!(exited, "acknowledging Controller survived shutdown");
    }

    #[test]
    fn restart_waits_for_owned_lifecycle_and_refuses_another_installation() {
        let root = std::env::temp_dir().join(format!(
            "codexhost-restart-{}",
            crate::runtime_instance::random_nonce().unwrap()
        ));
        std::fs::create_dir(&root).unwrap();
        let descriptor_path = root.join("runtime.json");
        let guard_path = root.join("owner.lock");
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let descriptor = RuntimeDescriptor::new(
            std::process::id(),
            listener.local_addr().unwrap().port(),
            "0123456789abcdef0123456789abcdef".into(),
        )
        .unwrap();
        crate::runtime_instance::write_descriptor(&descriptor_path, &descriptor).unwrap();
        let guard = try_acquire_launcher_guard(&guard_path).unwrap().unwrap();
        let executable = std::env::current_exe().unwrap().canonicalize().unwrap();
        assert_eq!(
            stop_managed_runtime_at(
                &descriptor_path,
                &guard_path,
                &root.join("other"),
                Duration::from_secs(1)
            )
            .unwrap_err()
            .to_string(),
            "The running Desktop belongs to another codexhost installation"
        );
        let removed = descriptor_path.clone();
        let server = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut line = String::new();
            BufReader::new(socket.try_clone().unwrap())
                .read_line(&mut line)
                .unwrap();
            socket.write_all(b"stopping\n").unwrap();
            thread::sleep(Duration::from_millis(100));
            std::fs::remove_file(removed).unwrap();
            drop(guard);
        });
        stop_managed_runtime_at(
            &descriptor_path,
            &guard_path,
            &executable,
            Duration::from_secs(2),
        )
        .unwrap();
        server.join().unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
}
