#[cfg(any(target_os = "macos", target_os = "linux"))]
use std::collections::{HashMap, HashSet};
use std::env;
use std::error::Error;
use std::ffi::OsString;
use std::io::{self, BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant};

#[cfg(all(test, any(target_os = "macos", target_os = "linux")))]
use codexhost_platform::descendant_executable_pair_exists;
#[cfg(not(unix))]
use codexhost_platform::desktop_root_process_ids_for_installation;
use codexhost_platform::{
    DesktopInstallation, HostChainObservation, PlatformError, ProcessSnapshot, observe_host_chain,
};
#[cfg(target_os = "windows")]
use codexhost_platform::{process_executable_path, process_exists, terminate_process_by_id};

use crate::ResolvedLaunchOptions;
#[cfg(not(unix))]
use crate::runtime_instance::read_descriptor;
#[cfg(not(unix))]
use crate::runtime_instance::try_acquire_launcher_guard;
use crate::runtime_instance::{
    LauncherGuard, RuntimeDescriptor, default_descriptor_path, random_nonce,
};
#[cfg(target_os = "windows")]
use crate::runtime_instance::{RuntimeDescriptorGuard, remove_matching_descriptor};

const ATTACHMENT_RETRY_INITIAL_DELAY: Duration = Duration::from_millis(100);
const ATTACHMENT_RETRY_MAX_DELAY: Duration = Duration::from_secs(1);
const DIRECT_STOCK_CLI_GRACE: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum HostChainWaitOutcome {
    Ready,
    Stopped,
    DesktopExited,
    DirectStockCliWithoutShim,
    TimedOut,
}

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
    Acquired(LauncherGuard, #[cfg(unix)] std::fs::File),
    Attached,
}

pub(super) fn acquire_launcher_ownership(
    _installation: &DesktopInstallation,
    timeout: Duration,
    #[cfg(unix)] data: &Path,
) -> Result<LauncherOwnership, Box<dyn Error>> {
    let descriptor_path = default_descriptor_path()?;
    #[cfg(unix)]
    let lifecycle = crate::desktop_lifecycle::Lifecycle::open(&descriptor_path, true)?;
    #[cfg(not(unix))]
    let guard_path = crate::runtime_instance::guard_path(&descriptor_path);
    let deadline = Instant::now() + timeout;
    let mut delay = ATTACHMENT_RETRY_INITIAL_DELAY;
    loop {
        #[cfg(unix)]
        let descriptor = {
            let operation = lifecycle.lock(deadline)?;
            if let Some(guard) = lifecycle.launcher_guard()? {
                return Ok(LauncherOwnership::Acquired(guard, operation));
            }
            lifecycle.attachment(data)?
        };
        #[cfg(not(unix))]
        let descriptor = {
            if let Some(guard) = try_acquire_launcher_guard(&guard_path)? {
                return Ok(LauncherOwnership::Acquired(guard));
            }
            read_descriptor(&descriptor_path).ok().flatten()
        };
        if let Some(descriptor) = &descriptor {
            if try_activate_until(descriptor, deadline)? {
                return Ok(LauncherOwnership::Attached);
            }
            #[cfg(not(unix))]
            if desktop_root_process_ids_for_installation(_installation)?.is_empty() {
                stop_stale_launcher(descriptor)?;
                remove_matching_descriptor(&descriptor_path, descriptor)?;
                if let Some(guard) = try_acquire_launcher_guard(&guard_path)? {
                    return Ok(LauncherOwnership::Acquired(guard));
                }
            }
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        thread::sleep(delay.min(remaining));
        delay = (delay * 2).min(ATTACHMENT_RETRY_MAX_DELAY);
    }
    Err("another codexhost Launcher did not become attachable before timeout".into())
}

#[cfg(not(unix))]
pub(super) fn endpoint_ready(port: u16, timeout: Duration) -> bool {
    TcpStream::connect_timeout(
        &format!("127.0.0.1:{port}")
            .parse()
            .expect("valid loopback socket address"),
        timeout,
    )
    .is_ok()
}

#[cfg_attr(target_os = "windows", allow(dead_code))]
pub(super) fn wait_for_host_chain(
    desktop: &ProcessSnapshot,
    options: &ResolvedLaunchOptions,
    timeout: Duration,
    stopping: impl FnMut() -> Result<bool, Box<dyn Error>>,
) -> Result<bool, Box<dyn Error>> {
    Ok(
        wait_for_host_chain_outcome(desktop, options, None, timeout, stopping)?
            == HostChainWaitOutcome::Ready,
    )
}

pub(super) fn wait_for_host_chain_outcome(
    desktop: &ProcessSnapshot,
    options: &ResolvedLaunchOptions,
    stock_cli: Option<&Path>,
    timeout: Duration,
    stopping: impl FnMut() -> Result<bool, Box<dyn Error>>,
) -> Result<HostChainWaitOutcome, Box<dyn Error>> {
    let nodes =
        host_runtime_node_candidates(options.node.clone(), env::var_os(crate::NPM_NODE_PATH_ENV));
    wait_for_host_chain_with_observer(
        desktop,
        &options.shim,
        &nodes,
        timeout,
        DIRECT_STOCK_CLI_GRACE,
        stopping,
        || observe_host_chain(desktop, &options.shim, &nodes, stock_cli),
    )
}

/// The Shim runs the Host Runtime on the Node selected at launch
/// (`options.node`, the Desktop cua_node in installer layouts) — but on
/// npm-managed installs it overrides the Host Runtime to
/// `CODEXHOST_NPM_NODE_PATH` (the npm wrapper's `process.execPath`). Readiness
/// must accept that Node too, or the wait blocks on a late, unrelated Desktop
/// `cua_node` helper instead of the actual Host Runtime process.
pub(super) fn host_runtime_node_candidates(
    default_node: PathBuf,
    npm_node: Option<OsString>,
) -> Vec<PathBuf> {
    let mut nodes = vec![default_node];
    if let Some(npm_node) = npm_node
        .map(PathBuf::from)
        .filter(|node| node.is_file() && !nodes.contains(node))
    {
        nodes.push(npm_node);
    }
    nodes
}

#[cfg(all(test, any(target_os = "macos", target_os = "linux")))]
fn wait_for_host_chain_with_nodes(
    desktop: &ProcessSnapshot,
    options: &ResolvedLaunchOptions,
    nodes: &[PathBuf],
    timeout: Duration,
) -> Result<bool, Box<dyn Error>> {
    wait_for_host_chain_with_inspector(
        desktop,
        &options.shim,
        nodes,
        timeout,
        || Ok(false),
        |node| descendant_executable_pair_exists(desktop, &options.shim, node),
    )
}

fn wait_for_host_chain_with_observer(
    desktop: &ProcessSnapshot,
    shim: &Path,
    nodes: &[PathBuf],
    timeout: Duration,
    direct_stock_cli_grace: Duration,
    mut stopping: impl FnMut() -> Result<bool, Box<dyn Error>>,
    mut observe: impl FnMut() -> Result<HostChainObservation, PlatformError>,
) -> Result<HostChainWaitOutcome, Box<dyn Error>> {
    let started = Instant::now();
    // `unresolved_error` belongs to the latest round that could not inspect
    // the Desktop subtree and alone decides whether a timeout is an error.
    let mut unresolved_error = None;
    let mut last_error = None;
    let mut last_observation = None;
    let mut direct_stock_cli_since: Option<Instant> = None;
    while started.elapsed() < timeout {
        if stopping()? {
            return Ok(HostChainWaitOutcome::Stopped);
        }
        match observe() {
            Ok(observation) => {
                unresolved_error = None;
                let ready = observation.pair_exists;
                let root_alive = observation.root_alive;
                let direct_stock_cli = observation.direct_stock_cli_without_shim;
                last_observation = Some(observation);
                if ready {
                    return Ok(HostChainWaitOutcome::Ready);
                }
                if !root_alive {
                    crate::startup_trace(&host_chain_failure_diagnostic(
                        "Host chain wait ended early (Desktop exited)",
                        desktop,
                        shim,
                        nodes,
                        last_observation.as_ref(),
                        last_error.as_deref(),
                    ));
                    return Ok(HostChainWaitOutcome::DesktopExited);
                }
                if direct_stock_cli {
                    let first_seen = *direct_stock_cli_since.get_or_insert_with(Instant::now);
                    if first_seen.elapsed() >= direct_stock_cli_grace {
                        crate::startup_trace(&host_chain_failure_diagnostic(
                            "Host chain wait ended early (official CLI started without Shim)",
                            desktop,
                            shim,
                            nodes,
                            last_observation.as_ref(),
                            last_error.as_deref(),
                        ));
                        return Ok(HostChainWaitOutcome::DirectStockCliWithoutShim);
                    }
                } else {
                    direct_stock_cli_since = None;
                }
            }
            Err(error) => {
                let message = error.to_string();
                last_error = Some(message.clone());
                unresolved_error = Some(message);
            }
        }
        thread::sleep(Duration::from_millis(100));
    }
    crate::startup_trace(&host_chain_failure_diagnostic(
        "Host chain wait timed out",
        desktop,
        shim,
        nodes,
        last_observation.as_ref(),
        last_error.as_deref(),
    ));
    if let Some(error) = unresolved_error {
        return Err(error.into());
    }
    Ok(HostChainWaitOutcome::TimedOut)
}

#[cfg(test)]
fn wait_for_host_chain_with_inspector(
    desktop: &ProcessSnapshot,
    shim: &Path,
    nodes: &[PathBuf],
    timeout: Duration,
    mut stopping: impl FnMut() -> Result<bool, Box<dyn Error>>,
    mut inspect: impl FnMut(&Path) -> Result<bool, PlatformError>,
) -> Result<bool, Box<dyn Error>> {
    let started = Instant::now();
    // `unresolved_error` belongs to the latest round that could not inspect
    // every candidate and alone decides whether a timeout is an error. A later
    // round that inspects every candidate without a match proves the tree was
    // observable, so the timeout then takes the caller's normal cleanup path.
    // `last_error` outlives such rounds and only feeds the diagnostic.
    let mut unresolved_error = None;
    let mut last_error = None;
    while started.elapsed() < timeout {
        if stopping()? {
            return Ok(false);
        }
        let mut round_error = None;
        for node in nodes {
            match inspect(node) {
                Ok(true) => return Ok(true),
                Ok(false) => {}
                Err(error) => round_error = Some(error.to_string()),
            }
        }
        if round_error.is_some() {
            last_error = round_error.clone();
        }
        unresolved_error = round_error;
        thread::sleep(Duration::from_millis(100));
    }
    // Without evidence the timeout is indistinguishable from a broken Desktop
    // launch, a stalled Controller, or an unobservable process tree (#882).
    // Record what the wait was matching against and what was last observed so
    // the next report can pin the failing stage.
    crate::startup_trace(&host_chain_failure_diagnostic(
        "Host chain wait timed out",
        desktop,
        shim,
        nodes,
        None,
        last_error.as_deref(),
    ));
    if let Some(error) = unresolved_error {
        return Err(error.into());
    }
    Ok(false)
}

/// One-shot diagnostic snapshot taken when the Host chain wait ends unsuccessfully.
fn host_chain_failure_diagnostic(
    reason: &str,
    desktop: &ProcessSnapshot,
    shim: &Path,
    nodes: &[PathBuf],
    observation: Option<&HostChainObservation>,
    last_error: Option<&str>,
) -> String {
    let nodes_display = nodes
        .iter()
        .map(|node| node.display().to_string())
        .collect::<Vec<_>>()
        .join(", ");
    let mut diagnostic = format!(
        "{reason}: Desktop root pid {} ({}), expected shim '{}' and node candidates [{}]",
        desktop.id,
        desktop.executable.display(),
        shim.display(),
        nodes_display,
    );
    if let Some(observation) = observation {
        if observation.root_alive {
            diagnostic = format!(
                "{diagnostic}; {} in this Desktop tree, shim running in this Desktop tree: {}, node running in this Desktop tree: {}, direct official CLI without shim: {}",
                observation.tree_size,
                observation.shim_running,
                observation.node_running,
                observation.direct_stock_cli_without_shim,
            );
        } else {
            diagnostic = format!("{diagnostic}; original Desktop instance is not visible");
        }
    } else {
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        match codexhost_platform::process_snapshots() {
            Ok(snapshots) => match snapshots_in_desktop_tree(desktop, &snapshots) {
                Some(tree) => {
                    let shim_running = tree.iter().any(|process| process.executable == shim);
                    let node_running = tree
                        .iter()
                        .any(|process| nodes.iter().any(|node| &process.executable == node));
                    diagnostic = format!(
                        "{diagnostic}; {} live processes observed, {} in this Desktop tree, shim running in this Desktop tree: {shim_running}, node running in this Desktop tree: {node_running}",
                        snapshots.len(),
                        tree.len()
                    );
                }
                None => {
                    diagnostic = format!(
                        "{diagnostic}; {} live processes observed, original Desktop instance is not visible",
                        snapshots.len()
                    );
                }
            },
            Err(error) => {
                diagnostic = format!("{diagnostic}; live process enumeration failed: {error}");
            }
        }
    }
    if let Some(error) = last_error {
        diagnostic = format!("{diagnostic}; last process-tree inspection error: {error}");
    }
    diagnostic
}

/// The original Desktop instance and its descendants. A process instance is a
/// PID plus its start time, so a recycled PID is not mistaken for the Desktop;
/// `None` means that instance is no longer alive.
#[cfg(any(target_os = "macos", target_os = "linux"))]
fn snapshots_in_desktop_tree<'a>(
    desktop: &ProcessSnapshot,
    snapshots: &'a [ProcessSnapshot],
) -> Option<Vec<&'a ProcessSnapshot>> {
    let root = snapshots.iter().find(|process| {
        process.id == desktop.id && process.started_at_micros == desktop.started_at_micros
    })?;
    let mut children: HashMap<u32, Vec<&ProcessSnapshot>> = HashMap::new();
    for process in snapshots {
        children.entry(process.parent_id).or_default().push(process);
    }
    let mut visited = HashSet::from([root.id]);
    let mut tree = vec![root];
    let mut pending = vec![root.id];
    while let Some(parent_id) = pending.pop() {
        for &child in children.get(&parent_id).into_iter().flatten() {
            if visited.insert(child.id) {
                tree.push(child);
                pending.push(child.id);
            }
        }
    }
    Some(tree)
}

#[cfg(target_os = "windows")]
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

fn send_controlled_attachment_with_timeout(
    mut stream: TcpStream,
    descriptor: &RuntimeDescriptor,
    read_timeout: Duration,
) -> Result<bool, Box<dyn Error>> {
    let started = Instant::now();
    stream.set_write_timeout(Some(read_timeout.min(Duration::from_secs(2))))?;
    writeln!(stream, "ATTACH {}", descriptor.nonce)?;
    let remaining = read_timeout.saturating_sub(started.elapsed());
    if remaining.is_zero() {
        return Ok(false);
    }
    stream.set_read_timeout(Some(remaining))?;
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

fn try_activate_until(
    descriptor: &RuntimeDescriptor,
    deadline: Instant,
) -> Result<bool, Box<dyn Error>> {
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return Ok(false);
    }
    let address = std::net::SocketAddr::from(([127, 0, 0, 1], descriptor.control_port));
    let Ok(stream) = TcpStream::connect_timeout(&address, remaining.min(Duration::from_secs(2)))
    else {
        return Ok(false);
    };
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return Ok(false);
    }
    send_controlled_attachment_with_timeout(
        stream,
        descriptor,
        remaining.min(Duration::from_secs(10)),
    )
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

#[cfg(not(unix))]
pub(super) fn managed_processes(
    data: &Path,
) -> Result<
    Option<(
        codexhost_platform::ProcessSnapshot,
        codexhost_platform::ProcessSnapshot,
    )>,
    Box<dyn Error>,
> {
    managed_processes_at(&default_descriptor_path()?, data)
}

#[cfg(not(unix))]
pub(super) fn managed_processes_at(
    descriptor_path: &Path,
    data: &Path,
) -> Result<
    Option<(
        codexhost_platform::ProcessSnapshot,
        codexhost_platform::ProcessSnapshot,
    )>,
    Box<dyn Error>,
> {
    let Some(descriptor) = read_descriptor(descriptor_path)? else {
        return Ok(None);
    };
    if !endpoint_ready(descriptor.control_port, Duration::from_millis(300)) {
        return Ok(None);
    }
    let Some(controller) = recorded_controller(data)? else {
        return Ok(None);
    };
    let launcher = codexhost_platform::process_snapshot(descriptor.launcher_pid)?;
    if controller.parent_id != launcher.id
        || controller.started_at_micros < launcher.started_at_micros
    {
        return Err("Desktop Controller does not belong to the recorded Launcher".into());
    }
    Ok(Some((launcher, controller)))
}

pub(super) fn recorded_controller(data: &Path) -> Result<Option<ProcessSnapshot>, Box<dyn Error>> {
    let bytes = match std::fs::read(data.join("diagnostics/desktop-controller-v1.json")) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let document: serde_json::Value = serde_json::from_slice(&bytes)?;
    let pid = document["pid"]
        .as_u64()
        .and_then(|pid| u32::try_from(pid).ok())
        .filter(|pid| *pid > 1)
        .ok_or("Invalid Desktop Controller pid")?;
    match codexhost_platform::process_snapshot(pid) {
        Ok(controller) => Ok(Some(controller)),
        Err(PlatformError::NotFound(_)) => Ok(None),
        Err(error) => Err(error.into()),
    }
}

#[cfg(unix)]
pub(super) use crate::desktop_lifecycle::{running_for_update, stop_managed};

#[cfg(not(unix))]
pub(super) fn running_for_update(data: &Path) -> Result<bool, Box<dyn Error>> {
    let desktop = managed_processes(data)?;
    if let Some((launcher, _)) = &desktop
        && launcher.executable.canonicalize()? != env::current_exe()?.canonicalize()?
    {
        return Err("The running Desktop belongs to a different installation".into());
    }
    Ok(desktop.is_some())
}

#[cfg(not(unix))]
pub(super) fn stop_managed(data: &Path) -> Result<bool, Box<dyn Error>> {
    let Some((launcher, controller)) = managed_processes(data)? else {
        return Ok(false);
    };
    stop_controller(&launcher, &controller, Duration::from_secs(10))
        .map_err(|error| format!("stopping the managed Desktop failed: {error}"))?;
    Ok(true)
}

// The Launcher exits only after its Controller does. A Controller that keeps waiting on an
// unresponsive Renderer after SIGTERM is forced, so the Launcher can release Desktop ownership
// instead of failing the update and blocking the recovery Launcher.
pub(super) fn stop_controller(
    launcher: &ProcessSnapshot,
    controller: &ProcessSnapshot,
    timeout: Duration,
) -> Result<(), Box<dyn Error>> {
    codexhost_platform::terminate_process_instance(controller, false)?;
    // Windows termination is already forceful, and escalating against an exited Controller
    // whose handle the Launcher still holds fails with access denied.
    let owner: Option<codexhost_platform::ProcessIdentity> =
        (!cfg!(target_os = "windows")).then(|| controller.into());
    crate::host_service::wait_for_shutdown(owner.as_ref(), Some(&launcher.into()), timeout)
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
        let ready = wait_for_host_chain(&snapshot, &options, Duration::from_millis(200), || {
            Ok(false)
        })
        .unwrap();
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
        let ready =
            wait_for_host_chain(&snapshot, &options, Duration::from_secs(2), || Ok(false)).unwrap();
        root.force_terminate().unwrap();
        root.wait().unwrap();
        assert!(
            ready,
            "the selected parent and child must satisfy Host chain readiness"
        );
    }

    #[test]
    fn npm_node_path_widens_host_runtime_node_candidates() {
        let default_node = PathBuf::from("/bin/sleep");
        assert_eq!(
            host_runtime_node_candidates(default_node.clone(), None),
            vec![default_node.clone()]
        );
        // A missing npm Node must not widen the accepted set.
        assert_eq!(
            host_runtime_node_candidates(
                default_node.clone(),
                Some(OsString::from("/nonexistent/codexhost-npm-node"))
            ),
            vec![default_node.clone()]
        );
        // An npm Node identical to the default adds nothing.
        assert_eq!(
            host_runtime_node_candidates(
                default_node.clone(),
                Some(default_node.clone().into_os_string())
            ),
            vec![default_node.clone()]
        );
        // Any existing file is sufficient; avoid a shared, writable temp fixture.
        let npm_node = env::current_exe().expect("current test executable");
        assert_eq!(
            host_runtime_node_candidates(
                default_node.clone(),
                Some(npm_node.clone().into_os_string())
            ),
            vec![default_node, npm_node]
        );
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn host_chain_accepts_the_npm_runtime_node_instead_of_the_default_node() {
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
        // An npm launch resolves `options.node` to the Desktop cua_node while
        // the Shim actually runs the Host Runtime on the npm Node; the cua_node
        // under Desktop only appears later with unrelated MCP helpers.
        let options = ResolvedLaunchOptions {
            shim: shell.clone(),
            node: Path::new("/bin/cat").to_path_buf(),
            host_runtime: sleep.clone(),
            desktop_controller: sleep.clone(),
            renderer_extension: sleep,
            pi: None,
        };
        let not_ready = wait_for_host_chain_with_nodes(
            &snapshot,
            &options,
            std::slice::from_ref(&options.node),
            Duration::from_millis(200),
        )
        .unwrap();
        root.force_terminate().unwrap();
        root.wait().unwrap();
        assert!(
            !not_ready,
            "waiting only for the cua_node must not become ready"
        );
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn host_chain_becomes_ready_once_the_npm_node_pair_exists() {
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
            node: Path::new("/bin/cat").to_path_buf(),
            host_runtime: sleep.clone(),
            desktop_controller: sleep.clone(),
            renderer_extension: sleep.clone(),
            pi: None,
        };
        let nodes = host_runtime_node_candidates(
            options.node.clone(),
            Some(sleep.clone().into_os_string()),
        );
        let ready =
            wait_for_host_chain_with_nodes(&snapshot, &options, &nodes, Duration::from_secs(2))
                .unwrap();
        root.force_terminate().unwrap();
        root.wait().unwrap();
        assert!(
            ready,
            "the Shim-selected npm Node must satisfy Host chain readiness"
        );
    }

    fn snapshot(id: u32, parent_id: u32, started_at_micros: u64) -> ProcessSnapshot {
        ProcessSnapshot {
            id,
            parent_id,
            process_group_id: id,
            executable: PathBuf::from(format!("/fixture/{id}")),
            started_at_micros,
        }
    }

    fn wait_with_inspections(
        results: impl Fn(usize) -> Result<bool, PlatformError>,
    ) -> Result<bool, Box<dyn Error>> {
        let desktop = snapshot(10, 1, 100);
        let mut calls = 0;
        wait_for_host_chain_with_inspector(
            &desktop,
            Path::new("/fixture/shim"),
            &[PathBuf::from("/fixture/node")],
            Duration::from_millis(350),
            || Ok(false),
            |_| {
                calls += 1;
                results(calls)
            },
        )
    }

    fn inspection_error() -> PlatformError {
        PlatformError::Invalid("tree not observable".into())
    }

    #[test]
    fn host_chain_timeout_is_not_an_error_after_a_complete_round_without_a_match() {
        // An early inspection error must not turn the later, fully observed
        // timeout into an Err that skips the caller's cleanup.
        let result = wait_with_inspections(|call| {
            if call == 1 {
                Err(inspection_error())
            } else {
                Ok(false)
            }
        });
        assert!(!result.expect("complete rounds make the timeout an ordinary one"));
    }

    #[test]
    fn host_chain_timeout_reports_inspection_errors_that_never_resolve() {
        assert!(wait_with_inspections(|_| Err(inspection_error())).is_err());
        // The latest round was incomplete, so the tree is still unobserved.
        let error = wait_with_inspections(|call| {
            if call == 1 {
                Ok(false)
            } else {
                Err(inspection_error())
            }
        })
        .expect_err("a trailing incomplete round keeps the error");
        assert!(error.to_string().contains("tree not observable"));
    }

    #[test]
    fn host_chain_observer_aborts_early_on_desktop_exit_or_persistent_direct_stock_cli() {
        let desktop = snapshot(10, 1, 100);
        let shim = Path::new("/fixture/shim");
        let nodes = [PathBuf::from("/fixture/node")];

        // Exited root must abort immediately without waiting for timeout.
        let started = Instant::now();
        let outcome = wait_for_host_chain_with_observer(
            &desktop,
            shim,
            &nodes,
            Duration::from_secs(5),
            Duration::from_millis(150),
            || Ok(false),
            || {
                Ok(HostChainObservation {
                    root_alive: false,
                    tree_size: 0,
                    pair_exists: false,
                    shim_running: false,
                    node_running: false,
                    direct_stock_cli_without_shim: false,
                })
            },
        )
        .unwrap();
        assert_eq!(outcome, HostChainWaitOutcome::DesktopExited);
        assert!(started.elapsed() < Duration::from_secs(1));

        // Persistent direct stock CLI without shim aborts once grace elapses.
        let started = Instant::now();
        let outcome = wait_for_host_chain_with_observer(
            &desktop,
            shim,
            &nodes,
            Duration::from_secs(5),
            Duration::from_millis(150),
            || Ok(false),
            || {
                Ok(HostChainObservation {
                    root_alive: true,
                    tree_size: 3,
                    pair_exists: false,
                    shim_running: false,
                    node_running: false,
                    direct_stock_cli_without_shim: true,
                })
            },
        )
        .unwrap();
        assert_eq!(outcome, HostChainWaitOutcome::DirectStockCliWithoutShim);
        assert!(started.elapsed() < Duration::from_secs(1));

        // A transient direct stock CLI probe followed by a real Host chain becomes Ready.
        let mut calls = 0_usize;
        let outcome = wait_for_host_chain_with_observer(
            &desktop,
            shim,
            &nodes,
            Duration::from_secs(5),
            Duration::from_secs(2),
            || Ok(false),
            || {
                calls += 1;
                Ok(HostChainObservation {
                    root_alive: true,
                    tree_size: 4,
                    pair_exists: calls >= 2,
                    shim_running: calls >= 2,
                    node_running: calls >= 2,
                    direct_stock_cli_without_shim: calls == 1,
                })
            },
        )
        .unwrap();
        assert_eq!(outcome, HostChainWaitOutcome::Ready);
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn desktop_tree_requires_the_original_process_instance() {
        let desktop = snapshot(10, 1, 100);
        // The PID was recycled by a different process, which has its own child.
        let recycled = [snapshot(10, 1, 999), snapshot(11, 10, 1000)];
        assert!(snapshots_in_desktop_tree(&desktop, &recycled).is_none());
        assert!(snapshots_in_desktop_tree(&desktop, &[snapshot(12, 1, 100)]).is_none());
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn desktop_tree_walks_descendants_regardless_of_order_duplicates_or_cycles() {
        let desktop = snapshot(10, 1, 100);
        let snapshots = [
            // Listed before its parent, with a duplicate PID entry for 12.
            snapshot(13, 12, 130),
            snapshot(12, 11, 120),
            snapshot(12, 11, 121),
            snapshot(11, 10, 110),
            snapshot(10, 1, 100),
            // The root appears as a descendant of its own child.
            snapshot(14, 13, 140),
            snapshot(10, 14, 100),
            snapshot(20, 1, 200),
        ];
        let tree = snapshots_in_desktop_tree(&desktop, &snapshots).expect("Desktop is alive");
        let mut ids = tree.iter().map(|process| process.id).collect::<Vec<_>>();
        ids.sort_unstable();
        assert_eq!(ids, [10, 11, 12, 13, 14]);
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
    fn controlled_attachment_checks_nonce_and_treats_busy_eof_or_absence_as_transient() {
        for (reply, expected) in [
            (Some("ready\n"), true),
            (Some("busy\n"), false),
            (Some(""), false),
            (None, false),
        ] {
            let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
            let descriptor = descriptor(listener.local_addr().unwrap().port());
            let nonce = descriptor.nonce.clone();
            let server = if let Some(reply) = reply {
                Some(thread::spawn(move || {
                    let (mut stream, _) = listener.accept().unwrap();
                    let mut request = String::new();
                    BufReader::new(&stream).read_line(&mut request).unwrap();
                    assert_eq!(request, format!("ATTACH {nonce}\n"));
                    stream.write_all(reply.as_bytes()).unwrap();
                }))
            } else {
                drop(listener);
                None
            };
            assert_eq!(
                try_activate_until(&descriptor, Instant::now() + Duration::from_secs(2)).unwrap(),
                expected
            );
            if let Some(server) = server {
                server.join().unwrap();
            }
        }
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
        let stream = TcpStream::connect(("127.0.0.1", descriptor.control_port))
            .expect("Controller connection");

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
