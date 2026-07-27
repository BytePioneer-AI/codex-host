#![forbid(unsafe_code)]

use std::env;
use std::error::Error;
use std::ffi::OsString;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use codexhost_platform::{
    CODEX_CLI_PATH_ENV, STOCK_CODEX_PATH_ENV, canonical_existing_file, spawn_supervised,
    validate_proxy_target,
};

pub type ShimResult<T> = Result<T, Box<dyn Error>>;

pub const HOST_NODE_PATH_ENV: &str = "CODEXHOST_HOST_NODE_PATH";
pub const HOST_RUNTIME_PATH_ENV: &str = "CODEXHOST_HOST_RUNTIME_PATH";

/// Optional lifecycle hooks for diagnostics around the byte-transparent proxy core.
pub trait ProxyObserver {
    fn invocation(&self, _arguments: &[OsString], _stock_codex_path: &Path) {}

    fn exit(&self, _child_id: u32, _status: &ExitStatus, _elapsed: Duration) {}
}

struct NoopProxyObserver;

impl ProxyObserver for NoopProxyObserver {}

fn copy_stream<R, W>(mut reader: R, mut writer: W) -> io::Result<u64>
where
    R: Read,
    W: Write,
{
    let copied = io::copy(&mut reader, &mut writer)?;
    writer.flush()?;
    Ok(copied)
}

#[cfg(target_os = "macos")]
struct ShutdownSignals {
    pending: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    registrations: Vec<signal_hook::SigId>,
}

#[cfg(target_os = "macos")]
impl ShutdownSignals {
    fn install() -> ShimResult<Self> {
        use nix::sys::signal::{SigSet, Signal};
        use signal_hook::consts::{SIGHUP, SIGINT, SIGTERM};
        use signal_hook::flag::register_usize;
        use std::sync::Arc;
        use std::sync::atomic::AtomicUsize;

        let mut managed = SigSet::empty();
        for signal in [Signal::SIGTERM, Signal::SIGINT, Signal::SIGHUP] {
            managed.add(signal);
        }
        managed.thread_unblock()?;

        let pending = Arc::new(AtomicUsize::new(0));
        let mut registrations = Vec::new();
        for signal in [SIGTERM, SIGINT, SIGHUP] {
            registrations.push(register_usize(
                signal,
                Arc::clone(&pending),
                signal as usize,
            )?);
        }
        Ok(Self {
            pending,
            registrations,
        })
    }

    fn pending(&self) -> Option<i32> {
        use std::sync::atomic::Ordering;

        let signal = self.pending.swap(0, Ordering::SeqCst);
        (signal != 0).then_some(signal as i32)
    }
}

#[cfg(target_os = "macos")]
impl Drop for ShutdownSignals {
    fn drop(&mut self) {
        for registration in self.registrations.drain(..) {
            signal_hook::low_level::unregister(registration);
        }
    }
}

#[cfg(not(target_os = "macos"))]
struct ShutdownSignals;

#[cfg(not(target_os = "macos"))]
impl ShutdownSignals {
    fn install() -> ShimResult<Self> {
        Ok(Self)
    }
}

struct ChildOutcome {
    status: ExitStatus,
    forwarded_signal: Option<i32>,
    forced: bool,
    terminated_descendants: bool,
}

#[cfg(target_os = "macos")]
fn wait_for_child(
    child: &mut codexhost_platform::SupervisedChild,
    signals: &ShutdownSignals,
) -> ShimResult<ChildOutcome> {
    const POLL_INTERVAL: Duration = Duration::from_millis(20);
    const TERMINATION_GRACE: Duration = Duration::from_secs(2);

    let mut root_status = None;
    let mut forwarded_signal = None;
    let mut deadline = None;
    let mut forced = false;
    let mut terminated_descendants = false;
    loop {
        if root_status.is_none() {
            root_status = child.try_wait()?;
        }
        let has_live_processes = child.has_live_processes()?;
        if let Some(status) = root_status.as_ref()
            && !has_live_processes
        {
            return Ok(ChildOutcome {
                status: *status,
                forwarded_signal,
                forced,
                terminated_descendants,
            });
        }
        if let Some(signal) = signals.pending().filter(|_| forwarded_signal.is_none()) {
            child.forward_signal(signal)?;
            forwarded_signal = Some(signal);
            deadline = Some(Instant::now() + TERMINATION_GRACE);
        } else if root_status.is_some() && deadline.is_none() && has_live_processes {
            child.terminate()?;
            terminated_descendants = true;
            deadline = Some(Instant::now() + TERMINATION_GRACE);
        }
        if !forced && deadline.is_some_and(|deadline| Instant::now() >= deadline) {
            child.force_terminate()?;
            forced = true;
        }
        thread::sleep(POLL_INTERVAL);
    }
}

#[cfg(not(target_os = "macos"))]
fn wait_for_child(
    child: &mut codexhost_platform::SupervisedChild,
    _signals: &ShutdownSignals,
) -> ShimResult<ChildOutcome> {
    child
        .wait()
        .map(|status| ChildOutcome {
            status,
            forwarded_signal: None,
            forced: false,
            terminated_descendants: false,
        })
        .map_err(Into::into)
}

#[cfg(target_os = "macos")]
fn exit_signal(status: &ExitStatus) -> Option<i32> {
    use std::os::unix::process::ExitStatusExt;

    status.signal()
}

#[cfg(not(target_os = "macos"))]
fn exit_signal(_status: &ExitStatus) -> Option<i32> {
    None
}

/// Returns the position of the Codex `app-server` subcommand after supported global options.
///
/// An arbitrary later argument named `app-server` is not treated as a subcommand. This keeps the
/// Shim transparent for prompts and subcommands whose values happen to contain the same text.
#[must_use]
pub fn app_server_subcommand_index(arguments: &[OsString]) -> Option<usize> {
    const VALUE_OPTIONS: &[&str] = &[
        "-c",
        "--config",
        "--enable",
        "--disable",
        "--remote",
        "--remote-auth-token-env",
        "-m",
        "--model",
        "--local-provider",
        "-p",
        "--profile",
        "-s",
        "--sandbox",
        "-C",
        "--cd",
    ];
    const FLAG_OPTIONS: &[&str] = &[
        "--strict-config",
        "--oss",
        "--dangerously-bypass-approvals-and-sandbox",
        "--dangerously-bypass-hook-trust",
    ];

    let mut index = 0;
    while let Some(argument) = arguments.get(index).and_then(|value| value.to_str()) {
        if argument == "app-server" {
            return Some(index);
        }
        if VALUE_OPTIONS.contains(&argument) {
            arguments.get(index + 1)?;
            index += 2;
            continue;
        }
        if VALUE_OPTIONS.iter().any(|option| {
            argument
                .strip_prefix(option)
                .is_some_and(|remainder| remainder.starts_with('='))
        }) || FLAG_OPTIONS.contains(&argument)
        {
            index += 1;
            continue;
        }
        return None;
    }
    None
}

fn child_command(
    arguments: &[OsString],
    current_executable: &Path,
    stock_codex_path: &Path,
) -> ShimResult<Command> {
    let host_paths = (
        env::var_os(HOST_NODE_PATH_ENV),
        env::var_os(HOST_RUNTIME_PATH_ENV),
    );
    if app_server_subcommand_index(arguments).is_some() {
        match host_paths {
            (Some(node_path), Some(runtime_path)) => {
                let node_path =
                    validate_proxy_target(current_executable, &PathBuf::from(node_path))?;
                let runtime_path = canonical_existing_file(&PathBuf::from(runtime_path))?;
                let mut command = Command::new(node_path);
                command
                    .arg(runtime_path)
                    .args(arguments)
                    .env(STOCK_CODEX_PATH_ENV, stock_codex_path)
                    .env_remove(CODEX_CLI_PATH_ENV)
                    .env_remove(HOST_NODE_PATH_ENV)
                    .env_remove(HOST_RUNTIME_PATH_ENV);
                return Ok(command);
            }
            (None, None) => {}
            _ => {
                return Err(format!(
                    "{HOST_NODE_PATH_ENV} and {HOST_RUNTIME_PATH_ENV} must be configured together"
                )
                .into());
            }
        }
    }

    let mut command = Command::new(stock_codex_path);
    command
        .args(arguments)
        .env_remove(CODEX_CLI_PATH_ENV)
        .env_remove(HOST_NODE_PATH_ENV)
        .env_remove(HOST_RUNTIME_PATH_ENV);
    Ok(command)
}

/// Runs the byte-transparent proxy and emits optional lifecycle observations.
pub fn run_proxy_with_observer(
    arguments: &[OsString],
    observer: &impl ProxyObserver,
) -> ShimResult<i32> {
    let current_executable = env::current_exe()?;
    let stock_codex_path = env::var_os(STOCK_CODEX_PATH_ENV)
        .map(PathBuf::from)
        .ok_or_else(|| format!("{STOCK_CODEX_PATH_ENV} is required"))?;
    let stock_codex_path = validate_proxy_target(&current_executable, &stock_codex_path)?;
    observer.invocation(arguments, &stock_codex_path);

    let started = Instant::now();
    let shutdown_signals = ShutdownSignals::install()?;
    let mut command = child_command(arguments, &current_executable, &stock_codex_path)?;
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = spawn_supervised(&mut command)?;
    let child_id = child.id();

    let child_stdin = child
        .take_stdin()
        .ok_or("official CLI stdin is unavailable")?;
    let child_stdout = child
        .take_stdout()
        .ok_or("official CLI stdout is unavailable")?;
    let child_stderr = child
        .take_stderr()
        .ok_or("official CLI stderr is unavailable")?;

    let _stdin_pump = thread::spawn(move || copy_stream(io::stdin().lock(), child_stdin));
    let stdout_pump = thread::spawn(move || copy_stream(child_stdout, io::stdout().lock()));
    let stderr_pump = thread::spawn(move || copy_stream(child_stderr, io::stderr().lock()));

    let outcome = wait_for_child(&mut child, &shutdown_signals)?;
    stdout_pump
        .join()
        .map_err(|_| "official CLI stdout pump panicked")??;
    stderr_pump
        .join()
        .map_err(|_| "official CLI stderr pump panicked")??;
    observer.exit(child_id, &outcome.status, started.elapsed());

    if let Some(signal) = outcome.forwarded_signal {
        eprintln!("codexhost shim: forwarded shutdown signal {signal}");
    }
    if outcome.terminated_descendants {
        eprintln!("codexhost shim: terminated official CLI descendants after root exit");
    }
    if outcome.forced {
        eprintln!("codexhost shim: forced official CLI process-group termination after timeout");
    }
    if let Some(signal) = exit_signal(&outcome.status) {
        eprintln!("codexhost shim: official CLI terminated by signal {signal}");
    }
    Ok(outcome.status.code().unwrap_or(1))
}

pub fn run_proxy(arguments: &[OsString]) -> ShimResult<i32> {
    run_proxy_with_observer(arguments, &NoopProxyObserver)
}

pub fn run_from_environment() -> ShimResult<i32> {
    run_proxy(&env::args_os().skip(1).collect::<Vec<_>>())
}

#[cfg(test)]
mod tests {
    use std::ffi::OsString;

    #[cfg(target_os = "macos")]
    use super::ShutdownSignals;
    use super::app_server_subcommand_index;

    fn arguments(values: &[&str]) -> Vec<OsString> {
        values.iter().map(OsString::from).collect()
    }

    #[test]
    fn finds_app_server_after_supported_global_options_only() {
        assert_eq!(
            app_server_subcommand_index(&arguments(&[
                "-c",
                "features.code_mode_host=true",
                "--strict-config",
                "app-server",
                "--analytics-default-enabled",
            ])),
            Some(3)
        );
        assert_eq!(
            app_server_subcommand_index(&arguments(&[
                "--config=features.code_mode_host=true",
                "app-server",
            ])),
            Some(1)
        );
        assert_eq!(
            app_server_subcommand_index(&arguments(&["--label", "app-server"])),
            None
        );
        assert_eq!(app_server_subcommand_index(&arguments(&["-c"])), None);
    }

    #[cfg(target_os = "macos")]
    fn observe_sigterm(signals: &ShutdownSignals) {
        use nix::sys::signal::{Signal, kill};
        use nix::unistd::Pid;
        use signal_hook::consts::SIGTERM;
        use std::time::{Duration, Instant};

        kill(Pid::this(), Signal::SIGTERM).expect("signal current test process");
        let started = Instant::now();
        let observed = loop {
            if let Some(signal) = signals.pending() {
                break Some(signal);
            }
            if started.elapsed() >= Duration::from_secs(1) {
                break None;
            }
            std::thread::yield_now();
        };
        assert_eq!(observed, Some(SIGTERM));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn records_sigterm_in_an_atomic_flag() {
        let signals = ShutdownSignals::install().expect("install shutdown signals");
        observe_sigterm(&signals);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn records_sigterm_after_spawning_a_supervised_child() {
        use std::process::Command;

        let signals = ShutdownSignals::install().expect("install shutdown signals");
        let mut command = Command::new("/usr/bin/true");
        let mut child =
            codexhost_platform::spawn_supervised(&mut command).expect("spawn supervised child");
        let _ = child.wait().expect("wait for child");
        observe_sigterm(&signals);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn records_sigterm_while_a_supervised_child_is_running() {
        use std::process::Command;

        let signals = ShutdownSignals::install().expect("install shutdown signals");
        let mut command = Command::new("/bin/sleep");
        command.arg("30");
        let mut child =
            codexhost_platform::spawn_supervised(&mut command).expect("spawn supervised child");
        observe_sigterm(&signals);
        child.force_terminate().expect("terminate child");
        let _ = child.wait().expect("wait for child");
    }
}
