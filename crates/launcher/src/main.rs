#![forbid(unsafe_code)]

mod installation_layout;

use std::env;
use std::error::Error;
use std::ffi::OsString;
use std::io::{BufRead, BufReader};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

#[cfg(not(target_os = "macos"))]
use codexhost_platform::launch_desktop;
#[cfg(target_os = "macos")]
use codexhost_platform::launch_desktop_session;
use codexhost_platform::{
    DesktopIdentity, DesktopInstallation, DesktopLaunchMode, SupervisedChild,
    canonical_existing_file, configure_background_command, desktop_process_ids,
    discover_codex_desktop, node_entrypoint_path, spawn_supervised,
};
#[cfg(target_os = "windows")]
use codexhost_platform::{hide_console_window, show_error_dialog};
use installation_layout::InstalledResources;

const HOST_NODE_PATH_ENV: &str = "CODEXHOST_HOST_NODE_PATH";
const HOST_RUNTIME_PATH_ENV: &str = "CODEXHOST_HOST_RUNTIME_PATH";
const PI_COMMAND_ENV: &str = "CODEXHOST_PI_COMMAND";
const DEFAULT_AGENT_ENV: &str = "CODEXHOST_DEFAULT_AGENT";
const START_MENU_ARGUMENT: &str = "--start-menu";

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

fn allocate_inspector_endpoint() -> Result<(String, OsString), Box<dyn Error>> {
    let listener = TcpListener::bind(("127.0.0.1", 0))?;
    let port = listener.local_addr()?.port();
    drop(listener);
    Ok((
        format!("http://127.0.0.1:{port}"),
        OsString::from(format!("--inspect=127.0.0.1:{port}")),
    ))
}

fn desktop_controller_command(options: &ResolvedLaunchOptions, endpoint: &str) -> Command {
    let mut command = Command::new(&options.node);
    command
        .arg(node_entrypoint_path(&options.desktop_controller))
        .arg("--inspector-endpoint")
        .arg(endpoint)
        .arg("--renderer")
        .arg(&options.renderer_extension)
        .arg("--default-agent")
        .arg(options.agent.as_str())
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
    endpoint: &str,
) -> Result<SupervisedChild, Box<dyn Error>> {
    let mut controller = spawn_supervised(&mut desktop_controller_command(options, endpoint))?;
    if let Err(error) = wait_for_controller_ready(&mut controller, Duration::from_secs(120)) {
        let _ = controller.force_terminate();
        let _ = controller.wait();
        return Err(error);
    }
    Ok(controller)
}

fn stop_desktop_controller(controller: &mut SupervisedChild) -> Result<(), Box<dyn Error>> {
    if controller.try_wait()?.is_none() {
        controller.terminate()?;
    }
    let status = controller.wait()?;
    controller.disarm_cleanup();
    if !status.success() {
        return Err(format!("Desktop Controller exited unsuccessfully: {status}").into());
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn supervise_desktop(
    installation: &DesktopInstallation,
    options: &ResolvedLaunchOptions,
    desktop_arguments: &[OsString],
    environment: &[(OsString, OsString)],
    endpoint: &str,
) -> Result<(), Box<dyn Error>> {
    let mut desktop = launch_desktop_session(
        installation,
        &options.shim,
        DesktopLaunchMode::LaunchServices,
        desktop_arguments,
        environment,
        Duration::from_secs(30),
    )?;
    let mut controller = start_desktop_controller(options, endpoint)?;
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
    endpoint: &str,
) -> Result<(), Box<dyn Error>> {
    let mut desktop = launch_desktop(
        installation,
        &options.shim,
        DesktopLaunchMode::DirectExecutable,
        desktop_arguments,
        environment,
    )?;
    let mut controller = match start_desktop_controller(options, endpoint) {
        Ok(controller) => controller,
        Err(error) => {
            let _ = desktop.kill();
            let _ = desktop.wait();
            return Err(error);
        }
    };
    loop {
        if let Some(status) = controller.try_wait()? {
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
        environment.push((OsString::from(PI_COMMAND_ENV), pi.as_os_str().to_owned()));
    }
    environment
}

fn launch(options: LaunchOptions) -> Result<(), Box<dyn Error>> {
    let options = options.resolve()?;
    let installation = discover_codex_desktop()?;
    let running = desktop_process_ids()?;
    if !running.is_empty() {
        return Err(format!(
            "Codex Desktop is already running as PID(s) {}; close it before codexhost launch",
            running
                .iter()
                .map(u32::to_string)
                .collect::<Vec<_>>()
                .join(",")
        )
        .into());
    }
    let environment = desktop_environment(&options);
    let (endpoint, inspector_argument) = allocate_inspector_endpoint()?;
    supervise_desktop(
        &installation,
        &options,
        &[inspector_argument],
        &environment,
        &endpoint,
    )
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
        None => launch(default_launch_options()),
        Some(START_MENU_ARGUMENT) if arguments.len() == 1 => launch(default_launch_options()),
        Some("inspect") if arguments.len() == 1 => inspect(),
        Some("launch") => launch(parse_launch_options(&arguments[1..])?),
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
    use std::path::PathBuf;
    #[cfg(target_os = "macos")]
    use std::process::{Command, Stdio};
    #[cfg(target_os = "macos")]
    use std::time::Duration;

    #[cfg(target_os = "macos")]
    use codexhost_platform::spawn_supervised;

    #[cfg(target_os = "macos")]
    use super::wait_for_controller_ready;
    use super::{
        Agent, DEFAULT_AGENT_ENV, ResolvedLaunchOptions, allocate_inspector_endpoint,
        default_launch_options, desktop_controller_command, desktop_environment,
        parse_launch_options,
    };

    #[test]
    fn no_argument_launch_defaults_to_pi() {
        assert_eq!(default_launch_options().agent.as_str(), "pi");
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

    #[test]
    fn production_controller_uses_private_node_and_loopback_inspector() {
        let options = resolved_options();
        let command = desktop_controller_command(&options, "http://127.0.0.1:43123");
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
            ]
        );

        let (endpoint, argument) = allocate_inspector_endpoint().expect("ephemeral Inspector");
        assert!(endpoint.starts_with("http://127.0.0.1:"));
        assert!(
            argument
                .to_string_lossy()
                .starts_with("--inspect=127.0.0.1:")
        );
        assert!(!argument.to_string_lossy().contains("remote-debugging"));
        let environment = desktop_environment(&options);
        assert_eq!(
            environment
                .iter()
                .find(|(name, _)| name == DEFAULT_AGENT_ENV)
                .map(|(_, value)| value),
            Some(&OsString::from("codex")),
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn production_controller_normalizes_a_verbatim_node_entrypoint() {
        let options = ResolvedLaunchOptions {
            desktop_controller: PathBuf::from(r"\\?\C:\Program Files\codexhost\controller.mjs"),
            ..resolved_options()
        };
        let command = desktop_controller_command(&options, "http://127.0.0.1:43123");

        assert_eq!(
            command.get_args().next(),
            Some(OsStr::new(r"C:\Program Files\codexhost\controller.mjs")),
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
