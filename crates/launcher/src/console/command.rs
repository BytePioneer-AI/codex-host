//! Bounded execution of the short-lived Console CLI, not its detached server.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Read};
use std::path::PathBuf;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use crate::runtime_instance::random_nonce;

// The Console's normal replace-and-start path can take about 24 seconds.
pub(super) const COMMAND_TIMEOUT: Duration = Duration::from_secs(30);
const COMMAND_POLL_INTERVAL: Duration = Duration::from_millis(20);
const TERMINATION_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_STDOUT_BYTES: u64 = 64 * 1024;

pub(super) struct ConsoleOutput {
    pub status: ExitStatus,
    pub stdout: Vec<u8>,
}

struct TemporaryStdoutPath(PathBuf);

impl Drop for TemporaryStdoutPath {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

struct CapturedStdout {
    // Fields drop in order: close our file handle before deleting on Windows.
    file: File,
    path: TemporaryStdoutPath,
}

impl CapturedStdout {
    fn new() -> io::Result<Self> {
        let path = std::env::temp_dir().join(format!(
            "codexhost-console-{}-{}.stdout",
            std::process::id(),
            random_nonce()?
        ));
        let mut options = OpenOptions::new();
        options.read(true).write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = options.open(&path)?;
        Ok(Self {
            file,
            path: TemporaryStdoutPath(path),
        })
    }

    fn check_size(&self) -> io::Result<()> {
        if self.file.metadata()?.len() > MAX_STDOUT_BYTES {
            return Err(io::Error::other("codexhost console output exceeded 64 KiB"));
        }
        Ok(())
    }

    fn read(&self) -> io::Result<Vec<u8>> {
        let mut bytes = Vec::new();
        // Reopen with an independent cursor: try_clone() shares its offset
        // with the writer, which an inherited stdout could still advance.
        File::open(&self.path.0)?
            .take(MAX_STDOUT_BYTES + 1)
            .read_to_end(&mut bytes)?;
        // A descendant may still hold the output file and write after the CLI
        // exited; the read limit also bounds memory in that case.
        if bytes.len() as u64 > MAX_STDOUT_BYTES {
            return Err(io::Error::other("codexhost console output exceeded 64 KiB"));
        }
        Ok(bytes)
    }
}

fn stop_command(child: &mut Child) -> io::Result<()> {
    // Stop only the CLI we spawned. The Console deliberately detaches its
    // server; a process-tree guard would terminate that healthy service too.
    let kill_result = child.kill();
    let started = Instant::now();
    loop {
        if child.try_wait()?.is_some() {
            return Ok(());
        }
        // Killing can race with a normal exit. Check/reap that exit first;
        // otherwise report failure without an unbounded wait().
        if let Err(error) = kill_result {
            return Err(error);
        }
        if started.elapsed() >= TERMINATION_TIMEOUT {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "codexhost console CLI termination could not be confirmed",
            ));
        }
        thread::sleep(COMMAND_POLL_INTERVAL);
    }
}

pub(super) fn run_console_command(
    process: &mut Command,
    capture_stdout: bool,
    timeout: Duration,
) -> io::Result<ConsoleOutput> {
    let capture = capture_stdout.then(CapturedStdout::new).transpose()?;
    if let Some(capture) = &capture {
        // A regular file avoids both a full pipe deadlock and waiting for EOF
        // from a detached process that accidentally inherited stdout.
        process.stdout(Stdio::from(capture.file.try_clone()?));
    }
    let started = Instant::now();
    let spawned = process.spawn();
    if capture_stdout {
        // Command retains its configured stdio. Close its clone on every spawn
        // result before CapturedStdout's RAII deletion, especially on Windows.
        process.stdout(Stdio::null());
    }
    let mut child = spawned?;
    let result = (|| {
        loop {
            if let Some(capture) = &capture {
                capture.check_size()?;
            }
            if let Some(status) = child.try_wait()? {
                let stdout = match &capture {
                    Some(capture) => capture.read()?,
                    None => Vec::new(),
                };
                return Ok(ConsoleOutput { status, stdout });
            }
            if started.elapsed() >= timeout {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    format!(
                        "codexhost console CLI timed out after {} ms",
                        timeout.as_millis()
                    ),
                ));
            }
            thread::sleep(COMMAND_POLL_INTERVAL);
        }
    })();
    if let Err(error) = &result
        && let Err(cleanup) = stop_command(&mut child)
    {
        return Err(io::Error::new(
            error.kind(),
            format!("{error}; could not stop Console CLI: {cleanup}"),
        ));
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    const FIXTURE_MODE: &str = "CODEXHOST_CONSOLE_COMMAND_TEST_MODE";
    const FIXTURE_MARKER: &str = "CODEXHOST_CONSOLE_COMMAND_TEST_MARKER";
    const FIXTURE_TEST: &str = "console::command::tests::command_fixture";

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "codexhost-console-command-test-{}",
                random_nonce().expect("test nonce")
            ));
            fs::create_dir(&path).expect("create test directory");
            Self(path)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    struct DetachedFixtureShutdown(PathBuf);

    impl DetachedFixtureShutdown {
        fn stop(&self) -> io::Result<()> {
            fs::write(self.0.with_extension("stop"), b"stop")?;
            let started = Instant::now();
            while !self.0.with_extension("stopped").exists() {
                if started.elapsed() >= Duration::from_secs(2) {
                    return Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        "detached fixture did not acknowledge shutdown",
                    ));
                }
                thread::sleep(COMMAND_POLL_INTERVAL);
            }
            Ok(())
        }
    }

    impl Drop for DetachedFixtureShutdown {
        fn drop(&mut self) {
            // Also shut down if the test panics after starting the fixture.
            let _ = self.stop();
        }
    }

    fn fixture_command(mode: &str) -> Command {
        let mut command = Command::new(std::env::current_exe().expect("test executable"));
        command
            .args(["--exact", FIXTURE_TEST, "--nocapture"])
            .env(FIXTURE_MODE, mode)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(target_os = "windows")]
        codexhost_platform::configure_background_command(&mut command);
        command
    }

    #[test]
    fn command_fixture() {
        let Ok(mode) = std::env::var(FIXTURE_MODE) else {
            return;
        };
        match mode.as_str() {
            "success" => println!("codexhost console: http://127.0.0.1:26339/"),
            "nonzero" => std::process::exit(7),
            "oversized" | "hang" => {
                fs::write(
                    std::env::var_os(FIXTURE_MARKER).expect("PID marker"),
                    std::process::id().to_string(),
                )
                .expect("write CLI PID");
                if mode == "oversized" {
                    std::io::stdout()
                        .write_all(&vec![b'x'; MAX_STDOUT_BYTES as usize + 1])
                        .expect("write excessive stdout");
                }
                thread::sleep(Duration::from_secs(60));
            }
            "descendant" | "hang-with-descendant" => {
                let mut command = fixture_command("leaf");
                command.stdout(Stdio::inherit());
                #[cfg(unix)]
                {
                    use std::os::unix::process::CommandExt;
                    command.process_group(0);
                }
                let child = command.spawn().expect("spawn detached stdout holder");
                fs::write(
                    std::env::var_os(FIXTURE_MARKER).expect("PID marker"),
                    child.id().to_string(),
                )
                .expect("write descendant PID");
                // Deliberately outlive this CLI, like the real Console server.
                // The owning test requests and confirms cooperative shutdown.
                drop(child);
                println!("codexhost console: http://127.0.0.1:26339/");
                if mode == "hang-with-descendant" {
                    thread::sleep(Duration::from_secs(60));
                }
            }
            "leaf" => {
                let marker =
                    PathBuf::from(std::env::var_os(FIXTURE_MARKER).expect("shutdown marker"));
                let started = Instant::now();
                // Do not leave a live orphan if its test process crashes.
                while !marker.with_extension("stop").exists()
                    && started.elapsed() < Duration::from_secs(5)
                {
                    thread::sleep(COMMAND_POLL_INTERVAL);
                }
                fs::write(marker.with_extension("stopped"), b"stopped")
                    .expect("acknowledge fixture shutdown");
                std::process::exit(0);
            }
            _ => panic!("unknown Console CLI fixture mode: {mode}"),
        }
    }

    #[test]
    fn command_captures_success_and_preserves_nonzero_exit() {
        let success = run_console_command(
            &mut fixture_command("success"),
            true,
            Duration::from_secs(5),
        )
        .expect("successful CLI");
        assert!(success.status.success());
        assert!(String::from_utf8_lossy(&success.stdout).contains("http://127.0.0.1:26339/"));
        let failure = run_console_command(
            &mut fixture_command("nonzero"),
            false,
            Duration::from_secs(5),
        )
        .expect("nonzero CLI result");
        assert_eq!(failure.status.code(), Some(7));
    }

    #[test]
    fn command_timeout_and_excessive_output_stop_and_reap_the_cli() {
        let directory = TestDirectory::new();
        for (mode, capture_stdout, kind) in [
            ("hang", false, io::ErrorKind::TimedOut),
            ("hang", true, io::ErrorKind::TimedOut),
            ("oversized", true, io::ErrorKind::Other),
        ] {
            let marker = directory.0.join(format!("{mode}-{capture_stdout}"));
            let mut command = fixture_command(mode);
            command.env(FIXTURE_MARKER, &marker);
            let started = Instant::now();
            let error = run_console_command(&mut command, capture_stdout, Duration::from_secs(1))
                .err()
                .expect("CLI must fail");
            assert_eq!(error.kind(), kind, "{error}");
            assert!(started.elapsed() < Duration::from_secs(5));
            let pid = fs::read_to_string(marker)
                .expect("fixture started")
                .parse()
                .expect("fixture PID");
            assert!(!codexhost_platform::process_exists(pid), "CLI still exists");
        }
    }

    #[test]
    fn inherited_stdout_does_not_wait_for_or_stop_a_detached_server() {
        let directory = TestDirectory::new();
        for mode in ["descendant", "hang-with-descendant"] {
            let marker = directory.0.join(mode);
            let shutdown = DetachedFixtureShutdown(marker.clone());
            let mut command = fixture_command(mode);
            command.env(FIXTURE_MARKER, &marker);
            let started = Instant::now();
            let result = run_console_command(&mut command, true, Duration::from_secs(1));
            let pid = fs::read_to_string(marker)
                .expect("descendant started")
                .parse()
                .expect("descendant PID");
            let survivor = codexhost_platform::process_exists(pid);
            let stopped = shutdown.stop();
            assert!(survivor, "detached server must survive CLI cleanup");
            stopped.expect("detached server acknowledged shutdown");
            // This is a grandchild, so Unix reaping belongs to its adoptive
            // parent. Linux process_exists() also includes unreaped zombies;
            // acknowledge its own shutdown rather than waiting for PID removal.
            assert!(started.elapsed() < Duration::from_secs(5));
            if mode == "descendant" {
                assert!(
                    result
                        .expect("CLI exits without waiting for stdout EOF")
                        .status
                        .success()
                );
            } else {
                assert_eq!(
                    result.err().expect("CLI times out").kind(),
                    io::ErrorKind::TimedOut
                );
            }
        }
    }

    #[test]
    fn captured_stdout_is_private_and_removed_after_handles_close() {
        let capture = CapturedStdout::new().expect("capture file");
        let path = capture.path.0.clone();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                capture
                    .file
                    .metadata()
                    .expect("capture metadata")
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        drop(capture);
        assert!(!path.exists());
    }
}
