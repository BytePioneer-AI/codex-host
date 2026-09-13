//! Generic process relay. Launch parameters travel on stdin, never in diagnostics.
//! Output channels are framed so child bytes cannot impersonate lifecycle receipts.

#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
mod implementation {
    use std::io::{self, BufRead, BufReader, Read, Write};
    use std::path::PathBuf;
    use std::process::{Command, Stdio};
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };
    use std::time::{Duration, Instant};

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    use codexhost_platform::spawn_supervised;
    #[cfg(target_os = "windows")]
    use codexhost_platform::spawn_supervised_before_execution;
    use codexhost_platform::{PlatformError, PrivateDirectory, SupervisedChild};
    use serde::Deserialize;
    use serde_json::{Value, json};

    const LIMIT: usize = 128 * 1024;

    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Request {
        program: PathBuf,
        arguments: Vec<String>,
        cwd: PathBuf,
        receipt_directory: PathBuf,
        receipt_name: String,
        tag: String,
    }

    fn spawn_relay_child(command: &mut Command) -> Result<SupervisedChild, PlatformError> {
        #[cfg(target_os = "windows")]
        {
            spawn_supervised_before_execution(command)
        }
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        {
            spawn_supervised(command)
        }
    }

    fn emit(value: Value) -> io::Result<()> {
        let mut output = io::stdout().lock();
        serde_json::to_writer(&mut output, &value)?;
        output.write_all(b"\n")?;
        output.flush()
    }

    fn relay(mut input: impl Read, channel: &str) -> io::Result<()> {
        let mut buffer = [0_u8; 4096];
        loop {
            let count = input.read(&mut buffer)?;
            if count == 0 {
                return Ok(());
            }
            emit(json!({"event": "output", "channel": channel, "bytes": &buffer[..count]}))?;
        }
    }

    pub(super) fn execute() -> Result<(), Box<dyn std::error::Error>> {
        let mut input = BufReader::new(io::stdin());
        let mut line = Vec::new();
        input
            .by_ref()
            .take((LIMIT + 1) as u64)
            .read_until(b'\n', &mut line)?;
        if line.len() > LIMIT || line.last() != Some(&b'\n') {
            return Err("invalid process relay request".into());
        }
        let request: Request =
            serde_json::from_slice(&line).map_err(|_| "invalid process relay request")?;
        if !request.program.is_absolute()
            || !request.cwd.is_absolute()
            || request.tag.is_empty()
            || request.tag.len() > 128
        {
            return Err("invalid process relay request".into());
        }
        // Establish private receipt storage before any child can run. A receipt is
        // written only after the retained Job has no live processes.
        let directory = PrivateDirectory::open(&request.receipt_directory, false)?;
        if directory.read(&request.receipt_name)?.is_some() {
            return Err("process receipt already exists".into());
        }
        let mut command = Command::new(request.program);
        command
            .args(request.arguments)
            .current_dir(request.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = spawn_relay_child(&mut command)?;
        let pid = child.id();
        let mut child_input = child.take_stdin().ok_or("missing process input")?;
        let child_output = child.take_stdout().ok_or("missing process output")?;
        let child_error = child
            .take_stderr()
            .ok_or("missing process diagnostic channel")?;
        emit(json!({"event": "started", "version": 1, "pid": pid}))?;
        let stopped = Arc::new(AtomicBool::new(false));
        let input_stopped = Arc::clone(&stopped);
        // Do not join this reader: the root may exit while Host stdin remains open.
        std::thread::spawn(move || {
            let _ = io::copy(&mut input, &mut child_input);
            drop(child_input);
            input_stopped.store(true, Ordering::Release);
        });
        let output = std::thread::spawn(move || relay(child_output, "stdout"));
        let error = std::thread::spawn(move || relay(child_error, "stderr"));
        let mut stopping_since = None;
        loop {
            if child.try_wait()?.is_some() {
                break;
            }
            if stopped.load(Ordering::Acquire) {
                let since = stopping_since.get_or_insert_with(Instant::now);
                if since.elapsed() >= Duration::from_millis(500) {
                    break;
                }
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        if child.has_live_processes()? {
            child.force_terminate()?;
        }
        let status = child.wait_for_tree_exit(Duration::from_secs(5))?;
        let receipt = serde_json::to_vec(
            &json!({"version": 1, "tag": request.tag, "pid": pid, "treeExited": true}),
        )?;
        directory.replace(&request.receipt_name, &receipt, None)?;
        // Receipt durability does not depend on the Host continuing to drain pipes.
        output.join().map_err(|_| "process output relay failed")??;
        error
            .join()
            .map_err(|_| "process diagnostic relay failed")??;
        emit(json!({"event": "stopped", "code": status.code()}))?;
        Ok(())
    }
}

pub(crate) fn run() -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
    {
        // Neither input, executable paths nor native child diagnostics belong in
        // launcher error messages. Child diagnostics stay in their framed channel.
        implementation::execute().map_err(|_| "supervised process relay failed".into())
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    Err("supervised process relay is not available on this platform".into())
}
