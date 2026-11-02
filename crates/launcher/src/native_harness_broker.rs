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
    pub harness_id: String,
    pub node: Option<PathBuf>,
    pub host_runtime: Option<PathBuf>,
}

fn macos_absolute_path(value: &str, option: &str) -> Result<PathBuf, String> {
    if !value.starts_with('/') {
        return Err(format!("{option} must be an absolute macOS path"));
    }
    Ok(PathBuf::from(value))
}

pub const NATIVE_HARNESS_BROKER_USAGE: &str = "usage: codexhost broker install|status|stop|uninstall [--harness <id>] [--node <absolute-file> --host-runtime <absolute-file>]
The native Harness broker is available only on macOS.";

/// The npm wrapper appends exactly `--node <file> --host-runtime <file>` after the user's
/// arguments, so a missing subcommand reaches the launcher as that sequence rather than as
/// nothing. Any other leading option stays an unknown-command error.
pub fn native_harness_broker_usage_requested(arguments: &[String]) -> bool {
    match arguments.first().map(String::as_str) {
        None | Some("--help" | "-h" | "help") => true,
        Some(first) if first.starts_with('-') => is_wrapper_injected_runtime_options(arguments),
        Some("install" | "status" | "stop" | "uninstall") => arguments[1..]
            .iter()
            .any(|argument| argument == "--help" || argument == "-h"),
        Some(_) => false,
    }
}

fn is_wrapper_injected_runtime_options(arguments: &[String]) -> bool {
    matches!(
        arguments,
        [node, _, host_runtime, _] if node == "--node" && host_runtime == "--host-runtime"
    )
}

pub fn run_native_harness_broker_cli(arguments: &[String]) -> Result<(), Box<dyn Error>> {
    if native_harness_broker_usage_requested(arguments) {
        println!("{NATIVE_HARNESS_BROKER_USAGE}");
        return Ok(());
    }
    run_parsed_native_harness_broker_cli(parse_native_harness_broker_cli(arguments)?)
}

pub fn parse_native_harness_broker_cli(
    arguments: &[String],
) -> Result<NativeHarnessBrokerCli, String> {
    let Some(command) = arguments.first() else {
        return Err(NATIVE_HARNESS_BROKER_USAGE.to_owned());
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
    let mut harness_id = None;
    let mut index = 1;
    while index < arguments.len() {
        let option = arguments[index].as_str();
        let value = arguments
            .get(index + 1)
            .ok_or_else(|| format!("{option} requires a value"))?;
        match option {
            "--node" if node.is_none() => node = Some(macos_absolute_path(value, "--node")?),
            "--host-runtime" if host_runtime.is_none() => {
                host_runtime = Some(macos_absolute_path(value, "--host-runtime")?)
            }
            "--harness" if harness_id.is_none() => {
                codexhost_platform::native_harness_broker_label(value)
                    .map_err(|e| e.to_string())?;
                harness_id = Some(value.clone());
            }
            "--node" | "--host-runtime" | "--harness" => {
                return Err(format!("duplicate option: {option}"));
            }
            unknown => return Err(format!("unknown native Harness broker option: {unknown}")),
        }
        index += 2;
    }
    if node.is_some() != host_runtime.is_some() {
        return Err("--node and --host-runtime must be supplied together".to_owned());
    }
    Ok(NativeHarnessBrokerCli {
        command,
        harness_id: harness_id.unwrap_or_else(|| "claude-code".to_owned()),
        node,
        host_runtime,
    })
}

#[cfg(target_os = "macos")]
fn run_parsed_native_harness_broker_cli(cli: NativeHarnessBrokerCli) -> Result<(), Box<dyn Error>> {
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
        harness_id: &cli.harness_id,
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
                NativeHarnessBrokerInstallOutcome::AlreadyRegistered => "already-registered",
                NativeHarnessBrokerInstallOutcome::Stopped => "stopped-for-update",
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
fn run_parsed_native_harness_broker_cli(_: NativeHarnessBrokerCli) -> Result<(), Box<dyn Error>> {
    Err("the native Harness broker is available only on macOS".into())
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::{
        NativeHarnessBrokerCliCommand, native_harness_broker_usage_requested,
        parse_native_harness_broker_cli,
    };

    fn arguments(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    #[test]
    fn usage_is_requested_without_a_subcommand_even_after_injected_runtime_options() {
        for requested in [
            &[][..],
            &["--help"],
            &["-h"],
            &["help"],
            &["--node", "/usr/bin/node", "--host-runtime", "/opt/host.mjs"],
            &[
                "--help",
                "--node",
                "/usr/bin/node",
                "--host-runtime",
                "/opt/host.mjs",
            ],
            &[
                "status",
                "--help",
                "--node",
                "/usr/bin/node",
                "--host-runtime",
                "/opt/host.mjs",
            ],
        ] {
            assert!(
                native_harness_broker_usage_requested(&arguments(requested)),
                "{requested:?}"
            );
        }
        for command in [
            &["status"][..],
            &[
                "install",
                "--node",
                "/usr/bin/node",
                "--host-runtime",
                "/opt/host.mjs",
            ],
            &["bogus"],
            &["bogus", "--help"],
            &["nonexistent", "-h"],
            &["--bogus"],
            &[
                "--bogus",
                "--node",
                "/usr/bin/node",
                "--host-runtime",
                "/opt/host.mjs",
            ],
            &["--node", "/usr/bin/node"],
            &["--harness", "claude-code"],
            &["--host-runtime", "/opt/host.mjs", "--node", "/usr/bin/node"],
            &[
                "bogus",
                "--node",
                "/usr/bin/node",
                "--host-runtime",
                "/opt/host.mjs",
            ],
        ] {
            assert!(
                !native_harness_broker_usage_requested(&arguments(command)),
                "{command:?}"
            );
        }
        assert!(parse_native_harness_broker_cli(&arguments(&["bogus"])).is_err());
        assert!(parse_native_harness_broker_cli(&arguments(&["--bogus"])).is_err());
    }

    #[test]
    fn selected_harness_is_explicit_and_defaults_to_legacy_claude() {
        assert_eq!(
            parse_native_harness_broker_cli(&["status".into()])
                .unwrap()
                .harness_id,
            "claude-code"
        );
        for id in ["codebuddy", "workbuddy", "cursor-cli"] {
            assert_eq!(
                parse_native_harness_broker_cli(&["install".into(), "--harness".into(), id.into()])
                    .unwrap()
                    .harness_id,
                id
            );
        }
        assert!(
            parse_native_harness_broker_cli(&[
                "stop".into(),
                "--harness".into(),
                "../claude-code".into()
            ])
            .is_err()
        );
        assert!(
            parse_native_harness_broker_cli(&[
                "stop".into(),
                "--harness".into(),
                "codebuddy".into(),
                "--harness".into(),
                "cursor-cli".into()
            ])
            .is_err()
        );
    }

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
