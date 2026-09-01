#![forbid(unsafe_code)]

mod active_update;
mod compatibility;
mod desktop_attachment;
mod installation_layout;
mod native_harness_broker;
mod runtime_instance;
#[cfg(target_os = "linux")]
mod secure_storage;
#[cfg(target_os = "macos")]
mod system_proxy_environment;

use std::env;
use std::error::Error;
use std::ffi::OsString;
#[cfg(any(target_os = "windows", target_os = "linux"))]
use std::fmt::{self, Display, Formatter};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
#[cfg(target_os = "windows")]
use std::process::ExitStatus;
use std::process::{Command, ExitCode, Stdio};
use std::sync::{OnceLock, mpsc};
use std::thread;
use std::time::{Duration, Instant};

#[cfg(target_os = "macos")]
use active_update::start_pending_update;
use active_update::update_waiting_for_launcher_exit;
#[cfg(target_os = "windows")]
use codexhost_platform::{
    APPX_RESUME_ARGUMENT, DesktopProcess, launch_desktop, resume_packaged_application,
};
use codexhost_platform::{
    DesktopIdentity, DesktopInstallation, DesktopLaunchMode, SupervisedChild,
    canonical_existing_file, configure_background_command,
    desktop_root_process_ids_for_installation, discover_codex_desktop, node_entrypoint_path,
    spawn_supervised,
};
#[cfg(any(target_os = "macos", target_os = "linux"))]
use codexhost_platform::{DesktopSession, launch_desktop_session};
#[cfg(target_os = "windows")]
use codexhost_platform::{
    RunningDesktopChoice, hide_console_window, process_executable_path, process_exists,
    prompt_running_desktop, show_error_dialog, terminate_process_by_id,
};
use compatibility::{MAX_CONTROLLER_READINESS_LINE_BYTES, parse_controller_readiness_line};
use desktop_attachment::{
    LauncherOwnership, RuntimeControl, acquire_launcher_ownership, allocate_runtime_control,
    endpoint_ready, publish_runtime_descriptor, stop_stale_launcher, wait_for_host_chain,
};
use installation_layout::InstalledResources;
use native_harness_broker::run_native_harness_broker_cli;
use runtime_instance::{
    StartupObservation, StartupState, classify_startup, default_descriptor_path, read_descriptor,
    remove_matching_descriptor,
};
#[cfg(target_os = "macos")]
use system_proxy_environment::launcher_proxy_environment;

const HOST_NODE_PATH_ENV: &str = "CODEXHOST_HOST_NODE_PATH";
const HOST_RUNTIME_PATH_ENV: &str = "CODEXHOST_HOST_RUNTIME_PATH";
const DATA_DIRECTORY_ENV: &str = "CODEXHOST_DATA_DIR";
const REMOTE_SSH_MANAGED_ENV: &str = "CODEXHOST_REMOTE_SSH_MANAGED";
const PI_COMMAND_ENV: &str = "CODEXHOST_PI_COMMAND";
const DEFAULT_AGENT_ENV: &str = "CODEXHOST_DEFAULT_AGENT";
const LAUNCHER_PID_ENV: &str = "CODEXHOST_LAUNCHER_PID";
const LAUNCHER_EXECUTABLE_ENV: &str = "CODEXHOST_LAUNCHER_EXECUTABLE";
const RUNTIME_DESCRIPTOR_PATH_ENV: &str = "CODEXHOST_RUNTIME_DESCRIPTOR_PATH";
const CONTROL_PORT_ENV: &str = "CODEXHOST_CONTROL_PORT";
const CONTROL_NONCE_ENV: &str = "CODEXHOST_CONTROL_NONCE";
const NPM_NODE_PATH_ENV: &str = "CODEXHOST_NPM_NODE_PATH";
const NPM_CLI_PATH_ENV: &str = "CODEXHOST_NPM_CLI_PATH";
const NPM_LAUNCHER_PATH_ENV: &str = "CODEXHOST_NPM_LAUNCHER_PATH";
const NPM_PACKAGE_ROOT_ENV: &str = "CODEXHOST_NPM_PACKAGE_ROOT";
const CODEXHOST_CLI_PATH_ENV: &str = "CODEXHOST_CLI_PATH";
const NPM_UPDATE_RUNTIME_ENV: [&str; 4] = [
    NPM_NODE_PATH_ENV,
    NPM_CLI_PATH_ENV,
    NPM_LAUNCHER_PATH_ENV,
    NPM_PACKAGE_ROOT_ENV,
];
const START_MENU_ARGUMENT: &str = "--start-menu";
const READY_LINE: &str = "ready";
const STARTUP_TRACE_ENV: &str = "CODEXHOST_STARTUP_TRACE";
const CONTROLLER_STOP_GRACE: Duration = Duration::from_secs(1);
#[cfg(any(target_os = "macos", target_os = "linux"))]
const DESKTOP_TREE_REFRESH_INTERVAL: Duration = Duration::from_millis(500);
#[cfg(any(target_os = "windows", target_os = "linux"))]
const UNMANAGED_DESKTOP_MESSAGE: &str = "Codex Desktop is already running outside codexhost; completely quit it before starting codexhost";

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn desktop_tree_refresh_due(last_refresh: Instant, now: Instant) -> bool {
    now.saturating_duration_since(last_refresh) >= DESKTOP_TREE_REFRESH_INTERVAL
}

fn managed_desktop_data_directory(
    data_directory: Option<OsString>,
    remote_ssh_managed: Option<OsString>,
) -> Option<OsString> {
    if remote_ssh_managed.as_deref() == Some(std::ffi::OsStr::new("1")) {
        None
    } else {
        data_directory
    }
}

#[cfg(any(target_os = "windows", target_os = "linux"))]
#[derive(Debug)]
struct UnmanagedDesktopConflict;

#[cfg(any(target_os = "windows", target_os = "linux"))]
impl Display for UnmanagedDesktopConflict {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter.write_str(UNMANAGED_DESKTOP_MESSAGE)
    }
}

#[cfg(any(target_os = "windows", target_os = "linux"))]
impl Error for UnmanagedDesktopConflict {}

fn usage() {
    eprintln!(
        "usage:\n  codexhost\n  codexhost inspect [--custom-install <absolute-directory>]\n  codexhost launch [--shim <absolute-file>] [--node <absolute-file>] [--host-runtime <absolute-file>] [--desktop-controller <absolute-file>] [--renderer <absolute-file>] [--pi <absolute-file>] [--custom-install <absolute-directory>]\n  codexhost broker install|status|stop|uninstall\n  codexhost skill install|status|uninstall\n  codexhost delegate --help\n  codexhost harness inspect ...\n  codexhost delegate start ...\n  codexhost thread send|cancel|read|wait|list ..."
    );
}

fn run_delegation_cli(arguments: &[String]) -> Result<(), Box<dyn Error>> {
    let executable = env::current_exe()?.canonicalize()?;
    let resources = InstalledResources::from_executable(&executable)?;
    let status = Command::new(&resources.node)
        .arg(node_entrypoint_path(&resources.host_runtime))
        .arg("--codexhost-delegation-cli")
        .args(arguments)
        .env(CODEXHOST_CLI_PATH_ENV, &executable)
        .status()?;
    if status.success() {
        Ok(())
    } else {
        std::process::exit(status.code().unwrap_or(1));
    }
}

fn startup_trace(stage: &str) {
    if env::var_os(STARTUP_TRACE_ENV).as_deref() != Some(std::ffi::OsStr::new("1")) {
        return;
    }
    static STARTED: OnceLock<Instant> = OnceLock::new();
    let elapsed = STARTED.get_or_init(Instant::now).elapsed().as_millis();
    eprintln!("[codexhost startup +{elapsed}ms] launcher: {stage}");
}

/// Emits the exact startup-success signal consumed by the npm/dev wrappers so
/// they can return immediately instead of holding the terminal open.
fn emit_ready_line(output: &mut impl Write) -> std::io::Result<()> {
    writeln!(output, "{READY_LINE}")?;
    output.flush()
}

/// Signals startup success to the invoking parent, then detaches from the
/// controlling terminal so this Launcher keeps supervising the Desktop after
/// the command returns. Startup failures must not reach this point: they exit
/// non-zero on stderr exactly like before.
fn notify_ready_and_detach() -> Result<(), Box<dyn Error>> {
    startup_trace("publishing ready");
    emit_ready_line(&mut std::io::stdout())?;
    codexhost_platform::detach_from_terminal()?;
    Ok(())
}

fn print_installation(installation: &DesktopInstallation, process_ids: &[u32]) {
    match &installation.identity {
        DesktopIdentity::WindowsPackage {
            package_name,
            package_family_name,
            ..
        } => {
            println!("platform=windows");
            println!("package_name={package_name}");
            println!("package_family_name={package_family_name}");
        }
        DesktopIdentity::MacOsBundle { bundle_identifier } => {
            println!("platform=macos");
            println!("bundle_identifier={bundle_identifier}");
        }
        DesktopIdentity::LinuxPackage {
            package_name,
            brand,
            flavor,
        } => {
            println!("platform=linux");
            println!("package_name={package_name}");
            println!("package_brand={brand}");
            println!("package_flavor={flavor}");
        }
    }
    println!("desktop_version={}", installation.version);
    println!("desktop_build={}", installation.build);
    println!("desktop_asar_integrity={}", installation.asar_integrity);
    println!("install_root={}", installation.install_root.display());
    println!(
        "desktop_launcher={}",
        installation.desktop_launcher.display()
    );
    println!(
        "desktop_executable={}",
        installation.desktop_executable.display()
    );
    println!(
        "packaged_codex_cli={}",
        installation.packaged_codex_cli.display()
    );
    println!(
        "executable_codex_cli={}",
        installation.executable_codex_cli.display()
    );
    let process_list = process_ids
        .iter()
        .map(u32::to_string)
        .collect::<Vec<_>>()
        .join(",");
    println!("desktop_process_ids={process_list}");
}

/// Resolve the Codex Desktop installation for this run.
///
/// An explicitly supplied installation root wins over the platform's own
/// discovery; without one the platform probe applies, which on Windows already
/// falls back to the portable-installation override before consulting the AppX
/// PackageManager.
fn discover_desktop(
    custom_install_root: Option<&Path>,
) -> Result<DesktopInstallation, Box<dyn Error>> {
    match custom_install_root {
        #[cfg(target_os = "windows")]
        Some(root) => Ok(codexhost_platform::discover_codex_desktop_from_root(root)?),
        #[cfg(not(target_os = "windows"))]
        Some(_) => Err("--custom-install is supported on Windows only".into()),
        None => Ok(discover_codex_desktop()?),
    }
}

fn inspect(custom_install_root: Option<&Path>) -> Result<(), Box<dyn Error>> {
    let installation = discover_desktop(custom_install_root)?;
    let process_ids = codexhost_platform::desktop_process_ids_for_installation(&installation)?;
    print_installation(&installation, &process_ids);
    Ok(())
}

#[derive(Debug)]
struct LaunchOptions {
    shim: Option<PathBuf>,
    node: Option<PathBuf>,
    host_runtime: Option<PathBuf>,
    desktop_controller: Option<PathBuf>,
    renderer_extension: Option<PathBuf>,
    pi: Option<PathBuf>,
    custom_install_root: Option<PathBuf>,
}

#[derive(Debug)]
struct ResolvedLaunchOptions {
    shim: PathBuf,
    node: PathBuf,
    host_runtime: PathBuf,
    desktop_controller: PathBuf,
    renderer_extension: PathBuf,
    pi: Option<PathBuf>,
    custom_install_root: Option<PathBuf>,
}

fn required_path(arguments: &[String], index: &mut usize, option: &str) -> Result<PathBuf, String> {
    *index += 1;
    arguments
        .get(*index)
        .map(PathBuf::from)
        .ok_or_else(|| format!("{option} requires a path"))
}

fn parse_launch_options(arguments: &[String]) -> Result<LaunchOptions, String> {
    let mut shim = None;
    let mut node = None;
    let mut host_runtime = None;
    let mut desktop_controller = None;
    let mut renderer_extension = None;
    let mut pi = None;
    let mut custom_install_root = None;
    let mut index = 0;
    while index < arguments.len() {
        match arguments[index].as_str() {
            "--shim" => shim = Some(required_path(arguments, &mut index, "--shim")?),
            "--node" => node = Some(required_path(arguments, &mut index, "--node")?),
            "--host-runtime" => {
                host_runtime = Some(required_path(arguments, &mut index, "--host-runtime")?)
            }
            "--desktop-controller" => {
                desktop_controller = Some(required_path(
                    arguments,
                    &mut index,
                    "--desktop-controller",
                )?)
            }
            "--renderer" => {
                renderer_extension = Some(required_path(arguments, &mut index, "--renderer")?)
            }
            "--pi" => pi = Some(required_path(arguments, &mut index, "--pi")?),
            "--custom-install" => {
                custom_install_root =
                    Some(required_path(arguments, &mut index, "--custom-install")?)
            }
            unknown => return Err(format!("unknown launch option: {unknown}")),
        }
        index += 1;
    }
    Ok(LaunchOptions {
        shim,
        node,
        host_runtime,
        desktop_controller,
        renderer_extension,
        pi,
        custom_install_root,
    })
}

/// Parse the options accepted by `codexhost inspect`.
fn parse_inspect_options(arguments: &[String]) -> Result<Option<PathBuf>, String> {
    let mut custom_install_root = None;
    let mut index = 0;
    while index < arguments.len() {
        match arguments[index].as_str() {
            "--custom-install" => {
                custom_install_root =
                    Some(required_path(arguments, &mut index, "--custom-install")?)
            }
            unknown => return Err(format!("unknown inspect option: {unknown}")),
        }
        index += 1;
    }
    Ok(custom_install_root)
}

fn absolute_directory(path: &Path, label: &str) -> Result<PathBuf, Box<dyn Error>> {
    if !path.is_absolute() {
        return Err(format!("{label} must be an absolute path").into());
    }
    if !path.is_dir() {
        return Err(format!("{label} '{}' is not an existing directory", path.display()).into());
    }
    Ok(path.to_path_buf())
}

fn absolute_file(path: &Path, label: &str) -> Result<PathBuf, Box<dyn Error>> {
    if !path.is_absolute() {
        return Err(format!("{label} must be an absolute path").into());
    }
    canonical_existing_file(path)
        .map_err(|error| format!("{label} '{}': {error}", path.display()).into())
}

fn resolve_resource_path(
    explicit: Option<PathBuf>,
    bundled: &Path,
    option: &str,
    bundled_label: &str,
) -> Result<PathBuf, Box<dyn Error>> {
    match explicit {
        Some(path) => absolute_file(&path, option),
        None => absolute_file(bundled, bundled_label),
    }
}

impl LaunchOptions {
    fn resolve(self) -> Result<ResolvedLaunchOptions, Box<dyn Error>> {
        let installed = InstalledResources::from_current_executable()?;
        Ok(ResolvedLaunchOptions {
            shim: resolve_resource_path(self.shim, &installed.shim, "--shim", "bundled Shim")?,
            node: resolve_resource_path(
                self.node,
                &installed.node,
                "--node",
                "bundled Node.js runtime",
            )?,
            host_runtime: resolve_resource_path(
                self.host_runtime,
                &installed.host_runtime,
                "--host-runtime",
                "bundled Host Runtime",
            )?,
            desktop_controller: resolve_resource_path(
                self.desktop_controller,
                &installed.desktop_controller,
                "--desktop-controller",
                "bundled Desktop Controller",
            )?,
            renderer_extension: resolve_resource_path(
                self.renderer_extension,
                &installed.renderer_extension,
                "--renderer",
                "bundled Renderer Extension",
            )?,
            pi: self
                .pi
                .map(|path| absolute_file(&path, "--pi"))
                .transpose()?,
            custom_install_root: self
                .custom_install_root
                .map(|path| absolute_directory(&path, "--custom-install"))
                .transpose()?,
        })
    }
}

fn desktop_controller_command(
    options: &ResolvedLaunchOptions,
    control: &RuntimeControl,
    environment: &[(OsString, OsString)],
) -> Command {
    let mut command = Command::new(&options.node);
    command
        .arg(node_entrypoint_path(&options.desktop_controller))
        .arg("--inspector-endpoint")
        .arg(&control.inspector_endpoint)
        .arg("--renderer")
        .arg(&options.renderer_extension)
        .arg("--default-agent")
        .arg("codex")
        .arg("--attachment-port")
        .arg(control.attachment_port.to_string())
        .arg("--attachment-nonce")
        .arg(&control.nonce);
    for (name, value) in environment {
        if matches!(
            name.to_str(),
            Some(
                "CODEXHOST_STARTUP_TRACE"
                    | "HTTP_PROXY"
                    | "http_proxy"
                    | "HTTPS_PROXY"
                    | "https_proxy"
                    | "ALL_PROXY"
                    | "all_proxy"
                    | "NO_PROXY"
                    | "no_proxy"
                    | "NODE_USE_ENV_PROXY"
            )
        ) {
            command.env(name, value);
        }
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    configure_background_command(&mut command);
    command
}

fn read_bounded_controller_line(mut input: impl Read) -> std::io::Result<Vec<u8>> {
    let mut line = Vec::new();
    while line.len() < MAX_CONTROLLER_READINESS_LINE_BYTES {
        let mut byte = [0_u8; 1];
        if input.read(&mut byte)? == 0 {
            break;
        }
        line.push(byte[0]);
        if byte[0] == b'\n' {
            return Ok(line);
        }
    }
    if line.len() == MAX_CONTROLLER_READINESS_LINE_BYTES && !line.ends_with(b"\n") {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "Desktop Controller readiness exceeded its size limit",
        ));
    }
    Ok(line)
}

fn wait_for_controller_ready(
    controller: &mut SupervisedChild,
    timeout: Duration,
) -> Result<(), Box<dyn Error>> {
    let stdout = controller
        .take_stdout()
        .ok_or("Desktop Controller stdout is unavailable")?;
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        let _ = sender.send(read_bounded_controller_line(stdout));
    });
    let line = receiver
        .recv_timeout(timeout)
        .map_err(|_| "Desktop Controller did not become ready before timeout")??;
    parse_controller_readiness_line(&line)
        .map(|_| ())
        .map_err(|error| format!("Desktop Controller returned invalid readiness: {error}").into())
}

fn start_desktop_controller(
    options: &ResolvedLaunchOptions,
    control: &RuntimeControl,
    environment: &[(OsString, OsString)],
) -> Result<SupervisedChild, Box<dyn Error>> {
    startup_trace("spawning Desktop Controller");
    let mut controller = spawn_supervised(&mut desktop_controller_command(
        options,
        control,
        environment,
    ))?;
    startup_trace("waiting for Desktop Controller readiness");
    match wait_for_controller_ready(&mut controller, Duration::from_secs(120)) {
        Ok(()) => {
            startup_trace("Desktop Controller ready");
            Ok(controller)
        }
        Err(error) => {
            let _ = controller.force_terminate();
            let _ = controller.wait();
            Err(error)
        }
    }
}

#[cfg(target_os = "windows")]
fn wait_for_launched_desktop_ownership(
    installation: &DesktopInstallation,
    desktop: &mut DesktopProcess,
    timeout: Duration,
) -> Result<(), Box<dyn Error>> {
    let desktop_pid = desktop.id();
    let started = Instant::now();
    loop {
        let roots = desktop_root_process_ids_for_installation(installation)?;
        if roots.iter().any(|process_id| *process_id != desktop_pid) {
            if desktop.try_wait()?.is_none() {
                let _ = desktop.kill();
                let _ = desktop.wait();
            }
            return Err(Box::new(UnmanagedDesktopConflict));
        }
        if roots.contains(&desktop_pid) {
            return Ok(());
        }
        if let Some(status) = desktop.try_wait()? {
            return Err(format!(
                "Codex Desktop exited before launch ownership was established: {status}"
            )
            .into());
        }
        if started.elapsed() >= timeout {
            let _ = desktop.kill();
            let _ = desktop.wait();
            return Err("Codex Desktop root did not appear before timeout".into());
        }
        thread::sleep(Duration::from_millis(20));
    }
}

#[cfg(target_os = "windows")]
fn wait_for_desktop_exit(
    desktop: &mut DesktopProcess,
    timeout: Duration,
) -> std::io::Result<Option<ExitStatus>> {
    let started = Instant::now();
    loop {
        if let Some(status) = desktop.try_wait()? {
            return Ok(Some(status));
        }
        if started.elapsed() >= timeout {
            return Ok(None);
        }
        thread::sleep(Duration::from_millis(20));
    }
}

fn should_stop_desktop_for_update(helper_started: bool) -> bool {
    if helper_started {
        return true;
    }
    match update_waiting_for_launcher_exit() {
        Ok(waiting) => waiting,
        Err(error) => {
            eprintln!("codexhost launcher: pending update exit state could not be read: {error}");
            false
        }
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn stop_managed_desktop_for_update(
    desktop: &mut DesktopSession,
    controller: &mut SupervisedChild,
) -> Result<(), Box<dyn Error>> {
    let _ = stop_desktop_controller(controller);
    desktop.shutdown(Duration::from_secs(2))?;
    desktop.cleanup_escaped(Duration::from_secs(2))?;
    desktop.disarm_cleanup();
    Ok(())
}

#[cfg(target_os = "windows")]
fn stop_managed_desktop_for_update(
    desktop: &mut DesktopProcess,
    controller: &mut SupervisedChild,
) -> Result<(), Box<dyn Error>> {
    let _ = stop_desktop_controller(controller);
    let _ = desktop.kill();
    let _ = desktop.wait();
    Ok(())
}

fn stop_desktop_controller(controller: &mut SupervisedChild) -> Result<(), Box<dyn Error>> {
    if let Some(status) = controller.try_wait()? {
        controller.disarm_cleanup();
        if !status.success() {
            return Err(format!("Desktop Controller exited unsuccessfully: {status}").into());
        }
        return Ok(());
    }

    startup_trace("stopping Desktop Controller");
    controller.terminate()?;
    let started = Instant::now();
    while started.elapsed() < CONTROLLER_STOP_GRACE {
        if controller.try_wait()?.is_some() {
            startup_trace("Desktop Controller stopped");
            controller.disarm_cleanup();
            return Ok(());
        }
        thread::sleep(Duration::from_millis(20));
    }

    startup_trace("Desktop Controller did not stop gracefully; forcing termination");
    controller.force_terminate()?;
    let _ = controller.wait()?;
    controller.disarm_cleanup();
    startup_trace("Desktop Controller force-stopped");
    Ok(())
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn supervise_desktop(
    installation: &DesktopInstallation,
    options: &ResolvedLaunchOptions,
    desktop_arguments: &[OsString],
    environment: &[(OsString, OsString)],
    control: &RuntimeControl,
    descriptor_path: &Path,
) -> Result<(), Box<dyn Error>> {
    startup_trace("launching Codex Desktop");
    let mut desktop = launch_desktop_session(
        installation,
        &options.shim,
        if cfg!(target_os = "macos") {
            DesktopLaunchMode::LaunchServices
        } else {
            DesktopLaunchMode::DirectExecutable
        },
        desktop_arguments,
        environment,
        Duration::from_secs(30),
    )?;
    startup_trace("Codex Desktop launched");
    let mut controller = start_desktop_controller(options, control, environment)?;
    let desktop_pid = desktop.root_snapshot().id;
    startup_trace("waiting for Host chain");
    if !wait_for_host_chain(desktop_pid, options, Duration::from_secs(30))? {
        let _ = stop_desktop_controller(&mut controller);
        let _ = desktop.shutdown(Duration::from_secs(2));
        return Err("Codex Desktop did not start the codexhost Host chain before timeout".into());
    }
    startup_trace("Host chain ready");
    let _runtime = publish_runtime_descriptor(descriptor_path, control)?;
    startup_trace("runtime descriptor published");
    notify_ready_and_detach()?;
    #[cfg(target_os = "macos")]
    let mut started_update_request = None;
    let mut last_desktop_tree_refresh = Instant::now();
    loop {
        #[cfg(target_os = "macos")]
        if let Err(error) = start_pending_update(&mut started_update_request) {
            eprintln!("codexhost launcher: pending update could not be started: {error}");
        }
        #[cfg(target_os = "macos")]
        let helper_started = started_update_request.is_some();
        #[cfg(target_os = "linux")]
        let helper_started = false;
        if should_stop_desktop_for_update(helper_started) {
            if let Err(error) = stop_managed_desktop_for_update(&mut desktop, &mut controller) {
                eprintln!(
                    "codexhost launcher: managed Desktop could not be stopped for update: {error}"
                );
            } else {
                return Ok(());
            }
        }
        if let Some(status) = controller.try_wait()? {
            let _ = desktop.shutdown(Duration::from_secs(2));
            return Err(
                format!("Desktop Controller exited while Desktop was running: {status}").into(),
            );
        }
        let now = Instant::now();
        // Check only the owned Desktop root on every 100 ms lifecycle tick. Refresh the full
        // process tree less often so newly spawned descendants remain attributable for cleanup
        // without repeatedly enumerating every system process while the Desktop is idle.
        let root_is_running = desktop.is_running()?;
        let refresh_desktop_tree = desktop_tree_refresh_due(last_desktop_tree_refresh, now);
        let desktop_is_running = if root_is_running && refresh_desktop_tree {
            let live = desktop.observe()?;
            last_desktop_tree_refresh = now;
            live.iter().any(|process| process.id == desktop_pid)
        } else {
            root_is_running
        };
        if !desktop_is_running {
            stop_desktop_controller(&mut controller)?;
            desktop.cleanup_escaped(Duration::from_secs(2))?;
            desktop.disarm_cleanup();
            return Ok(());
        }
        thread::sleep(Duration::from_millis(100));
    }
}

#[cfg(target_os = "windows")]
fn supervise_desktop(
    installation: &DesktopInstallation,
    options: &ResolvedLaunchOptions,
    desktop_arguments: &[OsString],
    environment: &[(OsString, OsString)],
    control: &RuntimeControl,
    descriptor_path: &Path,
) -> Result<(), Box<dyn Error>> {
    startup_trace("launching Codex Desktop");
    let mut desktop = launch_desktop(
        installation,
        &options.shim,
        DesktopLaunchMode::DirectExecutable,
        desktop_arguments,
        environment,
    )?;
    startup_trace("Codex Desktop launched");
    let desktop_pid = desktop.id();
    wait_for_launched_desktop_ownership(installation, &mut desktop, Duration::from_secs(5))?;
    let mut controller = match start_desktop_controller(options, control, environment) {
        Ok(started) => started,
        Err(error) => {
            let _ = desktop.kill();
            let _ = desktop.wait();
            return Err(error);
        }
    };
    startup_trace("waiting for Host chain");
    if !wait_for_host_chain(desktop_pid, options, Duration::from_secs(30))? {
        let _ = stop_desktop_controller(&mut controller);
        let _ = desktop.kill();
        let _ = desktop.wait();
        return Err("Codex Desktop did not start the codexhost Host chain before timeout".into());
    }
    startup_trace("Host chain ready");
    let _runtime = match publish_runtime_descriptor(descriptor_path, control) {
        Ok(runtime) => runtime,
        Err(error) => {
            let _ = stop_desktop_controller(&mut controller);
            let _ = desktop.kill();
            let _ = desktop.wait();
            return Err(error);
        }
    };
    startup_trace("runtime descriptor published");
    notify_ready_and_detach()?;
    loop {
        if should_stop_desktop_for_update(false) {
            if let Err(error) = stop_managed_desktop_for_update(&mut desktop, &mut controller) {
                eprintln!(
                    "codexhost launcher: managed Desktop could not be stopped for update: {error}"
                );
            } else {
                return Ok(());
            }
        }
        if let Some(status) = controller.try_wait()? {
            if let Some(desktop_status) =
                wait_for_desktop_exit(&mut desktop, Duration::from_secs(1))?
            {
                if desktop_status.success() {
                    return Ok(());
                }
                return Err(
                    format!("Codex Desktop exited unsuccessfully: {desktop_status}").into(),
                );
            }
            let _ = desktop.kill();
            let _ = desktop.wait();
            return Err(
                format!("Desktop Controller exited while Desktop was running: {status}").into(),
            );
        }
        if let Some(status) = desktop.try_wait()? {
            stop_desktop_controller(&mut controller)?;
            if !status.success() {
                return Err(format!("Codex Desktop exited unsuccessfully: {status}").into());
            }
            return Ok(());
        }
        thread::sleep(Duration::from_millis(100));
    }
}

fn desktop_environment(
    options: &ResolvedLaunchOptions,
    control: &RuntimeControl,
    launcher_executable: &Path,
    descriptor_path: &Path,
    data_directory: Option<OsString>,
) -> Vec<(OsString, OsString)> {
    let mut environment = vec![
        (
            OsString::from(HOST_NODE_PATH_ENV),
            options.node.as_os_str().to_owned(),
        ),
        (
            OsString::from(HOST_RUNTIME_PATH_ENV),
            options.host_runtime.as_os_str().to_owned(),
        ),
        (OsString::from(DEFAULT_AGENT_ENV), OsString::from("codex")),
        (
            OsString::from(LAUNCHER_PID_ENV),
            OsString::from(std::process::id().to_string()),
        ),
        (
            OsString::from(LAUNCHER_EXECUTABLE_ENV),
            launcher_executable.as_os_str().to_owned(),
        ),
        (
            OsString::from(RUNTIME_DESCRIPTOR_PATH_ENV),
            descriptor_path.as_os_str().to_owned(),
        ),
        (
            OsString::from(CONTROL_PORT_ENV),
            OsString::from(control.attachment_port.to_string()),
        ),
        (
            OsString::from(CONTROL_NONCE_ENV),
            OsString::from(&control.nonce),
        ),
    ];
    if let Some(pi) = &options.pi {
        environment.push((
            OsString::from(PI_COMMAND_ENV),
            node_entrypoint_path(pi).into_os_string(),
        ));
    }
    if let Some(data_directory) = data_directory {
        environment.push((OsString::from(DATA_DIRECTORY_ENV), data_directory));
    }
    if env::var_os(STARTUP_TRACE_ENV).as_deref() == Some(std::ffi::OsStr::new("1")) {
        environment.push((OsString::from(STARTUP_TRACE_ENV), OsString::from("1")));
    }
    environment.extend(npm_update_runtime_environment(env::vars_os()));
    environment
}

/// Forward absolute npm update paths. AppX and LaunchServices do not inherit
/// the Launcher process environment.
fn npm_update_runtime_environment(
    variables: impl IntoIterator<Item = (OsString, OsString)>,
) -> Vec<(OsString, OsString)> {
    let variables = variables.into_iter().collect::<Vec<_>>();
    NPM_UPDATE_RUNTIME_ENV
        .iter()
        .filter_map(|name| {
            variables.iter().find_map(|(candidate, value)| {
                (candidate == name && Path::new(value).is_absolute())
                    .then(|| (OsString::from(*name), value.clone()))
            })
        })
        .collect()
}

#[cfg(target_os = "windows")]
fn windows_executable_key(path: &Path) -> String {
    node_entrypoint_path(path)
        .to_string_lossy()
        .replace('/', "\\")
        .to_lowercase()
}

#[cfg(target_os = "windows")]
fn force_stop_external_desktop(
    installation: &DesktopInstallation,
    timeout: Duration,
) -> Result<(), Box<dyn Error>> {
    let expected = windows_executable_key(&installation.desktop_executable);
    let started = Instant::now();
    loop {
        let process_ids = codexhost_platform::desktop_process_ids_for_installation(installation)?;
        if process_ids.is_empty() {
            return Ok(());
        }
        for process_id in &process_ids {
            let executable = match process_executable_path(*process_id) {
                Ok(executable) => executable,
                Err(_) if !process_exists(*process_id) => continue,
                Err(error) => return Err(error.into()),
            };
            if windows_executable_key(&executable) != expected {
                return Err(format!(
                    "refusing to terminate Codex PID {process_id} because its executable identity changed"
                )
                .into());
            }
        }
        for process_id in process_ids {
            if let Err(error) = terminate_process_by_id(process_id)
                && process_exists(process_id)
            {
                return Err(format!("could not terminate Codex PID {process_id}: {error}").into());
            }
        }
        if started.elapsed() >= timeout {
            return Err("Codex Desktop did not exit after forced restart".into());
        }
        thread::sleep(Duration::from_millis(50));
    }
}

#[cfg(not(target_os = "linux"))]
fn launch(
    options: LaunchOptions,
    _interactive_running_desktop: bool,
) -> Result<(), Box<dyn Error>> {
    startup_trace("launch requested");
    let options = options.resolve()?;
    startup_trace("resources resolved");
    let installation = discover_desktop(options.custom_install_root.as_deref())?;
    startup_trace("Codex Desktop installation discovered");
    startup_trace("acquiring Launcher ownership");
    let _launcher_guard = match acquire_launcher_ownership(&installation, Duration::from_secs(120))?
    {
        LauncherOwnership::Acquired(guard) => {
            startup_trace("Launcher ownership acquired");
            guard
        }
        LauncherOwnership::Attached => {
            startup_trace("attached to existing controlled Desktop");
            return Ok(());
        }
    };

    loop {
        let roots = desktop_root_process_ids_for_installation(&installation)?;
        let descriptor_path = default_descriptor_path()?;
        let descriptor = read_descriptor(&descriptor_path).ok().flatten();
        let descriptor_present = descriptor_path.exists();
        let control_endpoint_ready = descriptor.as_ref().is_some_and(|descriptor| {
            endpoint_ready(descriptor.control_port, Duration::from_millis(300))
        });
        let state = classify_startup(StartupObservation {
            desktop_running: !roots.is_empty(),
            descriptor_present,
            control_endpoint_ready,
        });

        match state {
            StartupState::RecoverStale => {
                if let Some(descriptor) = &descriptor {
                    stop_stale_launcher(descriptor)?;
                    let _ = remove_matching_descriptor(&descriptor_path, descriptor)?;
                } else if descriptor_present {
                    std::fs::remove_file(&descriptor_path)?;
                }
            }
            StartupState::Attach => {
                #[cfg(target_os = "macos")]
                {
                    codexhost_platform::force_stop_desktop(&installation, Duration::from_secs(10))?;
                    continue;
                }
                #[cfg(target_os = "windows")]
                {
                    if _interactive_running_desktop {
                        match prompt_running_desktop() {
                            RunningDesktopChoice::Restart => {
                                force_stop_external_desktop(
                                    &installation,
                                    Duration::from_secs(10),
                                )?;
                                continue;
                            }
                            RunningDesktopChoice::Retry => continue,
                            RunningDesktopChoice::Cancel => return Ok(()),
                        }
                    }
                    // A Desktop is running without a live codexhost owner (an official
                    // instance or a controlled instance whose Launcher exited). Drop the
                    // stale runtime descriptor, force-stop the Desktop, and relaunch.
                    if let Some(descriptor) = &descriptor {
                        let _ = remove_matching_descriptor(&descriptor_path, descriptor);
                    }
                    force_stop_external_desktop(&installation, Duration::from_secs(10))?;
                    continue;
                }
            }
            StartupState::CleanLaunch => {
                if descriptor_present && control_endpoint_ready {
                    return Err(
                        "codexhost control endpoint is still active without a live Desktop; retry after it exits"
                            .into(),
                    );
                }
            }
        }

        let control = allocate_runtime_control()?;
        let launcher_executable = env::current_exe()?.canonicalize()?;
        let environment = desktop_environment(
            &options,
            &control,
            &launcher_executable,
            &descriptor_path,
            managed_desktop_data_directory(
                env::var_os(DATA_DIRECTORY_ENV),
                env::var_os(REMOTE_SSH_MANAGED_ENV),
            ),
        );
        #[cfg(target_os = "macos")]
        let environment = {
            let mut environment = environment;
            environment.extend(launcher_proxy_environment());
            environment
        };
        let result = supervise_desktop(
            &installation,
            &options,
            std::slice::from_ref(&control.inspector_argument),
            &environment,
            &control,
            &descriptor_path,
        );
        #[cfg(target_os = "windows")]
        match result {
            Err(error)
                if _interactive_running_desktop
                    && (error.downcast_ref::<UnmanagedDesktopConflict>().is_some()
                        || error.to_string() == UNMANAGED_DESKTOP_MESSAGE) =>
            {
                continue;
            }
            result => return result,
        }
        #[cfg(target_os = "macos")]
        return result;
    }
}

#[cfg(target_os = "linux")]
fn launch(
    options: LaunchOptions,
    _interactive_running_desktop: bool,
) -> Result<(), Box<dyn Error>> {
    startup_trace("launch requested");
    let options = options.resolve()?;
    startup_trace("resources resolved");
    let installation = discover_desktop(options.custom_install_root.as_deref())?;
    startup_trace("Codex Desktop installation discovered");
    startup_trace("acquiring Launcher ownership");
    let _launcher_guard = match acquire_launcher_ownership(&installation, Duration::from_secs(120))?
    {
        LauncherOwnership::Acquired(guard) => {
            startup_trace("Launcher ownership acquired");
            guard
        }
        LauncherOwnership::Attached => {
            startup_trace("attached to existing controlled Desktop");
            return Ok(());
        }
    };

    let roots = desktop_root_process_ids_for_installation(&installation)?;
    if !roots.is_empty() {
        return Err(Box::new(UnmanagedDesktopConflict));
    }
    let descriptor_path = default_descriptor_path()?;
    let descriptor = read_descriptor(&descriptor_path).ok().flatten();
    let descriptor_present = descriptor_path.exists();
    let control_endpoint_ready = descriptor.as_ref().is_some_and(|descriptor| {
        endpoint_ready(descriptor.control_port, Duration::from_millis(300))
    });
    match classify_startup(StartupObservation {
        desktop_running: false,
        descriptor_present,
        control_endpoint_ready,
    }) {
        StartupState::RecoverStale => {
            if let Some(descriptor) = &descriptor {
                stop_stale_launcher(descriptor)?;
                let _ = remove_matching_descriptor(&descriptor_path, descriptor)?;
            } else if descriptor_present {
                return Err("codexhost runtime descriptor is invalid; remove it after checking its ownership".into());
            }
        }
        StartupState::Attach => unreachable!("no Desktop roots were observed"),
        StartupState::CleanLaunch if descriptor_present && control_endpoint_ready => {
            return Err(
                "codexhost control endpoint is still active without a live Desktop; retry after it exits"
                    .into(),
            );
        }
        StartupState::CleanLaunch => {}
    }
    let control = allocate_runtime_control()?;
    let launcher_executable = env::current_exe()?.canonicalize()?;
    let environment = desktop_environment(
        &options,
        &control,
        &launcher_executable,
        &descriptor_path,
        managed_desktop_data_directory(
            env::var_os(DATA_DIRECTORY_ENV),
            env::var_os(REMOTE_SSH_MANAGED_ENV),
        ),
    );
    supervise_desktop(
        &installation,
        &options,
        std::slice::from_ref(&control.inspector_argument),
        &environment,
        &control,
        &descriptor_path,
    )
}

fn default_launch_options() -> LaunchOptions {
    LaunchOptions {
        shim: None,
        node: None,
        host_runtime: None,
        desktop_controller: None,
        renderer_extension: None,
        pi: None,
        custom_install_root: None,
    }
}

fn run(arguments: &[String]) -> Result<(), Box<dyn Error>> {
    match arguments.first().map(String::as_str) {
        #[cfg(target_os = "windows")]
        Some(APPX_RESUME_ARGUMENT) => {
            resume_packaged_application(&arguments[1..]).map_err(Into::into)
        }
        None => launch(default_launch_options(), false),
        Some(START_MENU_ARGUMENT) if arguments.len() == 1 => launch(default_launch_options(), true),
        Some("inspect") => {
            let custom_install_root = parse_inspect_options(&arguments[1..])?
                .map(|path| absolute_directory(&path, "--custom-install"))
                .transpose()?;
            inspect(custom_install_root.as_deref())
        }
        Some("launch") => launch(parse_launch_options(&arguments[1..])?, false),
        Some("broker") => run_native_harness_broker_cli(&arguments[1..]),
        Some("skill") | Some("harness") | Some("delegate") | Some("thread") => {
            run_delegation_cli(arguments)
        }
        _ => {
            usage();
            Err("invalid launcher arguments".into())
        }
    }
}

fn main() -> ExitCode {
    let arguments = env::args().skip(1).collect::<Vec<_>>();
    #[cfg(target_os = "windows")]
    let start_menu_launch = arguments.as_slice() == [START_MENU_ARGUMENT];
    #[cfg(target_os = "windows")]
    let appx_resume = arguments
        .first()
        .is_some_and(|argument| argument == APPX_RESUME_ARGUMENT);
    #[cfg(target_os = "windows")]
    if start_menu_launch || appx_resume {
        hide_console_window();
    }
    match run(&arguments) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            let message = format!("codexhost launcher: {error}");
            eprintln!("{message}");
            #[cfg(target_os = "windows")]
            if start_menu_launch {
                show_error_dialog(&message);
            }
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    #[cfg(target_os = "windows")]
    use std::ffi::OsStr;
    use std::ffi::OsString;
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;
    use std::path::{Path, PathBuf};
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    use std::process::Command;
    #[cfg(target_os = "macos")]
    use std::process::Stdio;
    use std::thread;
    #[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
    use std::time::Duration;
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    use std::time::Instant;

    #[cfg(target_os = "windows")]
    use codexhost_platform::configure_background_command;
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    use codexhost_platform::spawn_supervised;

    #[cfg(target_os = "windows")]
    use super::PI_COMMAND_ENV;
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    use super::stop_desktop_controller;
    #[cfg(target_os = "macos")]
    use super::wait_for_controller_ready;
    #[cfg(target_os = "windows")]
    use super::wait_for_desktop_exit;
    use super::{
        CONTROL_NONCE_ENV, CONTROL_PORT_ENV, DEFAULT_AGENT_ENV, HOST_NODE_PATH_ENV,
        LAUNCHER_EXECUTABLE_ENV, LAUNCHER_PID_ENV, NPM_CLI_PATH_ENV, NPM_LAUNCHER_PATH_ENV,
        NPM_NODE_PATH_ENV, NPM_PACKAGE_ROOT_ENV, RUNTIME_DESCRIPTOR_PATH_ENV,
        ResolvedLaunchOptions, RuntimeControl, STARTUP_TRACE_ENV, absolute_directory,
        allocate_runtime_control, desktop_controller_command, desktop_environment, emit_ready_line,
        managed_desktop_data_directory, npm_update_runtime_environment, parse_inspect_options,
        parse_launch_options, read_bounded_controller_line,
    };
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    use super::{DESKTOP_TREE_REFRESH_INTERVAL, desktop_tree_refresh_due};
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn throttles_full_desktop_tree_refreshes() {
        let started = Instant::now();

        assert!(!desktop_tree_refresh_due(
            started,
            started + DESKTOP_TREE_REFRESH_INTERVAL - Duration::from_millis(1),
        ));
        assert!(desktop_tree_refresh_due(
            started,
            started + DESKTOP_TREE_REFRESH_INTERVAL,
        ));
    }

    #[test]
    fn ready_line_is_the_exact_wrapper_protocol() {
        let mut output = Vec::new();
        emit_ready_line(&mut output).expect("emit ready line");
        assert_eq!(output, b"ready\n");
    }

    #[test]
    fn controller_readiness_reader_bounds_eof_and_missing_newline() {
        assert_eq!(
            read_bounded_controller_line(std::io::Cursor::new(Vec::<u8>::new()))
                .expect("empty EOF"),
            Vec::<u8>::new()
        );
        assert_eq!(
            read_bounded_controller_line(std::io::Cursor::new(b"partial".to_vec()))
                .expect("partial EOF"),
            b"partial"
        );
        assert!(
            read_bounded_controller_line(std::io::Cursor::new(vec![
                b'a';
                crate::compatibility::MAX_CONTROLLER_READINESS_LINE_BYTES
            ]))
            .is_err()
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn intentional_controller_termination_accepts_the_job_exit_status() {
        let mut command = Command::new("cmd.exe");
        command.args(["/d", "/c", "ping", "-n", "30", "127.0.0.1", ">nul"]);
        configure_background_command(&mut command);
        let mut controller = spawn_supervised(&mut command).expect("spawn Controller fixture");

        stop_desktop_controller(&mut controller).expect("stop owned Controller");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn force_stops_a_controller_that_ignores_graceful_termination() {
        let mut command = Command::new("/bin/bash");
        command.args(["-c", "trap '' TERM; while :; do sleep 1; done"]);
        command.stdout(Stdio::null()).stderr(Stdio::null());
        let mut controller = spawn_supervised(&mut command).expect("spawn Controller fixture");
        thread::sleep(Duration::from_millis(50));

        let started = Instant::now();
        stop_desktop_controller(&mut controller).expect("force-stop owned Controller");

        assert!(started.elapsed() < Duration::from_secs(3));
        assert!(controller.try_wait().expect("Controller status").is_some());
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn observes_a_normal_desktop_exit_during_controller_shutdown() {
        let desktop = Command::new("cmd.exe")
            .args(["/d", "/c", "exit", "0"])
            .spawn()
            .expect("spawn exiting Desktop fixture");
        let mut desktop = codexhost_platform::DesktopProcess::from_child(desktop);

        let status = wait_for_desktop_exit(&mut desktop, Duration::from_secs(1))
            .expect("observe Desktop exit")
            .expect("Desktop exited before timeout");
        assert!(status.success());
    }

    #[test]
    fn bundled_runtime_paths_are_optional_launch_arguments() {
        let options = parse_launch_options(&[]).expect("bundled launch options");

        assert!(options.shim.is_none());
        assert!(options.node.is_none());
        assert!(options.host_runtime.is_none());
        assert!(options.desktop_controller.is_none());
        assert!(options.renderer_extension.is_none());
    }

    #[test]
    fn explicit_development_paths_remain_supported() {
        let options = parse_launch_options(&[
            "--shim".into(),
            "/opt/codexhost-shim".into(),
            "--node".into(),
            "/opt/node".into(),
            "--host-runtime".into(),
            "/opt/host-runtime.mjs".into(),
            "--desktop-controller".into(),
            "/opt/desktop-controller.mjs".into(),
            "--renderer".into(),
            "/opt/renderer-extension.js".into(),
        ])
        .expect("explicit development paths");

        assert!(options.shim.is_some());
        assert!(options.node.is_some());
        assert!(options.host_runtime.is_some());
        assert!(options.desktop_controller.is_some());
        assert!(options.renderer_extension.is_some());
    }

    #[test]
    fn custom_install_root_is_accepted_by_launch_and_inspect() {
        let options =
            parse_launch_options(&["--custom-install".into(), "/opt/CodexPortable".into()])
                .expect("launch accepts a custom install root");
        assert_eq!(
            options.custom_install_root.as_deref(),
            Some(Path::new("/opt/CodexPortable"))
        );

        assert_eq!(
            parse_inspect_options(&["--custom-install".into(), "/opt/CodexPortable".into()])
                .expect("inspect accepts a custom install root")
                .as_deref(),
            Some(Path::new("/opt/CodexPortable"))
        );
        assert_eq!(parse_inspect_options(&[]).expect("bare inspect"), None);
    }

    #[test]
    fn removed_agent_option_is_rejected() {
        assert!(parse_launch_options(&["--agent".into(), "pi".into()]).is_err());
    }

    #[test]
    fn custom_install_root_rejects_missing_values_and_unknown_options() {
        assert!(parse_launch_options(&["--custom-install".into()]).is_err());
        assert!(parse_inspect_options(&["--custom-install".into()]).is_err());
        assert!(parse_inspect_options(&["--unknown".into()]).is_err());
    }

    #[test]
    fn custom_install_root_must_be_an_existing_absolute_directory() {
        assert!(absolute_directory(Path::new("relative/path"), "--custom-install").is_err());
        assert!(
            absolute_directory(Path::new("/definitely/absent/codex"), "--custom-install").is_err()
        );
        let existing = std::env::temp_dir();
        assert_eq!(
            absolute_directory(&existing, "--custom-install").expect("existing directory"),
            existing
        );
    }

    fn resolved_options() -> ResolvedLaunchOptions {
        ResolvedLaunchOptions {
            shim: PathBuf::from("/opt/codexhost-shim"),
            node: PathBuf::from("/opt/node"),
            host_runtime: PathBuf::from("/opt/host-runtime.mjs"),
            desktop_controller: PathBuf::from("/opt/desktop-controller.mjs"),
            renderer_extension: PathBuf::from("/opt/renderer-extension.js"),
            pi: None,
            custom_install_root: None,
        }
    }

    fn runtime_control() -> RuntimeControl {
        RuntimeControl {
            inspector_endpoint: "http://127.0.0.1:43123".into(),
            inspector_argument: "--inspect=127.0.0.1:43123".into(),
            attachment_port: 43124,
            nonce: "0123456789abcdef0123456789abcdef".into(),
        }
    }

    #[test]
    fn production_controller_uses_private_node_and_loopback_inspector() {
        let options = resolved_options();
        let command = desktop_controller_command(&options, &runtime_control(), &[]);
        assert_eq!(command.get_program(), "/opt/node");
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            [
                "/opt/desktop-controller.mjs",
                "--inspector-endpoint",
                "http://127.0.0.1:43123",
                "--renderer",
                "/opt/renderer-extension.js",
                "--default-agent",
                "codex",
                "--attachment-port",
                "43124",
                "--attachment-nonce",
                "0123456789abcdef0123456789abcdef",
            ]
        );

        let control = allocate_runtime_control().expect("ephemeral runtime control");
        assert!(control.inspector_endpoint.starts_with("http://127.0.0.1:"));
        let inspector_port = control
            .inspector_endpoint
            .rsplit(':')
            .next()
            .expect("Inspector endpoint port")
            .parse::<u16>()
            .expect("numeric Inspector endpoint port");
        assert_ne!(inspector_port, control.attachment_port);
        assert!(
            control
                .inspector_argument
                .to_string_lossy()
                .starts_with("--inspect=127.0.0.1:")
        );
        assert!(
            !control
                .inspector_argument
                .to_string_lossy()
                .contains("remote-debugging")
        );
        let environment = desktop_environment(
            &options,
            &control,
            Path::new("/opt/codexhost"),
            Path::new("/run/user/1000/codexhost/desktop-runtime-v1.json"),
            None,
        );
        let value = |name: &str| {
            environment
                .iter()
                .find(|(candidate, _)| candidate == name)
                .map(|(_, value)| value)
        };
        assert_eq!(value(DEFAULT_AGENT_ENV), Some(&OsString::from("codex")));
        assert_eq!(
            value(LAUNCHER_PID_ENV),
            Some(&OsString::from(std::process::id().to_string()))
        );
        assert_eq!(
            value(LAUNCHER_EXECUTABLE_ENV),
            Some(&OsString::from("/opt/codexhost"))
        );
        assert_eq!(
            value(RUNTIME_DESCRIPTOR_PATH_ENV),
            Some(&OsString::from(
                "/run/user/1000/codexhost/desktop-runtime-v1.json"
            ))
        );
        assert_eq!(
            value(CONTROL_PORT_ENV),
            Some(&OsString::from(control.attachment_port.to_string()))
        );
        assert_eq!(
            value(CONTROL_NONCE_ENV),
            Some(&OsString::from(&control.nonce))
        );
    }

    #[test]
    fn npm_update_runtime_environment_forwards_only_absolute_paths() {
        let fixture_root = std::env::current_dir()
            .expect("resolve current directory")
            .join("npm-runtime-fixture");
        let node_path = fixture_root.join("node");
        let cli_path = fixture_root.join("npm/bin/npm-cli.js");
        let package_root = fixture_root.join("@codexhost/cli-platform");
        let forwarded = npm_update_runtime_environment([
            (
                OsString::from(NPM_NODE_PATH_ENV),
                node_path.clone().into_os_string(),
            ),
            (
                OsString::from(NPM_CLI_PATH_ENV),
                cli_path.clone().into_os_string(),
            ),
            (
                OsString::from(NPM_LAUNCHER_PATH_ENV),
                OsString::from("codexhost.js"),
            ),
            (
                OsString::from(NPM_PACKAGE_ROOT_ENV),
                package_root.clone().into_os_string(),
            ),
            (
                OsString::from("UNRELATED"),
                fixture_root.join("unrelated").into_os_string(),
            ),
        ]);

        assert_eq!(
            forwarded,
            [
                (
                    OsString::from(NPM_NODE_PATH_ENV),
                    node_path.into_os_string(),
                ),
                (OsString::from(NPM_CLI_PATH_ENV), cli_path.into_os_string(),),
                (
                    OsString::from(NPM_PACKAGE_ROOT_ENV),
                    package_root.into_os_string(),
                ),
            ]
        );
    }

    #[test]
    fn desktop_environment_propagates_an_explicit_local_data_directory() {
        let environment = desktop_environment(
            &resolved_options(),
            &runtime_control(),
            Path::new("/opt/codexhost"),
            Path::new("/run/user/1000/codexhost/desktop-runtime-v1.json"),
            Some(OsString::from("/home/codex/.codexhost")),
        );

        assert!(environment.contains(&(
            OsString::from("CODEXHOST_DATA_DIR"),
            OsString::from("/home/codex/.codexhost"),
        )));
    }

    #[test]
    fn managed_desktop_data_directory_rejects_a_remote_profile_value() {
        let remote_data = Some(OsString::from("/home/codex/.codexhost/remote/data"));

        assert_eq!(
            managed_desktop_data_directory(remote_data.clone(), Some(OsString::from("1"))),
            None
        );
        assert_eq!(
            managed_desktop_data_directory(remote_data.clone(), None),
            remote_data
        );
    }

    #[test]
    fn controller_receives_only_the_managed_network_environment() {
        let options = resolved_options();
        let command = desktop_controller_command(
            &options,
            &runtime_control(),
            &[
                (
                    OsString::from("HTTPS_PROXY"),
                    OsString::from("http://proxy:8443"),
                ),
                (
                    OsString::from(HOST_NODE_PATH_ENV),
                    OsString::from("/private/node"),
                ),
                (OsString::from(STARTUP_TRACE_ENV), OsString::from("1")),
            ],
        );
        let environment = command.get_envs().collect::<Vec<_>>();

        assert!(environment.contains(&(
            std::ffi::OsStr::new("HTTPS_PROXY"),
            Some(std::ffi::OsStr::new("http://proxy:8443")),
        )));
        assert!(environment.contains(&(
            std::ffi::OsStr::new(STARTUP_TRACE_ENV),
            Some(std::ffi::OsStr::new("1")),
        )));
        assert!(
            !environment
                .iter()
                .any(|(name, _)| *name == HOST_NODE_PATH_ENV)
        );
    }

    #[test]
    fn controlled_attachment_uses_the_exact_nonce_handshake() {
        use crate::desktop_attachment::try_activate_controlled_instance;
        use crate::runtime_instance::RuntimeDescriptor;
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("attachment listener");
        let port = listener.local_addr().expect("attachment address").port();
        let descriptor =
            RuntimeDescriptor::new(10, port, "0123456789abcdef0123456789abcdef".into())
                .expect("runtime descriptor");
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("attachment connection");
            let mut request = String::new();
            BufReader::new(stream.try_clone().expect("clone stream"))
                .read_line(&mut request)
                .expect("attachment request");
            assert_eq!(request, "ATTACH 0123456789abcdef0123456789abcdef\n");
            writeln!(stream, "ready").expect("attachment response");
        });
        assert!(try_activate_controlled_instance(&descriptor).expect("controlled attachment"));
        server.join().expect("attachment server");
    }

    #[test]
    fn controlled_attachment_is_unavailable_when_its_controller_is_absent() {
        use crate::desktop_attachment::try_activate_controlled_instance;
        use crate::runtime_instance::RuntimeDescriptor;
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("temporary listener");
        let port = listener.local_addr().expect("listener address").port();
        drop(listener);
        let descriptor =
            RuntimeDescriptor::new(10, port, "0123456789abcdef0123456789abcdef".into())
                .expect("runtime descriptor");

        assert!(!try_activate_controlled_instance(&descriptor).expect("unavailable Controller"));
    }

    #[test]
    fn controlled_attachment_retries_a_transient_empty_controller_response() {
        use crate::desktop_attachment::try_activate_controlled_instance;
        use crate::runtime_instance::RuntimeDescriptor;
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("attachment listener");
        let port = listener.local_addr().expect("attachment address").port();
        let descriptor =
            RuntimeDescriptor::new(10, port, "0123456789abcdef0123456789abcdef".into())
                .expect("runtime descriptor");
        let server = thread::spawn(move || {
            let (stream, _) = listener.accept().expect("attachment connection");
            let mut request = String::new();
            BufReader::new(stream.try_clone().expect("clone stream"))
                .read_line(&mut request)
                .expect("attachment request");
            assert_eq!(request, "ATTACH 0123456789abcdef0123456789abcdef\n");
            // Simulate a Controller that was still restoring the Desktop: close
            // the socket without a response line.
            drop(stream);
        });
        assert!(!try_activate_controlled_instance(&descriptor).expect("transient response"));
        server.join().expect("attachment server");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn production_controller_normalizes_a_verbatim_node_entrypoint() {
        let options = ResolvedLaunchOptions {
            desktop_controller: PathBuf::from(r"\\?\C:\Program Files\codexhost\controller.mjs"),
            ..resolved_options()
        };
        let command = desktop_controller_command(&options, &runtime_control(), &[]);

        assert_eq!(
            command.get_args().next(),
            Some(OsStr::new(r"C:\Program Files\codexhost\controller.mjs")),
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn pi_environment_normalizes_a_verbatim_command_script() {
        let options = ResolvedLaunchOptions {
            pi: Some(PathBuf::from(r"\\?\C:\nvm4w\nodejs\pi.cmd")),
            ..resolved_options()
        };

        assert_eq!(
            desktop_environment(
                &options,
                &runtime_control(),
                Path::new(r"C:\codexhost.exe"),
                Path::new(r"C:\Users\Codex\AppData\Local\codexhost\desktop-runtime-v1.json"),
                None,
            )
            .into_iter()
            .find(|(name, _)| name == PI_COMMAND_ENV)
            .map(|(_, value)| value),
            Some(OsString::from(r"C:\nvm4w\nodejs\pi.cmd")),
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn controller_must_emit_strict_json_readiness() {
        let mut command = Command::new("/bin/sh");
        command
            .args([
                "-c",
                "printf '%s\\n' '{\"schemaVersion\":2,\"state\":\"compatible\",\"issues\":[]}'",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let mut controller = spawn_supervised(&mut command).expect("fake Controller");
        wait_for_controller_ready(&mut controller, Duration::from_secs(2))
            .expect("Controller ready");
        controller.wait().expect("wait fake Controller");
        controller.disarm_cleanup();
    }
}
