//! Launcher integration with the codexhost console.
//!
//! The console is a Node process (`console-server.mjs`) that serves a local
//! page independent of Codex Desktop. The Launcher only starts it, hands it the
//! Launcher path, and describes the installation as JSON; all console
//! behavior lives in the console package.

use std::env;
use std::error::Error;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::thread::{self, JoinHandle};
use std::time::Duration;

use codexhost_platform::{DesktopIdentity, DesktopInstallation, node_entrypoint_path};
use serde_json::{Value, json};

use crate::desktop_attachment::endpoint_ready;
use crate::runtime_instance::{default_descriptor_path, read_descriptor};

/// `0` disables starting, opening, and announcing the console during launch.
pub const CONSOLE_ENV: &str = "CODEXHOST_CONSOLE";
const LAUNCHER_EXECUTABLE_ENV: &str = "CODEXHOST_LAUNCHER_EXECUTABLE";
const INSPECT_SCHEMA_VERSION: u8 = 1;
const CONSOLE_URL_PREFIX: &str = "codexhost console: ";
const CONTROLLER_STATUS_FILE: &str = "desktop-controller-v1.json";
const INTEGRATION_POLL_INTERVAL: Duration = Duration::from_secs(5);
const PERSISTENT_INTEGRATION_FAILURE_MS: u64 = 60_000;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConsoleCommand {
    pub node: PathBuf,
    pub console_server: PathBuf,
}

/// How a launch shows the console once its outcome is known.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Presentation {
    /// Installer launches (Finder, Start Menu) open the default browser.
    Browser,
    /// Terminal launches (`launch`, used by npm and `npm start`) print the address.
    Print,
}

struct LaunchConsole {
    command: ConsoleCommand,
    presentation: Presentation,
    ensure: Option<JoinHandle<()>>,
    shown: bool,
}

static PRESENTATION: Mutex<Option<Presentation>> = Mutex::new(None);
static LAUNCH_CONSOLE: Mutex<Option<LaunchConsole>> = Mutex::new(None);

fn console_enabled(value: Option<OsString>) -> bool {
    value.as_deref() != Some(std::ffi::OsStr::new("0"))
}

/// Chooses the presentation for this launch; called before launching.
pub fn set_presentation(presentation: Presentation) {
    if let Ok(mut slot) = PRESENTATION.lock() {
        *slot = Some(presentation);
    }
}

fn node_command(command: &ConsoleCommand) -> Result<Command, Box<dyn Error>> {
    let launcher = env::current_exe()?.canonicalize()?;
    let mut process = Command::new(&command.node);
    process
        .arg(node_entrypoint_path(&command.console_server))
        .env(LAUNCHER_EXECUTABLE_ENV, &launcher)
        .stdin(Stdio::null());
    #[cfg(target_os = "windows")]
    codexhost_platform::configure_background_command(&mut process);
    Ok(process)
}

/// Starts the console as part of this launch. A terminal launch starts it in
/// the background; an installer launch waits for it and opens it before Codex
/// Desktop starts. Resources that do not exist are ignored, so a broken
/// installation still reports its launch error.
pub fn start_for_launch(command: ConsoleCommand) {
    if !console_enabled(env::var_os(CONSOLE_ENV)) || !command.console_server.is_file() {
        return;
    }
    let Some(presentation) = PRESENTATION.lock().ok().and_then(|slot| *slot) else {
        return;
    };
    if let Ok(mut slot) = LAUNCH_CONSOLE.lock() {
        *slot = Some(LaunchConsole {
            command: command.clone(),
            presentation,
            ensure: None,
            shown: false,
        });
    }
    let ensure = thread::spawn(move || {
        let Ok(mut process) = node_command(&command) else {
            return;
        };
        let Ok(output) = process.arg("ensure").stderr(Stdio::null()).output() else {
            return;
        };
        // A terminal launch prints the address as soon as the console serves,
        // instead of after Codex Desktop becomes ready.
        if presentation == Presentation::Print
            && output.status.success()
            && let Some(url) = parse_console_url(&output.stdout)
        {
            print_once(&url);
        }
    });
    if let Ok(mut slot) = LAUNCH_CONSOLE.lock()
        && let Some(console) = slot.as_mut()
    {
        console.ensure = Some(ensure);
    }
    // An installer launch shows the console first, then starts Codex Desktop.
    if presentation == Presentation::Browser {
        show(None);
    }
}

fn parse_console_url(stdout: &[u8]) -> Option<String> {
    String::from_utf8_lossy(stdout)
        .lines()
        .rev()
        .find_map(|line| line.strip_prefix(CONSOLE_URL_PREFIX))
        .map(|url| url.trim().to_owned())
        .filter(|url| crate::validate_loopback_root_url(url).is_ok())
}

fn print_once(url: &str) {
    let Ok(mut slot) = LAUNCH_CONSOLE.lock() else {
        return;
    };
    let Some(console) = slot.as_mut() else {
        return;
    };
    if !console.shown {
        console.shown = true;
        print_url(url);
    }
}

/// Separated by a blank line from what the npm wrapper printed before it.
fn print_url(url: &str) {
    eprintln!("\n{CONSOLE_URL_PREFIX}{url}");
}

fn console_url(command: &ConsoleCommand) -> Result<String, Box<dyn Error>> {
    let mut process = node_command(command)?;
    process.arg("open").arg("--no-browser");
    let output = process.stderr(Stdio::inherit()).output()?;
    if !output.status.success() {
        return Err("codexhost console could not be started".into());
    }
    parse_console_url(&output.stdout).ok_or_else(|| "codexhost console returned no address".into())
}

/// Shows the console for this launch's outcome. A terminal launch prints the
/// address. An installer launch already opened the console before starting
/// Codex Desktop; it opens the overview again only for a problem (`reason`),
/// and after a successful start watches for a persistent Codex UI integration
/// failure.
pub fn show_for_launch(reason: Option<&str>) -> bool {
    if reason.is_none() && launch_presentation() == Some(Presentation::Browser) {
        watch_integration();
        return true;
    }
    show(reason)
}

fn launch_presentation() -> Option<Presentation> {
    LAUNCH_CONSOLE
        .lock()
        .ok()
        .and_then(|slot| slot.as_ref().map(|console| console.presentation))
}

/// Opens the console once if the Desktop Controller of this launch reports a
/// persistent Renderer integration failure, the case in which Codex Desktop
/// runs without codexhost features and the Launcher still reported success.
fn watch_integration() {
    let (Some(status_path), Some(launch_started)) = (
        crate::startup_record::diagnostics_directory()
            .map(|directory| directory.join(CONTROLLER_STATUS_FILE)),
        crate::startup_record::started_at_ms(),
    ) else {
        return;
    };
    thread::spawn(move || {
        loop {
            thread::sleep(INTEGRATION_POLL_INTERVAL);
            let Ok(bytes) = std::fs::read(&status_path) else {
                continue;
            };
            let Ok(document) = serde_json::from_slice::<Value>(&bytes) else {
                continue;
            };
            if integration_failing(&document, launch_started, now_ms()) {
                show(Some("integration-failure"));
                return;
            }
        }
    });
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

/// Same rule as the console: a single early failure recovers on the
/// Controller's next attempt and is not a problem worth interrupting for.
fn integration_failing(document: &Value, launch_started_ms: u64, now_ms: u64) -> bool {
    let started = document["startedAt"].as_u64().unwrap_or(0);
    let renderer = &document["renderer"];
    if started < launch_started_ms || renderer["state"] != "unavailable" {
        return false;
    }
    let failures = renderer["failures"].as_u64().unwrap_or(0);
    let updated = renderer["updatedAt"].as_u64().unwrap_or(now_ms);
    failures >= 2 || now_ms.saturating_sub(updated) >= PERSISTENT_INTEGRATION_FAILURE_MS
}

fn show(reason: Option<&str>) -> bool {
    let (command, presentation, ensure) = {
        let Ok(mut slot) = LAUNCH_CONSOLE.lock() else {
            return false;
        };
        let Some(console) = slot.as_mut() else {
            return false;
        };
        if console.shown && reason.is_none() {
            return true;
        }
        console.shown = true;
        (
            console.command.clone(),
            console.presentation,
            console.ensure.take(),
        )
    };
    if let Some(ensure) = ensure {
        let _ = ensure.join();
    }
    let url = match console_url(&command) {
        Ok(url) => url,
        Err(error) => {
            eprintln!("codexhost launcher: {error}");
            return false;
        }
    };
    match presentation {
        Presentation::Browser => codexhost_platform::open_external_url(&url).is_ok(),
        Presentation::Print => {
            print_url(&url);
            true
        }
    }
}

/// Runs a foreground console command (open or update).
pub fn run(command: &ConsoleCommand, action: &str) -> Result<bool, Box<dyn Error>> {
    let mut process = node_command(command)?;
    process.arg(action);
    Ok(process.status()?.success())
}

pub fn console_command_for(node: &Path, host_runtime: &Path, installed: &Path) -> ConsoleCommand {
    // An npm launch passes the packaged Host Runtime explicitly; its console
    // server sits beside it in the same `app` directory.
    let beside_host_runtime = (host_runtime.file_name()
        == Some(std::ffi::OsStr::new("host-runtime.mjs")))
    .then(|| host_runtime.with_file_name("console-server.mjs"))
    .filter(|path| path.is_file());
    ConsoleCommand {
        node: node.to_path_buf(),
        console_server: beside_host_runtime.unwrap_or_else(|| installed.to_path_buf()),
    }
}

fn desktop_json(installation: &DesktopInstallation, process_ids: &[u32]) -> Value {
    let (platform, identity) = match &installation.identity {
        DesktopIdentity::WindowsPackage {
            package_name,
            package_family_name,
            ..
        } => (
            "windows",
            json!({ "packageName": package_name, "packageFamilyName": package_family_name }),
        ),
        DesktopIdentity::MacOsBundle { bundle_identifier } => {
            ("macos", json!({ "bundleIdentifier": bundle_identifier }))
        }
        DesktopIdentity::LinuxPackage {
            package_name,
            brand,
            flavor,
        } => (
            "linux",
            json!({ "packageName": package_name, "brand": brand, "flavor": flavor }),
        ),
    };
    json!({
        "platform": platform,
        "identity": identity,
        "version": installation.version,
        "build": installation.build,
        "installRoot": installation.install_root.display().to_string(),
        "processIds": process_ids,
    })
}

fn runtime_json() -> Value {
    let Ok(descriptor_path) = default_descriptor_path() else {
        return json!({ "descriptorPath": null, "running": false, "launcherPid": null });
    };
    let descriptor = read_descriptor(&descriptor_path).ok().flatten();
    let running = descriptor.as_ref().is_some_and(|descriptor| {
        endpoint_ready(descriptor.control_port, Duration::from_millis(300))
    });
    json!({
        "descriptorPath": descriptor_path.display().to_string(),
        "running": running,
        "launcherPid": descriptor.as_ref().filter(|_| running).map(|descriptor| descriptor.launcher_pid),
    })
}

/// Machine-readable `inspect`. A missing Codex Desktop is reported in the
/// document rather than as a command failure so the console can show it.
pub fn inspect_json(
    discovered: Result<DesktopInstallation, Box<dyn Error>>,
) -> Result<Value, Box<dyn Error>> {
    let (desktop, desktop_error) = match discovered {
        Ok(installation) => {
            let process_ids =
                codexhost_platform::desktop_process_ids_for_installation(&installation)
                    .unwrap_or_default();
            (desktop_json(&installation, &process_ids), Value::Null)
        }
        Err(error) => (Value::Null, Value::String(error.to_string())),
    };
    Ok(json!({
        "schemaVersion": INSPECT_SCHEMA_VERSION,
        "launcherVersion": env!("CARGO_PKG_VERSION"),
        "launcherExecutable": env::current_exe()?.canonicalize()?.display().to_string(),
        "desktop": desktop,
        "desktopError": desktop_error,
        "runtime": runtime_json(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn terminal_launch_uses_the_address_from_ensure_without_asking_again() {
        use std::os::unix::fs::PermissionsExt;

        let root = env::temp_dir().join(format!("codexhost-console-early-{}", std::process::id()));
        std::fs::create_dir_all(&root).expect("create fixture");
        let console_server = root.join("console-server.mjs");
        std::fs::write(&console_server, "fixture").expect("console entry");
        let calls = root.join("calls");
        let node = root.join("node");
        std::fs::write(
            &node,
            format!(
                "#!/bin/sh\nprintf '%s\\n' \"$2\" >> '{}'\nif [ \"$2\" = ensure ]; then echo 'codexhost console: http://127.0.0.1:26339/'; fi\n",
                calls.display()
            ),
        )
        .expect("fake Node");
        std::fs::set_permissions(&node, std::fs::Permissions::from_mode(0o755))
            .expect("make executable");

        set_presentation(Presentation::Print);
        start_for_launch(ConsoleCommand {
            node,
            console_server,
        });
        let ensure = LAUNCH_CONSOLE
            .lock()
            .expect("console state")
            .as_mut()
            .and_then(|console| console.ensure.take())
            .expect("ensure started");
        ensure.join().expect("ensure finished");
        let shown_early = LAUNCH_CONSOLE
            .lock()
            .expect("console state")
            .as_ref()
            .is_some_and(|console| console.shown);
        let shown_at_ready = show_for_launch(None);
        let calls = std::fs::read_to_string(&calls).unwrap_or_default();
        std::fs::remove_dir_all(&root).expect("remove fixture");

        assert!(shown_early);
        assert!(shown_at_ready);
        assert_eq!(calls, "ensure\n");
    }

    #[test]
    fn console_is_enabled_unless_explicitly_disabled() {
        assert!(console_enabled(None));
        assert!(console_enabled(Some(OsString::from("1"))));
        assert!(!console_enabled(Some(OsString::from("0"))));
    }

    #[test]
    fn reports_only_persistent_integration_failures_of_this_launch() {
        let status = |started: u64, state: &str, failures: u64, updated: u64| {
            json!({
                "schemaVersion": 1,
                "startedAt": started,
                "renderer": { "state": state, "failures": failures, "updatedAt": updated }
            })
        };
        // A single early failure the Controller will retry.
        assert!(!integration_failing(
            &status(100, "unavailable", 1, 150),
            100,
            30_000
        ));
        // Repeated, or lasting a minute.
        assert!(integration_failing(
            &status(100, "unavailable", 2, 150),
            100,
            30_000
        ));
        assert!(integration_failing(
            &status(100, "unavailable", 1, 150),
            100,
            60_150
        ));
        // Recovered, or left by an earlier launch.
        assert!(!integration_failing(
            &status(100, "installed", 3, 150),
            100,
            90_000
        ));
        assert!(!integration_failing(
            &status(50, "unavailable", 3, 60),
            100,
            90_000
        ));
    }

    #[test]
    fn accepts_only_a_loopback_console_address() {
        assert_eq!(
            parse_console_url(
                b"noise\ncodexhost console: http://127.0.0.1:26339/?view=diagnostics\n"
            )
            .as_deref(),
            Some("http://127.0.0.1:26339/?view=diagnostics")
        );
        assert_eq!(
            parse_console_url(b"codexhost console: https://example.com/\n"),
            None
        );
        assert_eq!(parse_console_url(b"nothing"), None);
    }

    #[test]
    fn console_command_falls_back_to_installed_resources() {
        let installed = Path::new("/opt/codexhost/app/console-server.mjs");
        let command = console_command_for(
            Path::new("/usr/bin/node"),
            Path::new("/repo/packages/host-runtime/dist/main.js"),
            installed,
        );
        assert_eq!(command.console_server, installed);
        assert_eq!(command.node, Path::new("/usr/bin/node"));
    }

    #[test]
    fn inspect_json_reports_missing_desktop_without_failing() {
        let document =
            inspect_json(Err("Codex Desktop was not found".into())).expect("inspect document");
        assert_eq!(document["schemaVersion"], 1);
        assert!(document["desktop"].is_null());
        assert_eq!(document["desktopError"], "Codex Desktop was not found");
    }
}
