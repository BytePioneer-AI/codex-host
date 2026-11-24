#![forbid(unsafe_code)]

mod active_update;
mod autostart;
mod compatibility;
mod console;
mod desktop_attachment;
#[cfg(unix)]
mod desktop_lifecycle;
#[cfg(unix)]
mod desktop_lifecycle_storage;
mod desktop_path_overrides;
mod desktop_shell;
mod host_service;
mod installation_layout;
mod launch_preferences;
mod native_harness_broker;
mod runtime_instance;
#[cfg(unix)]
mod secure_storage;
mod service_update;
mod services;
mod startup_record;
mod system_proxy_environment;
mod web_service;

use std::env;
use std::error::Error;
use std::ffi::OsString;
#[cfg(any(target_os = "windows", target_os = "linux"))]
use std::fmt::{self, Display, Formatter};
use std::io::{IsTerminal, Read, Write};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
#[cfg(target_os = "windows")]
use std::process::ExitStatus;
use std::process::{Command, ExitCode, Stdio};
use std::sync::{OnceLock, mpsc};
use std::thread;
use std::time::{Duration, Instant};

#[cfg(any(target_os = "macos", target_os = "windows"))]
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
#[cfg(any(target_os = "macos", target_os = "linux"))]
use desktop_attachment::wait_for_host_chain;
#[cfg(target_os = "windows")]
use desktop_attachment::{
    HostChainWaitOutcome, endpoint_ready, publish_runtime_descriptor, stop_stale_launcher,
    wait_for_host_chain_outcome,
};
use desktop_attachment::{
    LauncherOwnership, RuntimeControl, acquire_launcher_ownership, allocate_runtime_control,
};
#[cfg(unix)]
use desktop_lifecycle::Lifecycle;
use installation_layout::InstalledResources;
use launch_preferences::{Preferences, Surface};
use native_harness_broker::run_native_harness_broker_cli;
use runtime_instance::default_descriptor_path;
#[cfg(target_os = "windows")]
use runtime_instance::{
    StartupObservation, StartupState, classify_startup, read_descriptor, remove_matching_descriptor,
};
use startup_record::StartupOutcome;

const HOST_NODE_PATH_ENV: &str = "CODEXHOST_HOST_NODE_PATH";
const HOST_RUNTIME_PATH_ENV: &str = "CODEXHOST_HOST_RUNTIME_PATH";
const DATA_DIRECTORY_ENV: &str = "CODEXHOST_DATA_DIR";
const REMOTE_SSH_MANAGED_ENV: &str = "CODEXHOST_REMOTE_SSH_MANAGED";
const PI_COMMAND_ENV: &str = "CODEXHOST_PI_COMMAND";
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
/// Node used by the delegation CLI when the installation has no bundled Node
/// (npm packages rely on the user's Node). Only this launcher reads it.
const CODEXHOST_CLI_NODE_PATH_ENV: &str = "CODEXHOST_CLI_NODE_PATH";
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

#[cfg(target_os = "windows")]
#[derive(Debug)]
struct TransientAppxStartupError(String);

#[cfg(target_os = "windows")]
impl Display for TransientAppxStartupError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

#[cfg(target_os = "windows")]
impl Error for TransientAppxStartupError {}

const USAGE: &str = "usage:
  codexhost
  codexhost --help
  codexhost --version
  codexhost inspect [--json] [--custom-install <absolute-directory>]
  codexhost app [--onboarding]
  codexhost launch-prefs get --json
  codexhost launch-prefs set --surface <native-shell|codex-desktop> [--onboarding-completed true|false]
  codexhost web [--background] [--connect-devices] [--host <address>] [--port <port>] [--public-url <url>] [--trusted-proxy <addresses>] [--relay <control-host>]
  codexhost stop
  codexhost status
  codexhost autostart on|off|status
  codexhost console
  codexhost update
  codexhost launch [--windows-direct] [--shim <absolute-file>] [--node <absolute-file>] [--host-runtime <absolute-file>] [--desktop-controller <absolute-file>] [--renderer <absolute-file>] [--pi <absolute-file>] [--custom-install <absolute-directory>]
  codexhost desktop-screenshot
  codexhost broker install|status|stop|uninstall
  codexhost delegate --help
  codexhost host info ...
  codexhost project list ...
  codexhost harness list|inspect ...
  codexhost delegate start ...
  codexhost thread send|cancel|read|wait|watch|watches|list|file ...
  codexhost thread export <thread> (rarely needed)
  codexhost client status|on|off|create|list|revoke ...
  codexhost events pull|ack ...";

fn usage() {
    eprintln!("{USAGE}");
}

const LOOPBACK_URL_MAX_BYTES: u64 = 4096;

fn validate_loopback_root_url(value: &str) -> Result<(), &'static str> {
    let authority_and_path = value
        .strip_prefix("http://")
        .or_else(|| value.strip_prefix("https://"))
        .ok_or("native URL must use HTTP or HTTPS")?;
    let (authority, path) = authority_and_path
        .split_once('/')
        .ok_or("native URL must include a root path")?;
    if authority.contains('@') || path.contains('#') || !(path.is_empty() || path.starts_with('?'))
    {
        return Err("native URL must be an uncredentialed loopback root");
    }
    let loopback = authority
        .parse::<SocketAddr>()
        .map(|address| address.port() != 0 && address.ip().is_loopback())
        .unwrap_or_else(|_| {
            authority.rsplit_once(':').is_some_and(|(host, port)| {
                host.eq_ignore_ascii_case("localhost")
                    && port.parse::<u16>().is_ok_and(|port| port != 0)
            })
        });
    if !loopback {
        return Err("native URL must target a loopback authority with an explicit port");
    }
    Ok(())
}

fn read_bounded_loopback_url(reader: impl Read) -> Result<String, Box<dyn Error>> {
    let mut bytes = Vec::new();
    reader
        .take(LOOPBACK_URL_MAX_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > LOOPBACK_URL_MAX_BYTES {
        return Err("native URL exceeds its byte limit".into());
    }
    let value = String::from_utf8(bytes)?;
    if value.is_empty() || value.contains('\r') || value.contains('\n') {
        return Err("native URL must be one non-empty line".into());
    }
    Ok(value)
}

fn run_delegation_cli(arguments: &[String]) -> Result<(), Box<dyn Error>> {
    let executable = env::current_exe()?.canonicalize()?;
    let resources = InstalledResources::from_executable(&executable)?;
    let node = delegation_node(&resources.node, env::var_os(CODEXHOST_CLI_NODE_PATH_ENV))?;
    let status = Command::new(&node)
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

/// Prefer the bundled Node; npm installations have none and use the Host's.
/// A relative bundled path (source checkout) is resolved by the OS as before.
fn delegation_node(bundled: &Path, host_node: Option<OsString>) -> Result<PathBuf, String> {
    if !bundled.is_absolute() || bundled.is_file() {
        return Ok(bundled.to_path_buf());
    }
    match host_node.map(PathBuf::from) {
        Some(node) if node.is_absolute() => Ok(node),
        _ => Err(format!(
            "codexhost delegation cannot find Node: {} does not exist and {CODEXHOST_CLI_NODE_PATH_ENV} is not an absolute path. Run this command inside a codexhost-managed session; if a shell environment policy filters variables, keep {CODEXHOST_CLI_NODE_PATH_ENV}.",
            bundled.display()
        )),
    }
}

pub(crate) fn startup_trace(stage: &str) {
    startup_record::stage(stage);
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
    startup_record::finish(StartupOutcome::Ready, None);
    console::show_for_launch(None);
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
        Some(root) => Ok(codexhost_platform::discover_codex_desktop_from_root(
            &absolute_directory(root, "--custom-install")?,
        )?),
        #[cfg(not(target_os = "windows"))]
        Some(_) => Err("--custom-install is supported on Windows only".into()),
        None => Ok(discover_codex_desktop()?),
    }
}

fn inspect(custom_install_root: Option<&Path>, json: bool) -> Result<(), Box<dyn Error>> {
    if json {
        let document = console::inspect_json(discover_desktop(custom_install_root))?;
        println!("{}", serde_json::to_string(&document)?);
        return Ok(());
    }
    let installation = discover_desktop(custom_install_root)?;
    let process_ids = codexhost_platform::desktop_process_ids_for_installation(&installation)?;
    print_installation(&installation, &process_ids);
    Ok(())
}

#[derive(Debug)]
struct LaunchOptions {
    update_recovery: bool,
    windows_direct: bool,
    shim: Option<PathBuf>,
    node: Option<PathBuf>,
    host_runtime: Option<PathBuf>,
    web_runtime: Option<PathBuf>,
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
}

fn required_path(arguments: &[String], index: &mut usize, option: &str) -> Result<PathBuf, String> {
    *index += 1;
    arguments
        .get(*index)
        .map(PathBuf::from)
        .ok_or_else(|| format!("{option} requires a path"))
}

fn parse_launch_options(arguments: &[String]) -> Result<LaunchOptions, String> {
    let mut update_recovery = false;
    let mut windows_direct = false;
    let mut shim = None;
    let mut node = None;
    let mut host_runtime = None;
    let mut web_runtime = None;
    let mut desktop_controller = None;
    let mut renderer_extension = None;
    let mut pi = None;
    let mut custom_install_root = None;
    let mut index = 0;
    while index < arguments.len() {
        match arguments[index].as_str() {
            "--update-recovery" => update_recovery = true,
            "--windows-direct" => windows_direct = true,
            "--shim" => shim = Some(required_path(arguments, &mut index, "--shim")?),
            "--node" => node = Some(required_path(arguments, &mut index, "--node")?),
            "--host-runtime" => {
                host_runtime = Some(required_path(arguments, &mut index, "--host-runtime")?)
            }
            "--web-runtime" => {
                web_runtime = Some(required_path(arguments, &mut index, "--web-runtime")?)
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
    if windows_direct && custom_install_root.is_some() {
        return Err("--windows-direct cannot be combined with --custom-install".into());
    }
    if windows_direct && !cfg!(target_os = "windows") {
        return Err("--windows-direct is supported on Windows only".into());
    }
    Ok(LaunchOptions {
        update_recovery,
        windows_direct,
        shim,
        node,
        host_runtime,
        web_runtime,
        desktop_controller,
        renderer_extension,
        pi,
        custom_install_root,
    })
}

/// Parse the options accepted by `codexhost inspect`.
#[derive(Debug, Default, PartialEq, Eq)]
struct InspectOptions {
    custom_install_root: Option<PathBuf>,
    json: bool,
}

fn parse_inspect_options(arguments: &[String]) -> Result<InspectOptions, String> {
    let mut options = InspectOptions::default();
    let mut index = 0;
    while index < arguments.len() {
        match arguments[index].as_str() {
            "--custom-install" => {
                options.custom_install_root =
                    Some(required_path(arguments, &mut index, "--custom-install")?)
            }
            "--json" => options.json = true,
            unknown => return Err(format!("unknown inspect option: {unknown}")),
        }
        index += 1;
    }
    Ok(options)
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

fn default_node_with_npm(bundled: PathBuf, npm_node: Option<OsString>) -> PathBuf {
    if bundled.is_file() {
        bundled
    } else {
        npm_node.map(PathBuf::from).unwrap_or(bundled)
    }
}

#[cfg(target_os = "macos")]
fn macos_default_node(
    desktop_root: Option<&Path>,
    bundled: PathBuf,
    npm_node: Option<OsString>,
) -> PathBuf {
    // Native tools authenticate the peer, parent and grandparent, including the Host.
    let desktop_node = desktop_root
        .map(|root| root.join("Contents/Resources/cua_node/bin/node"))
        .filter(|node| node.is_file());
    if let Some(desktop_node) = desktop_node {
        desktop_node
    } else {
        default_node_with_npm(bundled, npm_node)
    }
}

fn select_host_node(
    explicit: Option<PathBuf>,
    desktop_root: Option<&Path>,
    bundled: PathBuf,
) -> PathBuf {
    #[cfg(target_os = "macos")]
    let bundled = macos_default_node(desktop_root, bundled, env::var_os(NPM_NODE_PATH_ENV));
    #[cfg(not(target_os = "macos"))]
    let bundled = {
        let _ = desktop_root;
        default_node_with_npm(bundled, env::var_os(NPM_NODE_PATH_ENV))
    };
    explicit.unwrap_or(bundled)
}

impl LaunchOptions {
    fn resolve(self, desktop_root: Option<&Path>) -> Result<ResolvedLaunchOptions, Box<dyn Error>> {
        let installed = InstalledResources::from_current_executable()?;
        let default_node = select_host_node(None, desktop_root, installed.node);
        Ok(ResolvedLaunchOptions {
            shim: resolve_resource_path(self.shim, &installed.shim, "--shim", "bundled Shim")?,
            node: resolve_resource_path(
                self.node,
                &default_node,
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
        .env_remove("CODEXHOST_CONTROLLER_LIFECYCLE")
        // Keep proxy support without surfacing its experimental API notice.
        .arg("--disable-warning=UNDICI-EHPA")
        .arg(node_entrypoint_path(&options.desktop_controller))
        .arg("--renderer-cdp-endpoint")
        .arg(&control.renderer_cdp_endpoint)
        .arg("--renderer")
        .arg(&options.renderer_extension)
        .arg("--attachment-port")
        .arg(control.attachment_port.to_string())
        .arg("--attachment-nonce")
        .arg(&control.nonce);
    for (name, value) in environment {
        if matches!(
            name.to_str(),
            Some(
                "CODEXHOST_STARTUP_TRACE"
                    | "CODEXHOST_DATA_DIR"
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
    mut stopping: impl FnMut() -> Result<bool, Box<dyn Error>>,
) -> Result<bool, Box<dyn Error>> {
    let stdout = controller
        .take_stdout()
        .ok_or("Desktop Controller stdout is unavailable")?;
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        let _ = sender.send(read_bounded_controller_line(stdout));
    });
    let deadline = Instant::now() + timeout;
    loop {
        if stopping()? {
            return Ok(false);
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        match receiver.recv_timeout(remaining.min(Duration::from_millis(100))) {
            Ok(line) => {
                return parse_controller_readiness_line(&line?)
                    .map(|_| true)
                    .map_err(|error| {
                        format!("Desktop Controller returned invalid readiness: {error}").into()
                    });
            }
            Err(mpsc::RecvTimeoutError::Timeout) if !remaining.is_zero() => continue,
            Err(_) => return Err("Desktop Controller did not become ready before timeout".into()),
        }
    }
}

#[cfg(target_os = "windows")]
fn start_desktop_controller(
    options: &ResolvedLaunchOptions,
    control: &RuntimeControl,
    environment: &[(OsString, OsString)],
) -> Result<SupervisedChild, Box<dyn Error>> {
    startup_trace("spawning Desktop Controller");
    await_spawned_controller(spawn_supervised(&mut desktop_controller_command(
        options,
        control,
        environment,
    ))?)
}

#[cfg(target_os = "windows")]
fn await_spawned_controller(
    mut controller: SupervisedChild,
) -> Result<SupervisedChild, Box<dyn Error>> {
    startup_trace("waiting for Desktop Controller readiness");
    match wait_for_controller_ready(&mut controller, Duration::from_secs(120), || Ok(false)) {
        Ok(_) => {
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
    let controller_result = stop_desktop_controller(controller);
    desktop.shutdown(Duration::from_secs(2))?;
    controller_result?;
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
    #[cfg(unix)]
    controller.wait_for_tree_exit(Duration::from_secs(3))?;
    #[cfg(not(unix))]
    let _ = controller.wait()?;
    controller.disarm_cleanup();
    startup_trace("Desktop Controller force-stopped");
    Ok(())
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn supervise_desktop(
    installation: &DesktopInstallation,
    options: &ResolvedLaunchOptions,
    environment: &[(OsString, OsString)],
    control: &RuntimeControl,
    descriptor_path: &Path,
    operation: std::fs::File,
    data: &Path,
) -> Result<(), Box<dyn Error>> {
    startup_trace("launching Codex Desktop");
    let desktop_arguments =
        desktop_path_overrides::launch_arguments(&control.renderer_cdp_arguments, environment);
    let mut desktop = launch_desktop_session(
        installation,
        &options.shim,
        if cfg!(target_os = "macos") {
            DesktopLaunchMode::LaunchServices
        } else {
            DesktopLaunchMode::DirectExecutable
        },
        &desktop_arguments,
        environment,
        Duration::from_secs(30),
    )?;
    startup_trace("Codex Desktop launched");
    startup_trace("spawning Desktop Controller");
    let mut command = desktop_controller_command(options, control, environment);
    command
        .env("CODEXHOST_CONTROLLER_LIFECYCLE", "1")
        .stdin(Stdio::piped());
    let mut controller = spawn_supervised(&mut command)?;
    let descriptor = runtime_instance::RuntimeDescriptor::new(
        std::process::id(),
        control.attachment_port,
        control.nonce.clone(),
    )?;
    let snapshot = codexhost_platform::process_snapshot(controller.id())?;
    let published = Lifecycle::open(descriptor_path, true)?.record_start(
        descriptor.clone(),
        data,
        desktop.root_snapshot(),
        &snapshot,
    )?;
    drop(operation);
    published.bootstrap(
        controller
            .take_stdin()
            .ok_or("Desktop Controller lifecycle pipe is unavailable")?,
    )?;
    let stopping = || published.stopping();
    startup_trace("waiting for Desktop Controller readiness");
    let controller_ready =
        wait_for_controller_ready(&mut controller, Duration::from_secs(120), stopping);
    if stopping()? {
        return stop_managed_desktop_for_update(&mut desktop, &mut controller);
    }
    controller_ready?;
    startup_trace("Desktop Controller ready");
    let desktop_pid = desktop.root_snapshot().id;
    startup_trace("waiting for Host chain");
    let host_ready = wait_for_host_chain(
        desktop.root_snapshot(),
        options,
        Duration::from_secs(60),
        stopping,
    );
    if stopping()? {
        return stop_managed_desktop_for_update(&mut desktop, &mut controller);
    }
    if !host_ready? {
        let _ = stop_desktop_controller(&mut controller);
        let _ = desktop.shutdown(Duration::from_secs(2));
        return Err("Codex Desktop did not start the codexhost Host chain before timeout".into());
    }
    startup_trace("Host chain ready");
    runtime_instance::write_descriptor(descriptor_path, &descriptor)?;
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
        if stopping()? || should_stop_desktop_for_update(helper_started) {
            return stop_managed_desktop_for_update(&mut desktop, &mut controller);
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
    windows_direct: bool,
) -> Result<(), Box<dyn Error>> {
    let mode = if windows_direct {
        startup_trace("launching Codex Desktop via --windows-direct");
        DesktopLaunchMode::WindowsDirect
    } else {
        startup_trace("launching Codex Desktop");
        DesktopLaunchMode::DirectExecutable
    };
    let desktop_arguments =
        desktop_path_overrides::launch_arguments(desktop_arguments, environment);
    let mut desktop = launch_desktop(
        installation,
        &options.shim,
        mode,
        &desktop_arguments,
        environment,
    )?;
    startup_trace("Codex Desktop launched");
    let desktop_pid = desktop.id();
    if let Err(error) =
        wait_for_launched_desktop_ownership(installation, &mut desktop, Duration::from_secs(15))
    {
        if windows_direct {
            // Only direct spawn proves ownership of the handle on inspection failure.
            let _ = desktop.kill();
            let _ = desktop.wait();
        }
        return Err(error);
    }
    let desktop_snapshot = match codexhost_platform::process_snapshot(desktop_pid) {
        Ok(snapshot) => snapshot,
        Err(error) => {
            let _ = desktop.kill();
            let _ = desktop.wait();
            return Err(error.into());
        }
    };
    let mut controller = match start_desktop_controller(options, control, environment) {
        Ok(started) => started,
        Err(error) => {
            let _ = desktop.kill();
            let _ = desktop.wait();
            return Err(error);
        }
    };
    let retryable_appx = !windows_direct
        && matches!(
            installation.identity,
            DesktopIdentity::WindowsPackage {
                appx_activation: Some(_),
                ..
            }
        );
    startup_trace("waiting for Host chain");
    match wait_for_host_chain_outcome(
        &desktop_snapshot,
        options,
        Some(&installation.executable_codex_cli),
        Duration::from_secs(90),
        || Ok(false),
    ) {
        Ok(HostChainWaitOutcome::Ready) => {
            if let Err(error) = desktop.finish_packaged_activation() {
                eprintln!(
                    "codexhost launcher: could not remove temporary AppX environment after readiness: {error}"
                );
            }
        }
        result => {
            let _ = stop_desktop_controller(&mut controller);
            let _ = desktop.kill();
            let _ = desktop.wait();
            return match result {
                Err(error) => Err(error),
                Ok(HostChainWaitOutcome::DesktopExited) => {
                    let message =
                        "Codex Desktop exited before starting the codexhost Host chain".to_owned();
                    if retryable_appx {
                        Err(Box::new(TransientAppxStartupError(message)))
                    } else {
                        Err(message.into())
                    }
                }
                Ok(HostChainWaitOutcome::DirectStockCliWithoutShim) => {
                    let message = "Codex Desktop started the official Codex CLI without the codexhost Shim (AppX environment was not applied)".to_owned();
                    if retryable_appx {
                        Err(Box::new(TransientAppxStartupError(message)))
                    } else {
                        Err(message.into())
                    }
                }
                Ok(_) => Err(
                    "Codex Desktop did not start the codexhost Host chain before timeout".into(),
                ),
            };
        }
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
    let mut started_update_request = None;
    loop {
        if let Err(error) = start_pending_update(&mut started_update_request) {
            eprintln!("codexhost launcher: pending update could not be started: {error}");
        }
        if should_stop_desktop_for_update(started_update_request.is_some()) {
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
    // LaunchServices and AppX do not inherit the source launch version.
    // Runtime metadata readers validate it and use it only for source launches.
    if let Some(version) = env::var_os("CODEXHOST_DEV_VERSION") {
        environment.push((OsString::from("CODEXHOST_DEV_VERSION"), version));
    }
    environment.extend(npm_update_runtime_environment(env::vars_os()));
    if let Ok(value) = env::var("CODEXHOST_WEB_SERVICE")
        && matches!(value.as_str(), "0" | "1")
    {
        environment.push((
            OsString::from("CODEXHOST_WEB_SERVICE"),
            OsString::from(value),
        ));
    }
    environment.extend(desktop_path_overrides::forwarded(env::vars_os()));
    #[cfg(target_os = "linux")]
    environment.extend(linux_wayland_runtime_environment(env::vars_os()));
    #[cfg(target_os = "windows")]
    for name in ["PATH", "PATHEXT"] {
        if let Some(value) = env::var_os(name) {
            environment.push((OsString::from(name), value));
        }
    }
    environment
}

#[cfg(target_os = "linux")]
const LINUX_WAYLAND_FORWARD_ENV: [&str; 3] = [
    "WAYLAND_DISPLAY",
    "XDG_SESSION_TYPE",
    "CODEXHOST_DISABLE_WAYLAND",
];

#[cfg(target_os = "linux")]
fn linux_wayland_runtime_environment(
    variables: impl IntoIterator<Item = (OsString, OsString)>,
) -> Vec<(OsString, OsString)> {
    let variables = variables.into_iter().collect::<Vec<_>>();
    LINUX_WAYLAND_FORWARD_ENV
        .iter()
        .filter_map(|name| {
            variables.iter().find_map(|(candidate, value)| {
                (candidate == name && !value.is_empty())
                    .then(|| (OsString::from(*name), value.clone()))
            })
        })
        .collect()
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

fn launch(options: LaunchOptions) -> Result<(), Box<dyn Error>> {
    autostart::refresh();
    start_launch_console(&options);
    #[cfg(target_os = "windows")]
    let installation = if options.windows_direct {
        codexhost_platform::discover_registered_codex_desktop().map_err(Into::into)
    } else {
        discover_desktop(options.custom_install_root.as_deref())
    };
    #[cfg(not(target_os = "windows"))]
    let installation = discover_desktop(options.custom_install_root.as_deref());
    launch_official_desktop(options, installation, false)
}

fn launch_official_desktop(
    options: LaunchOptions,
    installation: Result<DesktopInstallation, Box<dyn Error>>,
    interactive: bool,
) -> Result<(), Box<dyn Error>> {
    if options.update_recovery {
        services::prepare_host_for_update(
            &options,
            installation
                .as_ref()
                .ok()
                .map(|desktop| desktop.install_root.as_path()),
        )?;
    }
    if !options.windows_direct
        && services::web_enabled()
        && installation.as_ref().is_err_and(|error| {
            matches!(
                error.downcast_ref::<codexhost_platform::PlatformError>(),
                Some(codexhost_platform::PlatformError::NotFound(_))
            )
        })
    {
        println!("Codex Desktop is not installed; opening Web instead");
        let open_browser = console::presentation() != Some(console::Presentation::Print);
        match services::open_for_launch(&options, open_browser) {
            Ok(()) => {
                startup_record::finish(StartupOutcome::Ready, None);
                console::show_for_launch(None);
                emit_ready_line(&mut std::io::stdout())?;
                return Ok(());
            }
            Err(error) => {
                eprintln!("Web startup failed: {error}");
                return launch_gui(options, installation, interactive);
            }
        }
    }
    if services::web_enabled() {
        services::start_for_launch(
            &options,
            installation
                .as_ref()
                .ok()
                .map(|desktop| desktop.install_root.as_path()),
        );
    }
    let result = launch_gui(options, installation, interactive);
    services::finish_launch(false);
    result
}

fn prepare_gui(
    options: LaunchOptions,
    installation: Result<DesktopInstallation, Box<dyn Error>>,
) -> Result<(ResolvedLaunchOptions, DesktopInstallation), Box<dyn Error>> {
    startup_trace("launch requested");
    // 优先报告安装资源缺失，避免 Desktop 探测错误遮住损坏的 Host 安装。
    let options = options.resolve(
        installation
            .as_ref()
            .ok()
            .map(|desktop| desktop.install_root.as_path()),
    )?;
    let installation = installation?;
    startup_trace("resources resolved");
    startup_record::desktop(
        &installation.version,
        &installation.build,
        &installation.install_root,
    );
    startup_trace("Codex Desktop installation discovered");
    Ok((options, installation))
}

type DesktopEnvironment = Vec<(OsString, OsString)>;

fn gui_controls(
    options: &ResolvedLaunchOptions,
    descriptor_path: &Path,
) -> Result<(RuntimeControl, DesktopEnvironment), Box<dyn Error>> {
    let control = allocate_runtime_control()?;
    let environment = desktop_environment(
        options,
        &control,
        &env::current_exe()?.canonicalize()?,
        descriptor_path,
        managed_desktop_data_directory(
            env::var_os(DATA_DIRECTORY_ENV),
            env::var_os(REMOTE_SSH_MANAGED_ENV),
        ),
    );
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    let environment = {
        let mut environment = environment;
        environment.extend(codexhost_platform::proxy_environment());
        environment
    };
    Ok((control, environment))
}

#[cfg(target_os = "windows")]
fn launch_gui(
    options: LaunchOptions,
    installation: Result<DesktopInstallation, Box<dyn Error>>,
    interactive: bool,
) -> Result<(), Box<dyn Error>> {
    let windows_direct = options.windows_direct;
    let (options, installation) = prepare_gui(options, installation)?;
    startup_trace("acquiring Launcher ownership");
    let _launcher_guard = if windows_direct {
        let guard_path = runtime_instance::guard_path(&default_descriptor_path()?);
        runtime_instance::try_acquire_launcher_guard(&guard_path)?
            .ok_or("a codexhost Desktop is starting or running; completely quit it before using --windows-direct")?
    } else {
        match acquire_launcher_ownership(&installation, Duration::from_secs(120))? {
            LauncherOwnership::Acquired(guard) => {
                startup_trace("Launcher ownership acquired");
                guard
            }
            LauncherOwnership::Attached => {
                startup_trace("attached to existing controlled Desktop");
                startup_record::finish(StartupOutcome::Attached, None);
                console::show_for_launch(None);
                return Ok(());
            }
        }
    };

    let mut appx_retries_remaining = 1_u8;
    loop {
        let descriptor_path = default_descriptor_path()?;
        let descriptor = if windows_direct {
            read_descriptor(&descriptor_path)?
        } else {
            read_descriptor(&descriptor_path).ok().flatten()
        };
        let descriptor_present = descriptor_path.exists();
        let control_endpoint_ready = descriptor.as_ref().is_some_and(|descriptor| {
            endpoint_ready(descriptor.control_port, Duration::from_millis(300))
        });
        let state = if windows_direct {
            // Never attach or terminate based on a descriptor in this mode. The
            // platform checks for Store Desktop processes just before spawn.
            StartupState::CleanLaunch
        } else {
            classify_startup(StartupObservation {
                desktop_running: !desktop_root_process_ids_for_installation(&installation)?
                    .is_empty(),
                descriptor_present,
                control_endpoint_ready,
            })
        };

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
                if interactive {
                    match prompt_running_desktop() {
                        RunningDesktopChoice::Restart => {
                            force_stop_external_desktop(&installation, Duration::from_secs(10))?;
                            continue;
                        }
                        RunningDesktopChoice::Retry => continue,
                        RunningDesktopChoice::Cancel => return Ok(()),
                    }
                }
                if let Some(descriptor) = &descriptor {
                    let _ = remove_matching_descriptor(&descriptor_path, descriptor);
                }
                force_stop_external_desktop(&installation, Duration::from_secs(10))?;
                continue;
            }
            StartupState::CleanLaunch => {
                if descriptor_present && control_endpoint_ready {
                    return Err(
                        "codexhost control endpoint is still active without a live Desktop; completely quit Codex Desktop and retry"
                            .into(),
                    );
                }
            }
        }

        let (control, environment) = gui_controls(&options, &descriptor_path)?;
        let result = supervise_desktop(
            &installation,
            &options,
            &control.renderer_cdp_arguments,
            &environment,
            &control,
            &descriptor_path,
            #[cfg(target_os = "windows")]
            windows_direct,
        );
        match result {
            Err(error)
                if !windows_direct
                    && interactive
                    && (error.downcast_ref::<UnmanagedDesktopConflict>().is_some()
                        || error.to_string() == UNMANAGED_DESKTOP_MESSAGE) =>
            {
                continue;
            }
            Err(error)
                if !windows_direct
                    && appx_retries_remaining > 0
                    && error.downcast_ref::<TransientAppxStartupError>().is_some() =>
            {
                appx_retries_remaining -= 1;
                startup_trace(&format!(
                    "retrying Codex Desktop AppX launch after transient startup failure: {error}"
                ));
                thread::sleep(Duration::from_secs(1));
                continue;
            }
            Ok(()) => {
                console::stop_for_launch();
                return Ok(());
            }
            Err(error) => return Err(error),
        }
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn launch_gui(
    options: LaunchOptions,
    installation: Result<DesktopInstallation, Box<dyn Error>>,
    _interactive_running_desktop: bool,
) -> Result<(), Box<dyn Error>> {
    let (options, installation) = prepare_gui(options, installation)?;
    let data = startup_record::data_directory().ok_or("User data directory is unavailable")?;
    service_update::ensure_start_allowed(&data)?;
    let (_launcher_guard, operation) =
        match acquire_launcher_ownership(&installation, Duration::from_secs(120), &data)? {
            LauncherOwnership::Acquired(guard, operation) => {
                startup_trace("Launcher ownership acquired");
                (guard, operation)
            }
            LauncherOwnership::Attached => {
                startup_trace("attached to existing controlled Desktop");
                startup_record::finish(StartupOutcome::Attached, None);
                console::show_for_launch(None);
                return Ok(());
            }
        };

    service_update::ensure_start_allowed(&data)?;
    let descriptor_path = default_descriptor_path()?;
    let recovered = Lifecycle::open(&descriptor_path, true)?.reconcile(
        &data,
        true,
        Instant::now() + Duration::from_secs(12),
    )?;
    if !desktop_root_process_ids_for_installation(&installation)?.is_empty() {
        #[cfg(target_os = "linux")]
        return Err(Box::new(UnmanagedDesktopConflict));
        #[cfg(target_os = "macos")]
        {
            if recovered {
                return Err(
                    "Desktop appeared during orphan recovery; no replacement was attempted".into(),
                );
            }
            codexhost_platform::force_stop_desktop(&installation, Duration::from_secs(10))?;
        }
    }
    #[cfg(target_os = "linux")]
    let _ = recovered;
    service_update::ensure_start_allowed(&data)?;
    let (control, environment) = gui_controls(&options, &descriptor_path)?;
    let result = supervise_desktop(
        &installation,
        &options,
        &environment,
        &control,
        &descriptor_path,
        operation,
        &data,
    );
    if result.is_ok() {
        console::stop_for_launch();
    }
    result
}

fn start_launch_console(options: &LaunchOptions) {
    // Recovery needs only Node and the console entrypoint, not a complete
    // Desktop resource set. Resolve those paths before validating the rest.
    if let Ok(installed) = InstalledResources::from_current_executable() {
        #[cfg(target_os = "macos")]
        let default_node = macos_default_node(None, installed.node, env::var_os(NPM_NODE_PATH_ENV));
        #[cfg(not(target_os = "macos"))]
        let default_node = default_node_with_npm(installed.node, env::var_os(NPM_NODE_PATH_ENV));
        console::start_for_launch(console::console_command_for(
            options.node.as_deref().unwrap_or(&default_node),
            options
                .host_runtime
                .as_deref()
                .unwrap_or(&installed.host_runtime),
            &installed.console_server,
        ));
    }
}

fn run_console_command(action: &str) -> Result<(), Box<dyn Error>> {
    let installed = InstalledResources::from_current_executable()?;
    if !installed.console_server.is_file() {
        return Err(format!(
            "bundled console is missing: {}",
            installed.console_server.display()
        )
        .into());
    }
    let command = console::ConsoleCommand {
        node: default_node_with_npm(installed.node, env::var_os(NPM_NODE_PATH_ENV)),
        console_server: installed.console_server,
    };
    if console::run(&command, action)? {
        Ok(())
    } else {
        Err(format!("codexhost {action} failed").into())
    }
}

fn launch_presentation(arguments: &[String], terminal: bool) -> console::Presentation {
    match arguments.first().map(String::as_str) {
        Some("launch") => console::Presentation::Print,
        None | Some("app") if terminal => console::Presentation::Print,
        _ => console::Presentation::Browser,
    }
}

fn is_launch_command(arguments: &[String]) -> bool {
    matches!(
        arguments.first().map(String::as_str),
        None | Some(START_MENU_ARGUMENT | "launch" | "app")
    )
}

fn default_launch_options() -> LaunchOptions {
    LaunchOptions {
        update_recovery: false,
        windows_direct: false,
        shim: None,
        node: None,
        host_runtime: None,
        web_runtime: None,
        desktop_controller: None,
        renderer_extension: None,
        pi: None,
        custom_install_root: None,
    }
}

#[derive(Debug, PartialEq, Eq)]
enum DesktopRoute {
    CodexDesktop,
    App,
    Onboarding,
    RememberNative,
    CodexUnavailable,
}

fn desktop_route(
    preferences: Option<Preferences>,
    codex_installed: bool,
    shell_available: bool,
) -> DesktopRoute {
    if shell_available {
        return DesktopRoute::Onboarding;
    }
    match preferences.filter(|prefs| prefs.onboarding_completed) {
        Some(prefs) => match prefs.default_desktop_surface {
            Surface::NativeShell => DesktopRoute::App,
            Surface::CodexDesktop if codex_installed => DesktopRoute::CodexDesktop,
            Surface::CodexDesktop => DesktopRoute::CodexUnavailable,
        },
        None if !codex_installed => DesktopRoute::RememberNative,
        None => DesktopRoute::CodexDesktop,
    }
}

fn launch_app(shell: Option<&Path>, onboarding: bool) -> Result<(), Box<dyn Error>> {
    services::open_app(shell, onboarding)?;
    startup_record::finish(StartupOutcome::Ready, None);
    console::show_for_launch(None);
    Ok(())
}

fn launch_default(interactive: bool) -> Result<(), Box<dyn Error>> {
    if !services::graphical_session() {
        services::run("web", &[])?;
        startup_record::finish(StartupOutcome::Ready, None);
        return Ok(());
    }
    let options = default_launch_options();
    autostart::refresh();
    start_launch_console(&options);
    let data = startup_record::data_directory().ok_or("User data directory is unavailable")?;
    let preferences = Preferences::read(&data)?;
    let installation = discover_desktop(None);
    let installed = InstalledResources::from_current_executable()?;
    let shell = installed.desktop_shell.as_deref();
    match desktop_route(preferences, installation.is_ok(), shell.is_some()) {
        DesktopRoute::CodexDesktop => launch_official_desktop(options, installation, interactive),
        DesktopRoute::App => launch_app(shell, false),
        DesktopRoute::Onboarding => launch_app(shell, true),
        DesktopRoute::RememberNative => {
            Preferences::new(Surface::NativeShell, true).save(&data)?;
            if shell.is_none() {
                eprintln!("Codex Desktop is not installed; opening Web instead");
            }
            launch_app(shell, false)
        }
        DesktopRoute::CodexUnavailable => {
            let fallback = if shell.is_some() {
                "the codexhost desktop shell"
            } else {
                "Web"
            };
            eprintln!("Your default Codex Desktop could not be found; opening {fallback} instead");
            launch_app(shell, false)
        }
    }
}

fn run(arguments: &[String]) -> Result<(), Box<dyn Error>> {
    match arguments.first().map(String::as_str) {
        #[cfg(target_os = "windows")]
        Some(APPX_RESUME_ARGUMENT) => {
            resume_packaged_application(&arguments[1..]).map_err(Into::into)
        }
        None => launch_default(false),
        Some("--help" | "-h" | "help") => {
            println!("{USAGE}");
            Ok(())
        }
        // Matches the npm wrapper, which prints its plain package version.
        Some("--version" | "-V" | "-v") if arguments.len() == 1 => {
            println!("{}", env!("CARGO_PKG_VERSION"));
            Ok(())
        }
        Some(START_MENU_ARGUMENT) if arguments.len() == 1 => launch_default(true),
        Some("launch-prefs") => launch_preferences::run(&arguments[1..]),
        Some("app") => {
            let onboarding = match &arguments[1..] {
                [] => false,
                [flag] if flag == "--onboarding" => true,
                _ => return Err("usage: codexhost app [--onboarding]".into()),
            };
            autostart::refresh();
            start_launch_console(&default_launch_options());
            let installed = InstalledResources::from_current_executable()?;
            launch_app(installed.desktop_shell.as_deref(), onboarding)
        }
        Some("inspect") => {
            let options = parse_inspect_options(&arguments[1..])?;
            let custom_install_root = options
                .custom_install_root
                .map(|path| absolute_directory(&path, "--custom-install"))
                .transpose()?;
            inspect(custom_install_root.as_deref(), options.json)
        }
        Some(action @ ("web" | "stop" | "status" | "stop-for-update")) => {
            services::run(action, &arguments[1..])
        }
        Some("autostart") => autostart::run(&arguments[1..]),
        Some("console") if arguments.len() == 1 => run_console_command("open"),
        Some("update") if arguments.len() == 1 => run_console_command("update"),
        Some("update") => Err("update accepts no arguments".into()),
        Some("console") => Err("console accepts no arguments".into()),
        Some("launch") => launch(parse_launch_options(&arguments[1..])?),
        Some("open-file") if arguments.len() == 2 => {
            let path = PathBuf::from(&arguments[1]).canonicalize()?;
            if !path.is_file() {
                return Err("native file opener requires a regular file".into());
            }
            let path = path.to_str().ok_or("file path must be valid UTF-8")?;
            codexhost_platform::open_external_url(path).map_err(Into::into)
        }
        Some("open-file") => Err("open-file requires one file path".into()),
        Some("reveal-file") if arguments.len() == 2 => {
            let path = Path::new(&arguments[1]);
            if !path.is_absolute() {
                return Err("reveal-file requires an absolute path".into());
            }
            let info = path.metadata()?;
            if !info.is_file() && !info.is_dir() {
                return Err("reveal-file requires a regular file or directory".into());
            }
            codexhost_platform::reveal_file(path).map_err(Into::into)
        }
        Some("reveal-file") => Err("reveal-file requires one path".into()),
        Some("open-loopback-url") if arguments.len() == 1 => {
            let url = read_bounded_loopback_url(std::io::stdin().lock())?;
            validate_loopback_root_url(&url)?;
            codexhost_platform::open_external_url(&url).map_err(Into::into)
        }
        Some("open-loopback-url") => Err("open-loopback-url accepts no arguments".into()),
        Some("desktop-screenshot") if arguments.len() == 1 => {
            let image = codexhost_platform::capture_primary_desktop()?;
            std::io::stdout().lock().write_all(&image)?;
            Ok(())
        }
        Some("desktop-screenshot") => Err("desktop-screenshot accepts no arguments".into()),
        Some("host") if arguments.get(1).is_some_and(|arg| arg == "info") => {
            run_delegation_cli(arguments)
        }
        Some("host") => host_service::run(&arguments[1..]),
        Some("web-service") => web_service::run(&arguments[1..]),
        Some("proxy-environment") if arguments.len() == 1 => {
            system_proxy_environment::print_proxy_environment()
        }
        Some("proxy-environment") => Err("proxy-environment accepts no arguments".into()),
        Some("broker") => run_native_harness_broker_cli(&arguments[1..]),
        Some("project") | Some("harness") | Some("delegate") | Some("thread") | Some("client")
        | Some("events") => run_delegation_cli(arguments),
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
    let launching = is_launch_command(&arguments);
    if launching {
        startup_record::begin();
        let headless_app = arguments.first().is_some_and(|argument| argument == "app")
            && !services::graphical_session();
        console::set_presentation(launch_presentation(
            &arguments,
            std::io::stdin().is_terminal()
                || std::io::stdout().is_terminal()
                || std::io::stderr().is_terminal()
                || env::var_os("SSH_CONNECTION").is_some()
                || env::var_os("SSH_TTY").is_some()
                || headless_app,
        ));
    }
    match run(&arguments) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            let message = format!("codexhost launcher: {error}");
            eprintln!("{message}");
            let console_opened = launching && {
                startup_record::finish(StartupOutcome::Failed, Some(&error.to_string()));
                console::show_for_launch(Some("startup-failure"))
            };
            #[cfg(target_os = "windows")]
            if start_menu_launch && !console_opened {
                show_error_dialog(&message);
            }
            #[cfg(not(target_os = "windows"))]
            let _ = console_opened;
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    #[cfg(target_os = "windows")]
    use std::ffi::OsStr;
    use std::ffi::OsString;
    use std::path::{Path, PathBuf};
    use std::process::Command;
    #[cfg(target_os = "macos")]
    use std::process::Stdio;
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
    #[cfg(target_os = "linux")]
    use super::linux_wayland_runtime_environment;
    #[cfg(target_os = "windows")]
    use super::stop_desktop_controller;
    #[cfg(target_os = "macos")]
    use super::wait_for_controller_ready;
    #[cfg(target_os = "windows")]
    use super::wait_for_desktop_exit;
    use super::{
        CONTROL_NONCE_ENV, CONTROL_PORT_ENV, HOST_NODE_PATH_ENV, LAUNCHER_EXECUTABLE_ENV,
        LAUNCHER_PID_ENV, NPM_CLI_PATH_ENV, NPM_LAUNCHER_PATH_ENV, NPM_NODE_PATH_ENV,
        NPM_PACKAGE_ROOT_ENV, RUNTIME_DESCRIPTOR_PATH_ENV, ResolvedLaunchOptions, RuntimeControl,
        STARTUP_TRACE_ENV, absolute_directory, allocate_runtime_control, delegation_node,
        desktop_controller_command, desktop_environment, emit_ready_line,
        managed_desktop_data_directory, npm_update_runtime_environment, parse_inspect_options,
        parse_launch_options, read_bounded_controller_line, read_bounded_loopback_url,
        validate_loopback_root_url,
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
    fn native_url_handoff_accepts_only_loopback_roots() {
        let token = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
        for accepted in [
            format!("http://127.0.0.1:43123/?token={token}"),
            format!("https://localhost:43123/?token={token}"),
            format!("http://[::1]:43123/?token={token}"),
            "http://127.0.0.1:43123/".into(),
            "http://127.0.0.1:43123/?service=local".into(),
        ] {
            assert!(validate_loopback_root_url(&accepted).is_ok(), "{accepted}");
        }
        for rejected in [
            format!("https://example.com:43123/?token={token}"),
            format!("http://user@127.0.0.1:43123/?token={token}"),
            format!("http://127.0.0.1:43123/path?token={token}"),
            format!("http://127.0.0.1/?token={token}"),
            format!("file:///tmp/page?token={token}"),
            format!("http://127.0.0.1:43123/?token={token}#fragment"),
            format!("http://user%40name@127.0.0.1:43123/?token={token}"),
            format!("http://127%2e0%2e0%2e1:43123/?token={token}"),
        ] {
            assert!(validate_loopback_root_url(&rejected).is_err(), "{rejected}");
        }
    }

    #[test]
    fn native_url_handoff_bounds_stdin() {
        assert_eq!(
            read_bounded_loopback_url(std::io::Cursor::new(b"http://127.0.0.1:43123/"))
                .expect("bounded URL"),
            "http://127.0.0.1:43123/"
        );
        assert!(read_bounded_loopback_url(std::io::Cursor::new(vec![b'a'; 4097])).is_err());
        assert!(read_bounded_loopback_url(std::io::Cursor::new(b"one\ntwo")).is_err());
    }

    #[test]
    fn launch_presentation_keeps_terminal_and_installer_entrypoints_distinct() {
        use super::console::Presentation::{Browser, Print};
        assert_eq!(super::launch_presentation(&[], false), Browser);
        assert_eq!(super::launch_presentation(&[], true), Print);
        assert_eq!(super::launch_presentation(&["launch".into()], false), Print);
        assert_eq!(super::launch_presentation(&["app".into()], false), Browser);
        assert_eq!(super::launch_presentation(&["app".into()], true), Print);
        assert_eq!(
            super::launch_presentation(&[super::START_MENU_ARGUMENT.into()], true),
            Browser
        );
    }

    #[test]
    fn default_desktop_routes_follow_preferences_and_available_entrypoints() {
        use super::DesktopRoute::*;
        use super::{Preferences, Surface, desktop_route};

        let native = Some(Preferences::new(Surface::NativeShell, true));
        let codex = Some(Preferences::new(Surface::CodexDesktop, true));
        let incomplete = Some(Preferences::new(Surface::CodexDesktop, false));
        for (prefs, installed, shell, expected) in [
            (None, false, true, Onboarding),
            (None, false, false, RememberNative),
            (None, true, true, Onboarding),
            (None, true, false, CodexDesktop),
            (incomplete, false, true, Onboarding),
            (incomplete, true, true, Onboarding),
            (native, true, true, Onboarding),
            (native, true, false, App),
            (codex, true, true, Onboarding),
            (codex, true, false, CodexDesktop),
            (codex, false, true, Onboarding),
            (codex, false, false, CodexUnavailable),
        ] {
            assert_eq!(desktop_route(prefs, installed, shell), expected);
        }
    }

    #[test]
    fn app_is_a_launch_command_but_launch_preferences_is_not() {
        assert!(super::is_launch_command(&[
            "app".into(),
            "--onboarding".into()
        ]));
        assert!(!super::is_launch_command(&[
            "launch-prefs".into(),
            "get".into(),
            "--json".into()
        ]));
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

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_host_uses_the_selected_desktop_node_and_preserves_explicit_overrides() {
        let executable = std::env::current_exe().unwrap().canonicalize().unwrap();
        let root =
            std::env::temp_dir().join(format!("codexhost-signed-node-{}", std::process::id()));
        let desktop_node = root.join("Contents/Resources/cua_node/bin/node");
        std::fs::create_dir_all(desktop_node.parent().unwrap()).unwrap();
        std::fs::write(&desktop_node, b"Desktop Node fixture").unwrap();

        for node in [None, Some(executable.clone())] {
            let expected = node.clone().unwrap_or_else(|| desktop_node.clone());
            let options = super::LaunchOptions {
                update_recovery: false,
                windows_direct: false,
                shim: Some(executable.clone()),
                node,
                host_runtime: Some(executable.clone()),
                web_runtime: None,
                desktop_controller: Some(executable.clone()),
                renderer_extension: Some(executable.clone()),
                pi: None,
                custom_install_root: None,
            };
            let resolved = options.resolve(Some(&root)).unwrap();
            assert_eq!(resolved.node, expected.canonicalize().unwrap());
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_node_fallback_preserves_bundled_and_npm_runtimes() {
        let executable = std::env::current_exe().unwrap().canonicalize().unwrap();
        let missing = executable.with_file_name("missing-desktop-node");
        assert_eq!(
            super::macos_default_node(
                Some(&missing),
                executable.clone(),
                Some(missing.clone().into())
            ),
            executable
        );
        assert_eq!(
            super::macos_default_node(
                Some(&missing),
                missing.clone(),
                Some(executable.clone().into())
            ),
            executable
        );
        assert_eq!(
            super::macos_default_node(Some(&missing), missing.clone(), None),
            missing
        );
    }

    #[test]
    fn windows_direct_is_opt_in_and_cannot_choose_a_portable_installation() {
        assert!(!parse_launch_options(&[]).unwrap().windows_direct);
        let direct = parse_launch_options(&["--windows-direct".into()]);
        if cfg!(target_os = "windows") {
            assert!(direct.unwrap().windows_direct);
        } else {
            assert_eq!(
                direct.unwrap_err(),
                "--windows-direct is supported on Windows only"
            );
        }
        let mixed = parse_launch_options(&[
            "--custom-install".into(),
            "portable".into(),
            "--windows-direct".into(),
        ]);
        assert_eq!(
            mixed.unwrap_err(),
            "--windows-direct cannot be combined with --custom-install"
        );
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
                .custom_install_root
                .as_deref(),
            Some(Path::new("/opt/CodexPortable"))
        );
        assert_eq!(
            parse_inspect_options(&[]).expect("bare inspect"),
            super::InspectOptions::default()
        );
        assert!(
            parse_inspect_options(&["--json".into()])
                .expect("inspect accepts --json")
                .json
        );
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
        }
    }

    fn runtime_control() -> RuntimeControl {
        RuntimeControl {
            renderer_cdp_endpoint: "http://127.0.0.1:43123".into(),
            renderer_cdp_arguments: [
                "--remote-debugging-address=127.0.0.1".into(),
                "--remote-debugging-port=43123".into(),
            ],
            attachment_port: 43124,
            nonce: "0123456789abcdef0123456789abcdef".into(),
        }
    }

    #[test]
    fn production_controller_uses_private_node_and_loopback_renderer_cdp() {
        let options = resolved_options();
        let command = desktop_controller_command(&options, &runtime_control(), &[]);
        assert_eq!(command.get_program(), "/opt/node");
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            [
                "--disable-warning=UNDICI-EHPA",
                "/opt/desktop-controller.mjs",
                "--renderer-cdp-endpoint",
                "http://127.0.0.1:43123",
                "--renderer",
                "/opt/renderer-extension.js",
                "--attachment-port",
                "43124",
                "--attachment-nonce",
                "0123456789abcdef0123456789abcdef",
            ]
        );

        let control = allocate_runtime_control().expect("ephemeral runtime control");
        assert!(
            control
                .renderer_cdp_endpoint
                .starts_with("http://127.0.0.1:")
        );
        let renderer_cdp_port = control
            .renderer_cdp_endpoint
            .rsplit(':')
            .next()
            .expect("Renderer CDP endpoint port")
            .parse::<u16>()
            .expect("numeric Renderer CDP endpoint port");
        assert_ne!(renderer_cdp_port, control.attachment_port);
        assert_eq!(
            control.renderer_cdp_arguments[0].to_string_lossy(),
            "--remote-debugging-address=127.0.0.1"
        );
        assert_eq!(
            control.renderer_cdp_arguments[1].to_string_lossy(),
            format!("--remote-debugging-port={renderer_cdp_port}")
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
    fn delegation_node_falls_back_to_the_host_node_only_without_a_bundled_node() {
        let bundled = std::env::current_exe().expect("resolve test executable");
        let missing = bundled.with_file_name("missing-bundled-node");
        let host_node = missing.with_file_name("host-node");

        assert_eq!(
            delegation_node(&bundled, Some(host_node.clone().into_os_string())),
            Ok(bundled.clone())
        );
        assert_eq!(
            delegation_node(&missing, Some(host_node.clone().into_os_string())),
            Ok(host_node)
        );
        assert_eq!(
            delegation_node(Path::new("node"), None),
            Ok(PathBuf::from("node"))
        );
        let error = delegation_node(&missing, Some(OsString::from("node")))
            .expect_err("a relative Host Node is rejected");
        assert!(error.contains("CODEXHOST_CLI_NODE_PATH"), "{error}");
        assert!(delegation_node(&missing, None).is_err());
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

    #[cfg(target_os = "windows")]
    #[test]
    fn desktop_environment_forwards_windows_command_search_variables() {
        let environment = desktop_environment(
            &resolved_options(),
            &runtime_control(),
            Path::new(r"C:\\codexhost.exe"),
            Path::new(r"C:\\runtime\\desktop-runtime-v1.json"),
            None,
        );

        for name in ["PATH", "PATHEXT"] {
            assert_eq!(
                environment
                    .iter()
                    .find(|(candidate, _)| candidate == name)
                    .map(|(_, value)| value),
                std::env::var_os(name).as_ref(),
                "{name} must reach the AppX-launched Host Runtime"
            );
        }
    }

    #[test]
    fn desktop_environment_preserves_explicit_native_home_and_profile() {
        const MARKER: &str = "CODEXHOST_TEST_DESKTOP_PATH_OVERRIDES";
        if std::env::var_os(MARKER).is_none() {
            let root = std::env::temp_dir().join("codexhost-desktop-path-fixture");
            let output = Command::new(std::env::current_exe().expect("test executable"))
                .args([
                    "--exact",
                    "tests::desktop_environment_preserves_explicit_native_home_and_profile",
                    "--nocapture",
                ])
                .env(MARKER, "1")
                .env("HOME", root.join("home"))
                .env("ZDOTDIR", root.join("shell"))
                .env("CODEX_HOME", root.join("codex"))
                .env("CODEX_ELECTRON_USER_DATA_PATH", root.join("electron"))
                .env("CODEXHOST_DEV_VERSION", "0.12.0")
                .env("OPENAI_API_KEY", "synthetic-not-forwarded")
                .env_remove(super::REMOTE_SSH_MANAGED_ENV)
                .output()
                .expect("run isolated environment test");
            assert!(
                output.status.success(),
                "{}{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr),
            );
            return;
        }
        let environment = desktop_environment(
            &resolved_options(),
            &runtime_control(),
            Path::new("/synthetic/codexhost"),
            Path::new("/synthetic/runtime.json"),
            None,
        );
        for name in [
            "HOME",
            "ZDOTDIR",
            "CODEX_HOME",
            "CODEX_ELECTRON_USER_DATA_PATH",
            "CODEXHOST_DEV_VERSION",
        ] {
            assert!(
                environment.contains(&(
                    OsString::from(name),
                    std::env::var_os(name).expect("synthetic path override"),
                )),
                "missing Desktop environment {name}"
            );
        }
        assert!(!environment.iter().any(|(name, _)| name == "OPENAI_API_KEY"));
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn linux_wayland_runtime_environment_filters_active_wayland_variables() {
        let variables = [
            (
                OsString::from("WAYLAND_DISPLAY"),
                OsString::from("wayland-0"),
            ),
            (
                OsString::from("XDG_SESSION_TYPE"),
                OsString::from("wayland"),
            ),
            (
                OsString::from("CODEXHOST_DISABLE_WAYLAND"),
                OsString::from(""),
            ),
            (OsString::from("DISPLAY"), OsString::from(":0")),
            (OsString::from("SOME_SECRET"), OsString::from("secret")),
        ];
        let forwarded = linux_wayland_runtime_environment(variables);
        assert_eq!(
            forwarded,
            [
                (
                    OsString::from("WAYLAND_DISPLAY"),
                    OsString::from("wayland-0"),
                ),
                (
                    OsString::from("XDG_SESSION_TYPE"),
                    OsString::from("wayland"),
                ),
            ]
        );
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

    #[cfg(target_os = "windows")]
    #[test]
    fn production_controller_normalizes_a_verbatim_node_entrypoint() {
        let options = ResolvedLaunchOptions {
            desktop_controller: PathBuf::from(r"\\?\C:\Program Files\codexhost\controller.mjs"),
            ..resolved_options()
        };
        let command = desktop_controller_command(&options, &runtime_control(), &[]);

        assert_eq!(
            command.get_args().nth(1),
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
        wait_for_controller_ready(&mut controller, Duration::from_secs(2), || Ok(false))
            .expect("Controller ready");
        controller.wait().expect("wait fake Controller");
        controller.disarm_cleanup();
    }
}
