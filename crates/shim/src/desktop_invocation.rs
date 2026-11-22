//! A managed Desktop also passes its environment to native tool helpers. Their
//! private app-servers must not become another owner of the Host Runtime.

#[cfg(any(target_os = "macos", target_os = "windows", test))]
use codexhost_platform::ProcessSnapshot;
#[cfg(any(target_os = "windows", test))]
use codexhost_platform::node_entrypoint_path;
#[cfg(any(target_os = "macos", target_os = "windows", test))]
use std::ffi::{OsStr, OsString};
#[cfg(any(target_os = "macos", test))]
use std::path::Path;

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum DesktopCaller {
    #[cfg(any(target_os = "macos", test))]
    Main,
    Helper,
    #[cfg(any(target_os = "macos", test))]
    NonDesktop,
    Unknown,
}

impl DesktopCaller {
    pub(crate) fn is_non_desktop(&self) -> bool {
        #[cfg(any(target_os = "macos", test))]
        return *self == Self::NonDesktop;
        #[cfg(not(any(target_os = "macos", test)))]
        false
    }
}

pub(crate) fn classify_desktop_caller(
    _stock_codex_path: &std::path::Path,
    _arguments: &[std::ffi::OsString],
) -> DesktopCaller {
    #[cfg(target_os = "windows")]
    {
        let Some(launcher_id) = std::env::var(super::LAUNCHER_PID_ENV)
            .ok()
            .and_then(|value| value.parse::<u32>().ok())
            .filter(|id| *id != 0)
        else {
            return DesktopCaller::Unknown;
        };
        let desktop_app_server = has_local_app_server_signature(_arguments)
            && std::env::var_os(super::INTERNAL_ORIGINATOR_OVERRIDE_ENV).as_deref()
                == Some(OsStr::new(super::DESKTOP_ORIGINATOR));
        if is_helper_descendant(std::process::id(), launcher_id, desktop_app_server, |id| {
            codexhost_platform::process_snapshot(id).ok()
        }) {
            DesktopCaller::Helper
        } else {
            DesktopCaller::Unknown
        }
    }
    #[cfg(target_os = "macos")]
    {
        let launcher_managed = std::env::var(super::LAUNCHER_PID_ENV)
            .ok()
            .and_then(|value| value.parse::<u32>().ok())
            .is_some_and(|id| id != 0)
            && std::env::var_os("CODEXHOST_LAUNCHER_EXECUTABLE").is_some();
        let installation = macos_desktop_installation(_stock_codex_path);
        classify_macos_caller(
            std::process::id(),
            installation.as_ref().map(|desktop| {
                (
                    desktop.desktop_executable.as_path(),
                    desktop.install_root.as_path(),
                )
            }),
            launcher_managed,
            _arguments,
            std::env::var_os(super::INTERNAL_ORIGINATOR_OVERRIDE_ENV).as_deref(),
            |id| codexhost_platform::process_snapshot(id).ok(),
        )
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    DesktopCaller::Unknown
}

#[cfg(target_os = "macos")]
fn macos_desktop_installation(
    stock_codex_path: &std::path::Path,
) -> Option<codexhost_platform::DesktopInstallation> {
    use codexhost_platform::discover_codex_desktop_from_root;

    // Find the validated Desktop among the CLI's enclosing app bundles; newer
    // layouts nest the CLI in its own app.
    stock_codex_path
        .ancestors()
        .filter(|path| path.extension().is_some_and(|extension| extension == "app"))
        .find_map(|bundle| {
            let installation = discover_codex_desktop_from_root(bundle).ok()?;
            (installation.executable_codex_cli == stock_codex_path).then_some(installation)
        })
}

/// The Desktop local app-server's stdio builder adds the codex-app-tools override
/// after its base flags and other config overrides. The startup probe shares the
/// base flags, and plugin helpers can also run app-server over stdio. When stdio
/// MCP servers are configured, Desktop also passes the multi-value MCP launch
/// directory options; those may appear between or after the `-c` overrides.
#[cfg(any(target_os = "macos", target_os = "windows", test))]
fn has_local_app_server_signature(arguments: &[OsString]) -> bool {
    let [config, code_mode, subcommand, analytics, overrides @ ..] = arguments else {
        return false;
    };
    const APP_TOOLS: &str = "plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled=";
    if !(config == "-c"
        && code_mode == "features.code_mode_host=true"
        && subcommand == "app-server"
        && analytics == "--analytics-default-enabled")
    {
        return false;
    }
    let mut last_override = None;
    let mut index = 0;
    while let Some(option) = overrides.get(index) {
        if option == "-c" {
            let Some(value) = overrides.get(index + 1) else {
                return false;
            };
            last_override = Some(value);
            index += 2;
            continue;
        }
        let Some(count) = option
            .to_str()
            .and_then(super::app_server_multi_value_count)
        else {
            return false;
        };
        if overrides.len() <= index + count {
            return false;
        }
        index += count + 1;
    }
    matches!(
        last_override
            .and_then(|value| value.to_str())
            .and_then(|value| value.strip_prefix(APP_TOOLS)),
        Some("true" | "false")
    )
}

#[cfg(any(target_os = "macos", test))]
fn classify_macos_caller(
    shim_id: u32,
    desktop: Option<(&Path, &Path)>,
    launcher_managed: bool,
    arguments: &[OsString],
    originator: Option<&OsStr>,
    mut inspect: impl FnMut(u32) -> Option<ProcessSnapshot>,
) -> DesktopCaller {
    let marked = launcher_managed && has_local_app_server_signature(arguments);
    let mut fallback = if marked {
        // A marked indirect invocation must not enter the lease path if its
        // ancestry cannot be verified, even when no previous lease exists.
        DesktopCaller::Helper
    } else {
        DesktopCaller::Unknown
    };
    let Some((desktop_executable, bundle)) = desktop else {
        return fallback;
    };
    let Some(mut child) = inspect(shim_id) else {
        return fallback;
    };
    // LaunchServices reparents Desktop to launchd; Launcher metadata can mark
    // the tree as managed but its PID does not establish ancestry.
    for depth in 1..=32 {
        if child.parent_id <= 1 || child.parent_id == child.id {
            break;
        }
        let Some(parent) = inspect(child.parent_id) else {
            break;
        };
        if parent.started_at_micros > child.started_at_micros {
            break; // Parent PID was reused.
        }
        if parent.executable == desktop_executable {
            return if depth == 1
                || (depth == 2
                    && marked
                    && originator == Some(OsStr::new(super::DESKTOP_ORIGINATOR))
                    && child.executable.starts_with(bundle))
            {
                DesktopCaller::Main
            } else {
                DesktopCaller::Helper
            };
        }
        if depth == 1 && !marked {
            fallback = if launcher_managed && parent.executable.starts_with(bundle) {
                DesktopCaller::Helper
            } else {
                DesktopCaller::NonDesktop
            };
        }
        if !launcher_managed {
            break;
        }
        child = parent;
    }
    fallback
}

#[cfg(any(target_os = "windows", test))]
fn is_helper_descendant(
    shim_id: u32,
    launcher_id: u32,
    desktop_app_server: bool,
    mut inspect: impl FnMut(u32) -> Option<ProcessSnapshot>,
) -> bool {
    let Some(mut child) = inspect(shim_id) else {
        return false;
    };
    // Desktop 26.1117 can launch its main app-server through an Electron
    // utility that uses the same ChatGPT.exe image as the Desktop root.
    let mut same_desktop_image = false;
    for depth in 1..=32 {
        if child.parent_id == 0 || child.parent_id == child.id {
            return false;
        }
        let Some(parent) = inspect(child.parent_id) else {
            return false;
        };
        if parent.started_at_micros > child.started_at_micros {
            return false; // Parent PID was reused.
        }
        if parent.id == launcher_id {
            return depth > 2 && !(depth == 3 && same_desktop_image);
        }
        if depth == 2 && desktop_app_server {
            same_desktop_image = parent.executable.file_name().is_some_and(|name| {
                name.eq_ignore_ascii_case(OsStr::new("ChatGPT.exe"))
                    && node_entrypoint_path(&parent.executable)
                        .as_os_str()
                        .eq_ignore_ascii_case(node_entrypoint_path(&child.executable).as_os_str())
            });
        }
        child = parent;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot(id: u32, parent_id: u32) -> ProcessSnapshot {
        ProcessSnapshot {
            id,
            parent_id,
            process_group_id: 0,
            executable: std::path::PathBuf::from("fixture"),
            started_at_micros: u64::from(id),
        }
    }

    const BUNDLE: &str = "/Applications/ChatGPT.app";
    const DESKTOP: &str = "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT";
    const UTILITY: &str = "/Applications/ChatGPT.app/Contents/Frameworks/Codex (Aperitif)";
    const MAIN_ARGS: &[&str] = &[
        "-c",
        "features.code_mode_host=true",
        "app-server",
        "--analytics-default-enabled",
        "-c",
        "plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled=true",
    ];

    fn macos_caller(
        chain: &[(u32, u32, &str)],
        arguments: &[&str],
        originator: Option<&str>,
    ) -> DesktopCaller {
        classify_macos_caller(
            40,
            Some((Path::new(DESKTOP), Path::new(BUNDLE))),
            true,
            &arguments.iter().map(OsString::from).collect::<Vec<_>>(),
            originator.map(OsStr::new),
            |id| {
                let &(_, parent_id, executable) = chain.iter().find(|entry| entry.0 == id)?;
                Some(ProcessSnapshot {
                    executable: executable.into(),
                    ..snapshot(id, parent_id)
                })
            },
        )
    }

    #[test]
    fn macos_desktop_direct_app_server_remains_main() {
        assert_eq!(
            macos_caller(
                &[(40, 10, "/shim"), (10, 1, DESKTOP)],
                &["app-server"],
                None
            ),
            DesktopCaller::Main
        );
    }

    fn signature(extra: &[&str]) -> bool {
        has_local_app_server_signature(
            &[MAIN_ARGS, extra]
                .concat()
                .iter()
                .map(OsString::from)
                .collect::<Vec<_>>(),
        )
    }

    #[test]
    fn local_app_server_signature_accepts_mcp_launch_directories() {
        assert!(signature(&[]));
        assert!(signature(&[
            "--mcp-launch-cwd",
            "files",
            "/usr/bin/node",
            "/tmp/project",
        ]));
        assert!(signature(&[
            "--plugin-mcp-launch-cwd",
            "github@openai-curated",
            "github",
            "/tmp/project",
        ]));
        // Launch directories ahead of the app-tools override keep it as the last config override.
        let mut before = MAIN_ARGS[..4].to_vec();
        before.extend([
            "--plugin-mcp-launch-cwd",
            "github@openai-curated",
            "github",
            "/tmp/project",
        ]);
        before.extend(&MAIN_ARGS[4..]);
        assert!(has_local_app_server_signature(
            &before.iter().map(OsString::from).collect::<Vec<_>>()
        ));
    }

    #[test]
    fn local_app_server_signature_rejects_incomplete_or_unknown_options() {
        assert!(!signature(&["--mcp-launch-cwd", "files", "/usr/bin/node"]));
        assert!(!signature(&["--plugin-mcp-launch-cwd"]));
        assert!(!signature(&["--unknown-option"]));
        assert!(!signature(&["-c"]));
        // The app-tools override must still be the last config override.
        assert!(!signature(&["-c", "model=\"gpt-5\""]));
    }

    #[test]
    fn macos_local_app_server_with_mcp_launch_directories_is_main() {
        let chain = [(40, 20, "/shim"), (20, 10, UTILITY), (10, 1, DESKTOP)];
        let mut arguments = MAIN_ARGS.to_vec();
        arguments.extend(["--mcp-launch-cwd", "files", "/usr/bin/node", "/tmp/project"]);
        assert_eq!(
            macos_caller(&chain, &arguments, Some("Codex Desktop")),
            DesktopCaller::Main
        );
    }

    #[test]
    fn macos_local_app_server_through_bundled_utility_is_main() {
        let chain = [(40, 20, "/shim"), (20, 10, UTILITY), (10, 1, DESKTOP)];
        assert_eq!(
            macos_caller(&chain, MAIN_ARGS, Some("Codex Desktop")),
            DesktopCaller::Main
        );
        let mut disabled = MAIN_ARGS.to_vec();
        *disabled.last_mut().unwrap() =
            "plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled=false";
        assert_eq!(
            macos_caller(&chain, &disabled, Some("Codex Desktop")),
            DesktopCaller::Main
        );
    }

    #[test]
    fn macos_browser_and_computer_use_app_servers_remain_helpers() {
        let chain = [(40, 20, "/shim"), (20, 10, UTILITY), (10, 1, DESKTOP)];
        assert_eq!(
            macos_caller(&chain, &["app-server", "--listen", "stdio://"], None),
            DesktopCaller::Helper
        );
        assert_eq!(
            macos_caller(&chain, MAIN_ARGS, Some("codex_computer_use")),
            DesktopCaller::Helper
        );
        assert_eq!(macos_caller(&chain, MAIN_ARGS, None), DesktopCaller::Helper);
        assert_eq!(
            macos_caller(&chain, &MAIN_ARGS[..4], Some("Codex Desktop")),
            DesktopCaller::Helper
        );
    }

    #[test]
    fn macos_main_app_server_args_do_not_authorize_an_unverified_chain() {
        for chain in [
            &[
                (40, 20, "/shim"),
                (20, 10, "/other.app/utility"),
                (10, 1, DESKTOP),
            ][..],
            &[(40, 20, "/shim"), (20, 10, UTILITY)][..],
            &[
                (40, 20, "/shim"),
                (20, 10, UTILITY),
                (10, 1, "/other.app/main"),
            ][..],
            &[(40, 20, "/shim"), (20, 70, UTILITY), (70, 1, DESKTOP)][..],
            &[
                (40, 20, "/shim"),
                (20, 15, UTILITY),
                (15, 10, UTILITY),
                (10, 1, DESKTOP),
            ][..],
        ] {
            assert_eq!(
                macos_caller(chain, MAIN_ARGS, Some("Codex Desktop")),
                DesktopCaller::Helper
            );
        }
    }

    #[test]
    fn distinguishes_desktop_from_nested_helpers() {
        let inspect = |id| {
            (id >= 1).then(|| {
                let mut process = snapshot(id, id - 1);
                if matches!(id, 2..=4) {
                    process.executable = "desktop/ChatGPT.exe".into();
                }
                process
            })
        };
        assert!(!is_helper_descendant(3, 1, false, inspect));
        assert!(is_helper_descendant(4, 1, false, inspect));
        assert!(!is_helper_descendant(4, 1, true, inspect));
        assert!(is_helper_descendant(5, 1, true, inspect));
        assert!(!is_helper_descendant(3, 99, false, inspect));
        assert!(is_helper_descendant(4, 1, true, |id| {
            let mut process = inspect(id)?;
            if id == 3 {
                process.executable = "different/ChatGPT.exe".into();
            }
            Some(process)
        }));
    }

    #[test]
    fn rejects_missing_reused_and_unbounded_ancestry() {
        assert!(!is_helper_descendant(4, 1, false, |_| None));
        assert!(!is_helper_descendant(4, 1, false, |id| {
            let mut value = snapshot(id, id - 1);
            if id == 2 {
                value.started_at_micros = 99;
            }
            Some(value)
        }));
        assert!(!is_helper_descendant(4, 1, false, |id| Some(snapshot(
            id, id
        ))));
        let mut calls = 0;
        assert!(!is_helper_descendant(100, 1, false, |id| {
            calls += 1;
            Some(snapshot(id, id - 1))
        }));
        assert_eq!(calls, 33);
    }
}
