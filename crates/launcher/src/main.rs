#![forbid(unsafe_code)]

mod desktop_attachment;
mod installation_layout;
mod runtime_instance;

use std::env;
use std::error::Error;
use std::ffi::OsString;
use std::fmt::{self, Display, Formatter};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
#[cfg(not(target_os = "macos"))]
use std::process::{Child, ExitStatus};
use std::process::{Command, ExitCode, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;
#[cfg(not(target_os = "macos"))]
use std::time::Instant;

#[cfg(not(target_os = "macos"))]
use codexhost_platform::launch_desktop;
#[cfg(target_os = "macos")]
use codexhost_platform::launch_desktop_session;
use codexhost_platform::{
    DesktopIdentity, DesktopInstallation, DesktopLaunchMode, SupervisedChild,
    canonical_existing_file, configure_background_command, desktop_process_ids,
    desktop_root_process_ids, discover_codex_desktop, node_entrypoint_path, spawn_supervised,
};
#[cfg(target_os = "windows")]
use codexhost_platform::{
    RunningDesktopChoice, hide_console_window, process_executable_path, process_exists,
    prompt_running_desktop, show_error_dialog, terminate_process_by_id,
};
use desktop_attachment::{
    LauncherOwnership, RuntimeControl, acquire_launcher_ownership, allocate_runtime_control,
    endpoint_ready, publish_runtime_descriptor, stop_stale_launcher, wait_for_host_chain,
};
use installation_layout::InstalledResources;
use runtime_instance::{
    StartupObservation, StartupState, classify_startup, default_descriptor_path, read_descriptor,
    remove_matching_descriptor,
};

const HOST_NODE_PATH_ENV: &str = "CODEXHOST_HOST_NODE_PATH";
const HOST_RUNTIME_PATH_ENV: &str = "CODEXHOST_HOST_RUNTIME_PATH";
const PI_COMMAND_ENV: &str = "CODEXHOST_PI_COMMAND";
const DEFAULT_AGENT_ENV: &str = "CODEXHOST_DEFAULT_AGENT";
const START_MENU_ARGUMENT: &str = "--start-menu";
const UNMANAGED_DESKTOP_MESSAGE: &str = "Codex Desktop is already running outside codexhost; completely quit it before starting codexhost";

#[derive(Debug)]
struct UnmanagedDesktopConflict;

impl Display for UnmanagedDesktopConflict {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter.write_str(UNMANAGED_DESKTOP_MESSAGE)
    }
}

impl Error for UnmanagedDesktopConflict {}

fn usage() {
    eprintln!(
        "usage:\n  codexhost\n  codexhost inspect\n  codexhost launch --agent <codex|pi> [--shim <absolute-file>] [--node <absolute-file>] [--host-runtime <absolute-file>] [--desktop-controller <absolute-file>] [--renderer <absolute-file>] [--pi <absolute-file>]"
    );
}

fn print_installation(installation: &DesktopInstallation, process_ids: &[u32]) {
    match &installation.identity {
        DesktopIdentity::WindowsPackage {
            package_name,
            package_family_name,
        } => {
            println!("platform=windows");
            println!("package_name={package_name}");
            println!("package_family_name={package_family_name}");
        }
        DesktopIdentity::MacOsBundle { bundle_identifier } => {
            println!("platform=macos");
            println!("bundle_identifier={bundle_identifier}");
        }
    }
    println!("desktop_version={}", installation.version);
    println!("install_root={}", installation.install_root.display());
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

fn inspect() -> Result<(), Box<dyn Error>> {
    let installation = discover_codex_desktop()?;
    let process_ids = desktop_process_ids()?;
    print_installation(&installation, &process_ids);
    Ok(())
}

#[derive(Clone, Copy, Debug)]
enum Agent {
    Codex,
    Pi,
}

impl Agent {
    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "codex" => Ok(Self::Codex),
            "pi" => Ok(Self::Pi),
            _ => Err(format!("--agent must be 'codex' or 'pi', got '{value}'")),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Codex => "codex",
            Self::Pi => "pi",
        }
    }
}

#[derive(Debug)]
struct LaunchOptions {
    agent: Agent,
    shim: Option<PathBuf>,
    node: Option<PathBuf>,
    host_runtime: Option<PathBuf>,
    desktop_controller: Option<PathBuf>,
    renderer_extension: Option<PathBuf>,
    pi: Option<PathBuf>,
}

#[derive(Debug)]
struct ResolvedLaunchOptions {
    agent: Agent,
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

fn required_value<'a>(
    arguments: &'a [String],
    index: &mut usize,
    option: &str,
) -> Result<&'a str, String> {
    *index += 1;
    arguments
        .get(*index)
        .map(String::as_str)
        .ok_or_else(|| format!("{option} requires a value"))
}

fn parse_launch_options(arguments: &[String]) -> Result<LaunchOptions, String> {
    let mut agent = None;
    let mut shim = None;
    let mut node = None;
    let mut host_runtime = None;
    let mut desktop_controller = None;
    let mut renderer_extension = None;
    let mut pi = None;
    let mut index = 0;
    while index < arguments.len() {
        match arguments[index].as_str() {
            "--agent" => {
                agent = Some(Agent::parse(required_value(
                    arguments, &mut index, "--agent",
                )?)?)
            }
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
            unknown => return Err(format!("unknown launch option: {unknown}")),
        }
        index += 1;
    }
    Ok(LaunchOptions {
        agent: agent.ok_or("--agent is required")?,
        shim,
        node,
        host_runtime,
        desktop_controller,
        renderer_extension,
        pi,
    })
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
            agent: self.agent,
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
        })
    }
}

fn desktop_controller_command(
    options: &ResolvedLaunchOptions,
    control: &RuntimeControl,
) -> Command {
    let mut command = Command::new(&options.node);
    command
        .arg(node_entrypoint_path(&options.desktop_controller))
        .arg("--inspector-endpoint")
        .arg(&control.inspector_endpoint)
        .arg("--renderer")
        .arg(&options.renderer_extension)
        .arg("--default-agent")
        .arg(options.agent.as_str())
        .arg("--attachment-port")
        .arg(control.attachment_port.to_string())
        .arg("--attachment-nonce")
        .arg(&control.nonce)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    configure_background_command(&mut command);
    command
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
        let mut line = String::new();
        let result = BufReader::new(stdout)
            .read_line(&mut line)
            .map(|bytes| if bytes == 0 { String::new() } else { line });
        let _ = sender.send(result);
    });
    let line = receiver
        .recv_timeout(timeout)
        .map_err(|_| "Desktop Controller did not become ready before timeout")??;
    if line.trim_end() != "ready" {
        return Err(format!(
            "Desktop Controller returned an invalid readiness signal: {:?}",
            line.trim_end()
        )
        .into());
    }
    Ok(())
}

fn start_desktop_controller(
    options: &ResolvedLaunchOptions,
    control: &RuntimeControl,
) -> Result<SupervisedChild, Box<dyn Error>> {
    let mut controller = spawn_supervised(&mut desktop_controller_command(options, control))?;
    if let Err(error) = wait_for_controller_ready(&mut controller, Duration::from_secs(120)) {
        let _ = controller.force_terminate();
        let _ = controller.wait();
        return Err(error);
    }
    Ok(controller)
}

#[cfg(target_os = "windows")]
fn wait_for_launched_desktop_ownership(
    desktop: &mut Child,
    timeout: Duration,
) -> Result<(), Box<dyn Error>> {
    let desktop_pid = desktop.id();
    let started = Instant::now();
    loop {
        let roots = desktop_root_process_ids()?;
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

#[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
fn wait_for_launched_desktop_ownership(
    _desktop: &mut Child,
    _timeout: Duration,
) -> Result<(), Box<dyn Error>> {
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn wait_for_desktop_exit(
    desktop: &mut Child,
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

fn stop_desktop_controller(controller: &mut SupervisedChild) -> Result<(), Box<dyn Error>> {
    if let Some(status) = controller.try_wait()? {
        controller.disarm_cleanup();
        if !status.success() {
            return Err(format!("Desktop Controller exited unsuccessfully: {status}").into());
        }
        return Ok(());
    }
    controller.terminate()?;
    let _ = controller.wait()?;
    controller.disarm_cleanup();
    Ok(())
}

#[cfg(target_os = "macos")]
fn supervise_desktop(
    installation: &DesktopInstallation,
    options: &ResolvedLaunchOptions,
    desktop_arguments: &[OsString],
    environment: &[(OsString, OsString)],
    control: &RuntimeControl,
) -> Result<(), Box<dyn Error>> {
    let mut desktop = launch_desktop_session(
        installation,
        &options.shim,
        DesktopLaunchMode::LaunchServices,
        desktop_arguments,
        environment,
        Duration::from_secs(30),
    )?;
    let mut controller = start_desktop_controller(options, control)?;
    let desktop_pid = desktop.root_snapshot().id;
    if !wait_for_host_chain(desktop_pid, options, Duration::from_secs(30))? {
        let _ = stop_desktop_controller(&mut controller);
        let _ = desktop.shutdown(Duration::from_secs(2));
        return Err("Codex Desktop did not start the codexhost Host chain before timeout".into());
    }
    let _runtime = publish_runtime_descriptor(control)?;
    loop {
        if let Some(status) = controller.try_wait()? {
            let _ = desktop.shutdown(Duration::from_secs(2));
            return Err(
                format!("Desktop Controller exited while Desktop was running: {status}").into(),
            );
        }
        if !desktop.is_running()? {
            stop_desktop_controller(&mut controller)?;
            desktop.cleanup_escaped(Duration::from_secs(2))?;
            desktop.disarm_cleanup();
            return Ok(());
        }
        thread::sleep(Duration::from_millis(100));
    }
}

#[cfg(not(target_os = "macos"))]
fn supervise_desktop(
    installation: &DesktopInstallation,
    options: &ResolvedLaunchOptions,
    desktop_arguments: &[OsString],
    environment: &[(OsString, OsString)],
    control: &RuntimeControl,
) -> Result<(), Box<dyn Error>> {
    let mut desktop = launch_desktop(
        installation,
        &options.shim,
        DesktopLaunchMode::DirectExecutable,
        desktop_arguments,
        environment,
    )?;
    let desktop_pid = desktop.id();
    wait_for_launched_desktop_ownership(&mut desktop, Duration::from_secs(5))?;
    let mut controller = match start_desktop_controller(options, control) {
        Ok(controller) => controller,
        Err(error) => {
            let _ = desktop.kill();
            let _ = desktop.wait();
            return Err(error);
        }
    };
    if !wait_for_host_chain(desktop_pid, options, Duration::from_secs(30))? {
        let _ = stop_desktop_controller(&mut controller);
        let _ = desktop.kill();
        let _ = desktop.wait();
        return Err("Codex Desktop did not start the codexhost Host chain before timeout".into());
    }
    let _runtime = match publish_runtime_descriptor(control) {
        Ok(runtime) => runtime,
        Err(error) => {
            let _ = stop_desktop_controller(&mut controller);
            let _ = desktop.kill();
            let _ = desktop.wait();
            return Err(error);
        }
    };
    loop {
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

fn desktop_environment(options: &ResolvedLaunchOptions) -> Vec<(OsString, OsString)> {
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
            OsString::from(DEFAULT_AGENT_ENV),
            OsString::from(Agent::Codex.as_str()),
        ),
    ];
    if let Some(pi) = &options.pi {
        environment.push((
            OsString::from(PI_COMMAND_ENV),
            node_entrypoint_path(pi).into_os_string(),
        ));
    }
    environment
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
        let process_ids = desktop_process_ids()?;
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

fn launch(options: LaunchOptions, interactive_running_desktop: bool) -> Result<(), Box<dyn Error>> {
    let options = options.resolve()?;
    let _launcher_guard = match acquire_launcher_ownership(Duration::from_secs(120))? {
        LauncherOwnership::Acquired(guard) => guard,
        LauncherOwnership::Attached => return Ok(()),
    };
    let installation = discover_codex_desktop()?;

    loop {
        let roots = desktop_root_process_ids()?;
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
                #[cfg(target_os = "windows")]
                if interactive_running_desktop {
                    match prompt_running_desktop() {
                        RunningDesktopChoice::Restart => {
                            force_stop_external_desktop(&installation, Duration::from_secs(10))?;
                            continue;
                        }
                        RunningDesktopChoice::Retry => continue,
                        RunningDesktopChoice::Cancel => return Ok(()),
                    }
                }
                return Err(Box::new(UnmanagedDesktopConflict));
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

        let environment = desktop_environment(&options);
        let control = allocate_runtime_control()?;
        let result = supervise_desktop(
            &installation,
            &options,
            std::slice::from_ref(&control.inspector_argument),
            &environment,
            &control,
        );
        match result {
            Err(error)
                if interactive_running_desktop
                    && error.downcast_ref::<UnmanagedDesktopConflict>().is_some() =>
            {
                continue;
            }
            result => return result,
        }
    }
}

fn default_launch_options() -> LaunchOptions {
    LaunchOptions {
        agent: Agent::Pi,
        shim: None,
        node: None,
        host_runtime: None,
        desktop_controller: None,
        renderer_extension: None,
        pi: None,
    }
}

fn run(arguments: &[String]) -> Result<(), Box<dyn Error>> {
    match arguments.first().map(String::as_str) {
        None => launch(default_launch_options(), false),
        Some(START_MENU_ARGUMENT) if arguments.len() == 1 => launch(default_launch_options(), true),
        Some("inspect") if arguments.len() == 1 => inspect(),
        Some("launch") => launch(parse_launch_options(&arguments[1..])?, false),
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
    if start_menu_launch {
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
    use std::ffi::{OsStr, OsString};
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;
    use std::path::PathBuf;
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    use std::process::Command;
    #[cfg(target_os = "macos")]
    use std::process::Stdio;
    use std::thread;
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    use std::time::Duration;

    #[cfg(target_os = "windows")]
    use codexhost_platform::configure_background_command;
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    use codexhost_platform::spawn_supervised;

    #[cfg(target_os = "windows")]
    use super::PI_COMMAND_ENV;
    #[cfg(target_os = "macos")]
    use super::wait_for_controller_ready;
    use super::{
        Agent, DEFAULT_AGENT_ENV, ResolvedLaunchOptions, RuntimeControl, allocate_runtime_control,
        default_launch_options, desktop_controller_command, desktop_environment,
        parse_launch_options,
    };
    #[cfg(target_os = "windows")]
    use super::{stop_desktop_controller, wait_for_desktop_exit};

    #[test]
    fn no_argument_launch_defaults_to_pi() {
        assert_eq!(default_launch_options().agent.as_str(), "pi");
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
        let mut desktop = Command::new("cmd.exe")
            .args(["/d", "/c", "exit", "0"])
            .spawn()
            .expect("spawn exiting Desktop fixture");

        let status = wait_for_desktop_exit(&mut desktop, Duration::from_secs(1))
            .expect("observe Desktop exit")
            .expect("Desktop exited before timeout");
        assert!(status.success());
    }

    #[test]
    fn bundled_runtime_paths_are_optional_launch_arguments() {
        let options =
            parse_launch_options(&["--agent".into(), "pi".into()]).expect("bundled launch options");

        assert_eq!(options.agent.as_str(), "pi");
        assert!(options.shim.is_none());
        assert!(options.node.is_none());
        assert!(options.host_runtime.is_none());
        assert!(options.desktop_controller.is_none());
        assert!(options.renderer_extension.is_none());
    }

    #[test]
    fn explicit_development_paths_remain_supported() {
        let options = parse_launch_options(&[
            "--agent".into(),
            "codex".into(),
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

    fn resolved_options() -> ResolvedLaunchOptions {
        ResolvedLaunchOptions {
            agent: Agent::Pi,
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
            inspector_endpoint: "http://127.0.0.1:43123".into(),
            inspector_argument: "--inspect=127.0.0.1:43123".into(),
            attachment_port: 43124,
            nonce: "0123456789abcdef0123456789abcdef".into(),
        }
    }

    #[test]
    fn production_controller_uses_private_node_and_loopback_inspector() {
        let options = resolved_options();
        let command = desktop_controller_command(&options, &runtime_control());
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
                "pi",
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
        let environment = desktop_environment(&options);
        assert_eq!(
            environment
                .iter()
                .find(|(name, _)| name == DEFAULT_AGENT_ENV)
                .map(|(_, value)| value),
            Some(&OsString::from("codex")),
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

    #[cfg(target_os = "windows")]
    #[test]
    fn production_controller_normalizes_a_verbatim_node_entrypoint() {
        let options = ResolvedLaunchOptions {
            desktop_controller: PathBuf::from(r"\\?\C:\Program Files\codexhost\controller.mjs"),
            ..resolved_options()
        };
        let command = desktop_controller_command(&options, &runtime_control());

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
            desktop_environment(&options)
                .into_iter()
                .find(|(name, _)| name == PI_COMMAND_ENV)
                .map(|(_, value)| value),
            Some(OsString::from(r"C:\nvm4w\nodejs\pi.cmd")),
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn controller_must_emit_the_exact_ready_signal() {
        let mut command = Command::new("/bin/sh");
        command
            .args(["-c", "printf 'ready\\n'"])
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
