use std::error::Error;
use std::path::PathBuf;

#[cfg(target_os = "macos")]
use codexhost_platform::{
    NativeHarnessBrokerInstallOutcome, NativeHarnessBrokerObservedState, NativeHarnessBrokerPaths,
    inspect_native_harness_broker, install_native_harness_broker, stop_native_harness_broker,
    uninstall_native_harness_broker,
};

#[cfg(target_os = "macos")]
use crate::installation_layout::InstalledResources;
#[cfg(target_os = "macos")]
use crate::system_proxy_environment::launcher_proxy_environment;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NativeHarnessBrokerCliCommand {
    Install,
    Status,
    Stop,
    Uninstall,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeHarnessBrokerCli {
    pub command: NativeHarnessBrokerCliCommand,
    pub node: Option<PathBuf>,
    pub host_runtime: Option<PathBuf>,
}

fn macos_absolute_path(value: &str, option: &str) -> Result<PathBuf, String> {
    if !value.starts_with('/') {
        return Err(format!("{option} must be an absolute macOS path"));
    }
    Ok(PathBuf::from(value))
}

pub fn parse_native_harness_broker_cli(
    arguments: &[String],
) -> Result<NativeHarnessBrokerCli, String> {
    let Some(command) = arguments.first() else {
        return Err(
            "usage: codexhost broker install|status|stop|uninstall [--node <absolute-file> --host-runtime <absolute-file>]".to_owned(),
        );
    };
    let command = match command.as_str() {
        "install" => NativeHarnessBrokerCliCommand::Install,
        "status" => NativeHarnessBrokerCliCommand::Status,
        "stop" => NativeHarnessBrokerCliCommand::Stop,
        "uninstall" => NativeHarnessBrokerCliCommand::Uninstall,
        unknown => Err(format!(
            "unknown native Harness broker command '{unknown}'; expected install, status, stop, or uninstall"
        ))?,
    };
    let mut node = None;
    let mut host_runtime = None;
    let mut index = 1;
    while index < arguments.len() {
        let option = arguments[index].as_str();
        let value = arguments
            .get(index + 1)
            .ok_or_else(|| format!("{option} requires an absolute path"))?;
        match option {
            "--node" if node.is_none() => node = Some(macos_absolute_path(value, "--node")?),
            "--host-runtime" if host_runtime.is_none() => {
                host_runtime = Some(macos_absolute_path(value, "--host-runtime")?)
            }
            "--node" | "--host-runtime" => return Err(format!("duplicate option: {option}")),
            unknown => return Err(format!("unknown native Harness broker option: {unknown}")),
        }
        index += 2;
    }
    if node.is_some() != host_runtime.is_some() {
        return Err("--node and --host-runtime must be supplied together".to_owned());
    }
    Ok(NativeHarnessBrokerCli {
        command,
        node,
        host_runtime,
    })
}

#[cfg(target_os = "macos")]
pub fn run_native_harness_broker_cli(arguments: &[String]) -> Result<(), Box<dyn Error>> {
    let cli = parse_native_harness_broker_cli(arguments)?;
    let bundled_resources = if cli.node.is_none() {
        Some(InstalledResources::from_current_executable()?)
    } else {
        None
    };
    let home = std::env::var_os("HOME")
        .map(std::path::PathBuf::from)
        .ok_or("HOME is required to manage the current user's native Harness broker")?;
    let node = cli
        .node
        .as_deref()
        .or_else(|| {
            bundled_resources
                .as_ref()
                .map(|resources| resources.node.as_path())
        })
        .ok_or("native Harness broker Node.js runtime is unavailable")?;
    let host_runtime = cli
        .host_runtime
        .as_deref()
        .or_else(|| {
            bundled_resources
                .as_ref()
                .map(|resources| resources.host_runtime.as_path())
        })
        .ok_or("native Harness broker Host Runtime is unavailable")?;
    let paths = NativeHarnessBrokerPaths {
        home: &home,
        node,
        host_runtime,
    };
    let proxy_environment = launcher_proxy_environment()
        .into_iter()
        .map(|(name, value)| {
            let name = name
                .into_string()
                .map_err(|_| "native Harness broker proxy variable name is not UTF-8")?;
            let value = value.into_string().map_err(|_| {
                format!("native Harness broker proxy value for {name} is not UTF-8")
            })?;
            Ok::<_, Box<dyn Error>>((name, value))
        })
        .collect::<Result<Vec<_>, _>>()?;
    match cli.command {
        NativeHarnessBrokerCliCommand::Install => {
            let outcome = install_native_harness_broker(paths, &proxy_environment)?;
            let state = match outcome {
                NativeHarnessBrokerInstallOutcome::AlreadyRunning => "already-running",
                NativeHarnessBrokerInstallOutcome::Started => "restarted",
                NativeHarnessBrokerInstallOutcome::Installed => "installed",
                NativeHarnessBrokerInstallOutcome::Reinstalled => "reinstalled",
            };
            println!("state={state}");
        }
        NativeHarnessBrokerCliCommand::Status => {
            let status = inspect_native_harness_broker(paths, &proxy_environment)?;
            let state = match status.observed {
                NativeHarnessBrokerObservedState::NotLoaded => "not-loaded",
                NativeHarnessBrokerObservedState::LoadedStopped => "stopped",
                NativeHarnessBrokerObservedState::Running => "running",
            };
            println!("state={state}");
            println!("label={}", status.label);
            println!("launchctl_target={}", status.launchctl_target);
            println!("plist={}", status.plist_path.display());
            println!("plist_matches={}", status.plist_matches);
            println!("descriptor_ready={}", status.descriptor_ready);
        }
        NativeHarnessBrokerCliCommand::Stop => {
            println!("stopped={}", stop_native_harness_broker(paths)?);
        }
        NativeHarnessBrokerCliCommand::Uninstall => {
            println!("removed={}", uninstall_native_harness_broker(paths)?);
        }
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub fn run_native_harness_broker_cli(arguments: &[String]) -> Result<(), Box<dyn Error>> {
    let _ = parse_native_harness_broker_cli(arguments)?;
    Err("the native Harness broker is available only on macOS".into())
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::{NativeHarnessBrokerCliCommand, parse_native_harness_broker_cli};

    #[test]
    fn parses_the_broker_lifecycle_commands_without_accepting_extra_arguments() {
        for (argument, expected) in [
            ("install", NativeHarnessBrokerCliCommand::Install),
            ("status", NativeHarnessBrokerCliCommand::Status),
            ("stop", NativeHarnessBrokerCliCommand::Stop),
            ("uninstall", NativeHarnessBrokerCliCommand::Uninstall),
        ] {
            assert_eq!(
                parse_native_harness_broker_cli(&[argument.to_owned()])
                    .expect("valid command")
                    .command,
                expected
            );
        }
        assert!(parse_native_harness_broker_cli(&["install".into(), "unexpected".into()]).is_err());
    }

    #[test]
    fn accepts_only_a_complete_absolute_runtime_pair() {
        let parsed = parse_native_harness_broker_cli(&[
            "install".into(),
            "--node".into(),
            "/opt/codexhost/runtime/node".into(),
            "--host-runtime".into(),
            "/opt/codexhost/app/host-runtime.mjs".into(),
        ])
        .expect("absolute pair");
        assert_eq!(
            parsed.node.expect("node"),
            Path::new("/opt/codexhost/runtime/node")
        );
        assert_eq!(
            parsed.host_runtime.expect("runtime"),
            Path::new("/opt/codexhost/app/host-runtime.mjs")
        );

        assert!(
            parse_native_harness_broker_cli(&[
                "install".into(),
                "--node".into(),
                "/opt/node".into(),
            ])
            .is_err()
        );
        assert!(
            parse_native_harness_broker_cli(&[
                "install".into(),
                "--node".into(),
                "relative/node".into(),
                "--host-runtime".into(),
                "/opt/host-runtime.mjs".into(),
            ])
            .is_err()
        );
    }
}
