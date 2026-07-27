#![forbid(unsafe_code)]

use std::env;
use std::error::Error;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use codexhost_platform::{
    DesktopIdentity, DesktopInstallation, DesktopLaunchMode, canonical_existing_file,
    desktop_process_ids, discover_codex_desktop, launch_desktop,
};

const HOST_NODE_PATH_ENV: &str = "CODEXHOST_HOST_NODE_PATH";
const HOST_RUNTIME_PATH_ENV: &str = "CODEXHOST_HOST_RUNTIME_PATH";
const PI_COMMAND_ENV: &str = "CODEXHOST_PI_COMMAND";
const DEFAULT_AGENT_ENV: &str = "CODEXHOST_DEFAULT_AGENT";

fn usage() {
    eprintln!(
        "usage:\n  codexhost inspect\n  codexhost launch --agent <codex|pi> --shim <absolute-file> --node <absolute-file> --host-runtime <absolute-file> [--pi <absolute-file>]"
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
    shim: PathBuf,
    node: PathBuf,
    host_runtime: PathBuf,
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
            "--pi" => pi = Some(required_path(arguments, &mut index, "--pi")?),
            unknown => return Err(format!("unknown launch option: {unknown}")),
        }
        index += 1;
    }
    Ok(LaunchOptions {
        agent: agent.ok_or("--agent is required")?,
        shim: shim.ok_or("--shim is required")?,
        node: node.ok_or("--node is required")?,
        host_runtime: host_runtime.ok_or("--host-runtime is required")?,
        pi,
    })
}

fn absolute_file(path: &Path, option: &str) -> Result<PathBuf, Box<dyn Error>> {
    if !path.is_absolute() {
        return Err(format!("{option} must be an absolute path").into());
    }
    canonical_existing_file(path).map_err(Into::into)
}

fn launch(options: LaunchOptions) -> Result<(), Box<dyn Error>> {
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
    let shim = absolute_file(&options.shim, "--shim")?;
    let node = absolute_file(&options.node, "--node")?;
    let host_runtime = absolute_file(&options.host_runtime, "--host-runtime")?;
    let mut environment = vec![
        (
            OsString::from(HOST_NODE_PATH_ENV),
            node.as_os_str().to_owned(),
        ),
        (
            OsString::from(HOST_RUNTIME_PATH_ENV),
            host_runtime.as_os_str().to_owned(),
        ),
        (
            OsString::from(DEFAULT_AGENT_ENV),
            OsString::from(options.agent.as_str()),
        ),
    ];
    if let Some(pi) = options.pi {
        let pi = absolute_file(&pi, "--pi")?;
        environment.push((OsString::from(PI_COMMAND_ENV), pi.as_os_str().to_owned()));
    }
    let launch_mode = if cfg!(target_os = "macos") {
        DesktopLaunchMode::LaunchServices
    } else {
        DesktopLaunchMode::DirectExecutable
    };
    let mut child = launch_desktop(&installation, &shim, launch_mode, &environment)?;
    let status = child.wait()?;
    if !status.success() {
        return Err(format!("Codex Desktop launch exited unsuccessfully: {status}").into());
    }
    Ok(())
}

fn run() -> Result<(), Box<dyn Error>> {
    let arguments = env::args().skip(1).collect::<Vec<_>>();
    match arguments.first().map(String::as_str) {
        Some("inspect") if arguments.len() == 1 => inspect(),
        Some("launch") => launch(parse_launch_options(&arguments[1..])?),
        _ => {
            usage();
            Err("invalid launcher arguments".into())
        }
    }
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("codexhost launcher: {error}");
            ExitCode::FAILURE
        }
    }
}
