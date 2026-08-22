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
    CODEX_CLI_PATH_ENV, STOCK_CODEX_PATH_ENV, canonical_existing_file,
    configure_background_command, node_entrypoint_path, spawn_supervised, validate_proxy_target,
};

pub type ShimResult<T> = Result<T, Box<dyn Error>>;

pub const HOST_NODE_PATH_ENV: &str = "CODEXHOST_HOST_NODE_PATH";
pub const HOST_RUNTIME_PATH_ENV: &str = "CODEXHOST_HOST_RUNTIME_PATH";
pub const REMOTE_SSH_MANAGED_ENV: &str = "CODEXHOST_REMOTE_SSH_MANAGED";
const DATA_DIRECTORY_ENV: &str = "CODEXHOST_DATA_DIR";
const LAUNCHER_PID_ENV: &str = "CODEXHOST_LAUNCHER_PID";
const NPM_NODE_PATH_ENV: &str = "CODEXHOST_NPM_NODE_PATH";
const NPM_PACKAGE_ROOT_ENV: &str = "CODEXHOST_NPM_PACKAGE_ROOT";
const REMOTE_LISTENER_CHILD_ENV: &str = "CODEXHOST_REMOTE_LISTENER_CHILD";

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
    let mut buffer = [0_u8; 16 * 1024];
    let mut copied = 0_u64;
    loop {
        let count = match reader.read(&mut buffer) {
            Ok(0) => return Ok(copied),
            Ok(count) => count,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        };
        writer.write_all(&buffer[..count])?;
        writer.flush()?;
        copied += count as u64;
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
struct ShutdownSignals {
    pending: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    registrations: Vec<signal_hook::SigId>,
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
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

#[cfg(any(target_os = "macos", target_os = "linux"))]
impl Drop for ShutdownSignals {
    fn drop(&mut self) {
        for registration in self.registrations.drain(..) {
            signal_hook::low_level::unregister(registration);
        }
    }
}

#[cfg(target_os = "windows")]
struct ShutdownSignals;

#[cfg(target_os = "windows")]
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

#[cfg(any(target_os = "macos", target_os = "linux"))]
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

#[cfg(target_os = "windows")]
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

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn exit_signal(status: &ExitStatus) -> Option<i32> {
    use std::os::unix::process::ExitStatusExt;

    status.signal()
}

#[cfg(target_os = "windows")]
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

/// Returns whether this invocation starts an app-server instance owned by the Host Runtime.
///
/// App-server management commands such as `proxy` and `daemon` must stay on the stock Codex CLI.
/// In particular, Codex Desktop's SSH transport runs `app-server proxy` as a byte-transparent
/// bridge to the already-running Unix listener; replacing that bridge with the JSONL Host Runtime
/// would corrupt the WebSocket transport.
#[must_use]
pub fn should_start_host_runtime(arguments: &[OsString]) -> bool {
    const VALUE_OPTIONS: &[&str] = &[
        "-c",
        "--config",
        "--enable",
        "--disable",
        "--listen",
        "--ws-auth",
        "--ws-token-file",
        "--ws-token-sha256",
        "--ws-shared-secret-file",
        "--ws-issuer",
        "--ws-audience",
        "--ws-max-clock-skew-seconds",
    ];
    const FLAG_OPTIONS: &[&str] = &["--strict-config", "--stdio", "--analytics-default-enabled"];

    let Some(mut index) = app_server_subcommand_index(arguments).map(|index| index + 1) else {
        return false;
    };
    while let Some(argument) = arguments.get(index).and_then(|value| value.to_str()) {
        if VALUE_OPTIONS.contains(&argument) {
            if arguments.get(index + 1).is_none() {
                return false;
            }
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
        return false;
    }
    true
}

#[must_use]
#[cfg(any(target_os = "macos", target_os = "linux", test))]
fn is_default_remote_unix_listener(arguments: &[OsString]) -> bool {
    const VALUE_OPTIONS: &[&str] = &[
        "-c",
        "--config",
        "--enable",
        "--disable",
        "--ws-auth",
        "--ws-token-file",
        "--ws-token-sha256",
        "--ws-shared-secret-file",
        "--ws-issuer",
        "--ws-audience",
        "--ws-max-clock-skew-seconds",
    ];
    const FLAG_OPTIONS: &[&str] = &["--strict-config", "--analytics-default-enabled"];

    let Some(mut index) = app_server_subcommand_index(arguments).map(|index| index + 1) else {
        return false;
    };
    let mut saw_default_listener = false;
    while let Some(argument) = arguments.get(index).and_then(|value| value.to_str()) {
        if argument == "--stdio" {
            return false;
        }
        if argument == "--listen" {
            let Some(value) = arguments.get(index + 1).and_then(|value| value.to_str()) else {
                return false;
            };
            if saw_default_listener || value != "unix://" {
                return false;
            }
            saw_default_listener = true;
            index += 2;
            continue;
        }
        if let Some(value) = argument.strip_prefix("--listen=") {
            if saw_default_listener || value != "unix://" {
                return false;
            }
            saw_default_listener = true;
            index += 1;
            continue;
        }
        if VALUE_OPTIONS.contains(&argument) {
            if arguments.get(index + 1).is_none() {
                return false;
            }
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
        return false;
    }
    saw_default_listener
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn default_remote_socket_path() -> ShimResult<PathBuf> {
    let codex_home = env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| env::var_os("HOME").map(|home| PathBuf::from(home).join(".codex")))
        .ok_or("CODEX_HOME or HOME is required for the remote listener")?;
    Ok(codex_home
        .join("app-server-control")
        .join("app-server-control.sock"))
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn socket_identity(socket_path: &Path) -> Option<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;

    std::fs::metadata(socket_path)
        .ok()
        .map(|metadata| (metadata.dev(), metadata.ino()))
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn detach_remote_listener_session() -> ShimResult<()> {
    use nix::unistd::setsid;

    setsid().map(|_| ()).map_err(|error| {
        io::Error::other(format!(
            "could not detach the managed remote listener session: {error}"
        ))
    })?;
    Ok(())
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn stop_detached_listener(child: &mut std::process::Child) {
    use nix::sys::signal::{Signal, kill};
    use nix::unistd::Pid;

    let Ok(raw_process_id) = i32::try_from(child.id()) else {
        let _ = child.kill();
        let _ = child.wait();
        return;
    };
    let process_id = Pid::from_raw(raw_process_id);
    let _ = kill(process_id, Signal::SIGTERM);
    let deadline = Instant::now() + Duration::from_secs(2);
    while child.try_wait().ok().flatten().is_none() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(20));
    }
    if child.try_wait().ok().flatten().is_none() {
        let _ = child.kill();
    }
    let _ = child.wait();
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn launch_detached_remote_listener(arguments: &[OsString]) -> ShimResult<i32> {
    use std::os::unix::net::UnixStream;

    const STARTUP_TIMEOUT: Duration = Duration::from_secs(10);
    const POLL_INTERVAL: Duration = Duration::from_millis(20);

    let current_executable = env::current_exe()?;
    let socket_path = default_remote_socket_path()?;
    let previous_socket = socket_identity(&socket_path);
    let mut command = Command::new(&current_executable);
    command
        .args(arguments)
        .env(REMOTE_LISTENER_CHILD_ENV, "1")
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    configure_background_command(&mut command);
    let mut child = command.spawn()?;
    let deadline = Instant::now() + STARTUP_TIMEOUT;
    loop {
        if let Some(status) = child.try_wait()? {
            return Err(
                format!("managed remote listener exited before readiness: {status}").into(),
            );
        }
        let current_socket = socket_identity(&socket_path);
        let socket_replaced = current_socket.is_some() && current_socket != previous_socket;
        if socket_replaced && UnixStream::connect(&socket_path).is_ok() {
            thread::sleep(POLL_INTERVAL);
            if let Some(status) = child.try_wait()? {
                return Err(
                    format!("managed remote listener exited after readiness: {status}").into(),
                );
            }
            return Ok(0);
        }
        if Instant::now() >= deadline {
            stop_detached_listener(&mut child);
            return Err(format!(
                "managed remote listener did not become ready at {} within {} seconds",
                socket_path.display(),
                STARTUP_TIMEOUT.as_secs()
            )
            .into());
        }
        thread::sleep(POLL_INTERVAL);
    }
}

fn select_host_paths(
    configured_node: Option<OsString>,
    configured_runtime: Option<OsString>,
    launcher_managed: bool,
    npm_node: Option<OsString>,
    npm_package_root: Option<OsString>,
) -> (Option<OsString>, Option<OsString>) {
    if launcher_managed && let (Some(node), Some(package_root)) = (npm_node, npm_package_root) {
        return (
            Some(node),
            Some(
                PathBuf::from(package_root)
                    .join("app")
                    .join("host-runtime.mjs")
                    .into_os_string(),
            ),
        );
    }
    (configured_node, configured_runtime)
}

fn child_command(
    arguments: &[OsString],
    current_executable: &Path,
    stock_codex_path: &Path,
) -> ShimResult<Command> {
    let launcher_managed = env::var_os(LAUNCHER_PID_ENV).is_some();
    let inherited_remote_profile = launcher_managed
        && env::var_os(REMOTE_SSH_MANAGED_ENV).as_deref() == Some(std::ffi::OsStr::new("1"));
    let host_paths = select_host_paths(
        env::var_os(HOST_NODE_PATH_ENV),
        env::var_os(HOST_RUNTIME_PATH_ENV),
        launcher_managed,
        env::var_os(NPM_NODE_PATH_ENV),
        env::var_os(NPM_PACKAGE_ROOT_ENV),
    );
    if should_start_host_runtime(arguments) {
        match host_paths {
            (Some(node_path), Some(runtime_path)) => {
                let node_path =
                    validate_proxy_target(current_executable, &PathBuf::from(node_path))?;
                let runtime_path = canonical_existing_file(&PathBuf::from(runtime_path))?;
                let mut command = Command::new(node_path);
                command
                    .arg(node_entrypoint_path(&runtime_path))
                    .args(arguments)
                    .env(STOCK_CODEX_PATH_ENV, stock_codex_path)
                    .env_remove(CODEX_CLI_PATH_ENV)
                    .env_remove(HOST_NODE_PATH_ENV)
                    .env_remove(HOST_RUNTIME_PATH_ENV)
                    .env_remove(REMOTE_SSH_MANAGED_ENV)
                    .env_remove(REMOTE_LISTENER_CHILD_ENV);
                if inherited_remote_profile {
                    command.env_remove(DATA_DIRECTORY_ENV);
                }
                configure_background_command(&mut command);
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
        .env_remove(HOST_RUNTIME_PATH_ENV)
        .env_remove(REMOTE_SSH_MANAGED_ENV)
        .env_remove(REMOTE_LISTENER_CHILD_ENV);
    configure_background_command(&mut command);
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
    let arguments = env::args_os().skip(1).collect::<Vec<_>>();
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    if env::var_os(REMOTE_SSH_MANAGED_ENV).as_deref() == Some(std::ffi::OsStr::new("1"))
        && is_default_remote_unix_listener(&arguments)
    {
        if env::var_os(REMOTE_LISTENER_CHILD_ENV).as_deref() == Some(std::ffi::OsStr::new("1")) {
            detach_remote_listener_session()?;
        } else {
            return launch_detached_remote_listener(&arguments);
        }
    }
    run_proxy(&arguments)
}

#[cfg(test)]
mod tests {
    use std::ffi::OsString;

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    use super::ShutdownSignals;
    use super::{
        app_server_subcommand_index, is_default_remote_unix_listener, select_host_paths,
        should_start_host_runtime,
    };

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

    #[test]
    fn starts_host_runtime_for_servers_but_not_app_server_management_commands() {
        assert!(should_start_host_runtime(&arguments(&[
            "-c",
            "features.code_mode_host=true",
            "app-server",
            "--listen",
            "unix://",
        ])));
        assert!(should_start_host_runtime(&arguments(&[
            "app-server",
            "--analytics-default-enabled",
        ])));
        assert!(!should_start_host_runtime(&arguments(&[
            "app-server",
            "proxy"
        ])));
        assert!(!should_start_host_runtime(&arguments(&[
            "app-server",
            "daemon",
            "start",
        ])));
        assert!(!should_start_host_runtime(&arguments(&[
            "app-server",
            "generate-json-schema",
        ])));
    }

    #[test]
    fn local_launcher_paths_win_over_remote_profile_bootstrap_paths() {
        let selected = select_host_paths(
            Some(OsString::from("/remote/node")),
            Some(OsString::from("/remote/runtime/host-runtime.mjs")),
            true,
            Some(OsString::from("/local/node")),
            Some(OsString::from("/local/npm-package")),
        );

        assert_eq!(selected.0, Some(OsString::from("/local/node")));
        assert_eq!(
            selected.1,
            Some(
                std::path::PathBuf::from("/local/npm-package")
                    .join("app")
                    .join("host-runtime.mjs")
                    .into_os_string()
            )
        );
    }

    #[test]
    fn classifies_only_the_default_remote_unix_listener_for_detachment() {
        assert!(is_default_remote_unix_listener(&arguments(&[
            "-c",
            "features.code_mode_host=true",
            "app-server",
            "--listen",
            "unix://",
        ])));
        assert!(is_default_remote_unix_listener(&arguments(&[
            "app-server",
            "--listen=unix://",
        ])));
        assert!(!is_default_remote_unix_listener(&arguments(&[
            "app-server",
            "--listen=unix:///tmp/custom.sock",
        ])));
        assert!(!is_default_remote_unix_listener(&arguments(&[
            "app-server",
            "proxy",
        ])));
        assert!(!is_default_remote_unix_listener(&arguments(&[
            "app-server",
            "--stdio",
        ])));
        assert!(!is_default_remote_unix_listener(&arguments(&[
            "app-server",
            "--stdio",
            "--listen",
            "unix://",
        ])));
        assert!(!is_default_remote_unix_listener(&arguments(&[
            "app-server",
            "--listen",
            "unix:///tmp/custom.sock",
            "--listen",
            "unix://",
        ])));
        assert!(!is_default_remote_unix_listener(&arguments(&[
            "app-server",
            "--listen",
            "unix://",
            "--listen=unix://",
        ])));
        assert!(!is_default_remote_unix_listener(&arguments(&[
            "app-server",
            "--listen",
            "unix://",
            "--listen=unix:///tmp/custom.sock",
        ])));
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
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

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn records_sigterm_in_an_atomic_flag() {
        let signals = ShutdownSignals::install().expect("install shutdown signals");
        observe_sigterm(&signals);
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
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

    #[cfg(any(target_os = "macos", target_os = "linux"))]
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
