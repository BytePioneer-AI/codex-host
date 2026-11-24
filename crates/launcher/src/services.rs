//! User-facing startup and shutdown of the independent local services.
use std::env;
use std::error::Error;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::thread::{self, JoinHandle};

static WEB_STARTUP: Mutex<Option<JoinHandle<()>>> = Mutex::new(None);
static WEB_ANNOUNCED: Mutex<bool> = Mutex::new(false);

/// Finish the optional Web startup before the terminal's ready signal. Failures
/// remain independent of Desktop's outcome, and no service is started here.
pub fn finish_launch(print: bool) {
    if let Ok(mut startup) = WEB_STARTUP.lock()
        && let Some(startup) = startup.take()
    {
        let _ = startup.join();
    }
    if !print || !web_enabled() {
        return;
    }
    let Some(data) = data_directory() else {
        return;
    };
    if let Ok(Some(owner)) = web_service::owner(&data)
        && owner.web_running().unwrap_or(false)
        && let Ok(mut announced) = WEB_ANNOUNCED.lock()
        && !*announced
    {
        eprintln!("codexhost web: {}", owner.access.login_url);
        *announced = true;
    }
}

use crate::installation_layout::InstalledResources;
use crate::startup_record::data_directory;
use crate::{
    LaunchOptions, NPM_NODE_PATH_ENV, console, desktop_attachment, desktop_shell, host_service,
    web_service,
};
use codexhost_platform::node_entrypoint_path;
use web_service::Options;

pub fn web_enabled() -> bool {
    env::var_os("CODEXHOST_WEB_SERVICE").as_deref() != Some(std::ffi::OsStr::new("0"))
}

fn resolve_options(
    node: Option<PathBuf>,
    host: Option<PathBuf>,
    web: Option<PathBuf>,
    desktop_root: Option<&Path>,
    host_node: Option<PathBuf>,
) -> Result<Options, Box<dyn Error>> {
    let installed = InstalledResources::from_current_executable()?;
    let explicit_node = node;
    let node = explicit_node
        .clone()
        .or_else(|| env::var_os(NPM_NODE_PATH_ENV).map(PathBuf::from))
        .unwrap_or(installed.node);
    let host_node = match host_node {
        Some(host_node) => host_node,
        None if !cfg!(target_os = "macos") && explicit_node.is_some() => node.clone(),
        None => crate::select_host_node(None, desktop_root, node.clone()),
    };
    Ok(Options {
        node,
        host_node,
        host_runtime: host.unwrap_or(installed.host_runtime),
        runtime: web.unwrap_or(installed.web_runtime),
        data: data_directory().ok_or("User data directory is unavailable")?,
        ready: None,
    })
}

// Called with the Web lifecycle lock held, before GUI clients can connect.
fn replace_outdated(
    options: &Options,
    changed: bool,
    expected_runtime: Option<&Path>,
) -> Result<(), Box<dyn Error>> {
    let host = host_service::current_runtime(&options.data);
    let web = web_service::owner(&options.data)?;
    let host_mismatched = host.as_ref().is_some_and(|(runtime, version)| {
        runtime != &options.host_runtime || version.as_deref() != Some(env!("CARGO_PKG_VERSION"))
    });
    let web_mismatched = web.as_ref().is_some_and(|owner| {
        owner.runtime != options.runtime || owner.version != env!("CARGO_PKG_VERSION")
    });
    if changed || host_mismatched || web_mismatched {
        web_service::stop(options, expected_runtime)?;
    }
    if host_mismatched {
        println!("codexhost: switching Host to this version and installation");
        host_service::run(&options.host_arguments("restart"))?;
    }
    Ok(())
}

fn ensure_current(
    options: &Options,
    settings: &[String],
    update_recovery: bool,
) -> Result<(), Box<dyn Error>> {
    let _guard = host_service::lifecycle_lock(&options.data, "web-service-lifecycle.lock")?;
    crate::service_update::ensure_start_allowed(&options.data)?;
    if update_recovery {
        validate_installation(options)?;
    }
    let changed = if !settings.is_empty() {
        let mut command = Command::new(&options.node);
        host_service::clean(&mut command);
        let status = command
            .arg(node_entrypoint_path(&options.runtime))
            .arg("--save-service-options")
            .arg("--ch-data")
            .arg(&options.data)
            .args(settings)
            .stderr(Stdio::inherit())
            .status()?;
        match status.code() {
            Some(0) => false,
            Some(42) => true,
            _ => return Err("Web settings were not saved".into()),
        }
    } else {
        false
    };
    // Update recovery acts on behalf of the Updater: its orphan handling must
    // be scoped to this installation's runtime, or it could stop an orphan
    // from another installation that stop-for-update deliberately left alone.
    let expected_runtime = update_recovery.then_some(options.runtime.as_path());
    replace_outdated(options, changed, expected_runtime)?;
    web_service::ensure(options, expected_runtime)
}

fn web_browser_url(login_url: &str, connect_devices: bool) -> String {
    if connect_devices {
        format!("{login_url}#connect-devices")
    } else {
        login_url.to_owned()
    }
}

fn open_web(
    options: &Options,
    settings: &[String],
    update_recovery: bool,
    connect_devices: bool,
) -> Result<(), Box<dyn Error>> {
    // Update recovery threads through so orphan cleanup is scoped to this
    // installation's runtime; device connection stays closed on this entry.
    open_web_with(
        options,
        settings,
        update_recovery,
        connect_devices,
        &ensure_current,
    )
}

type EnsureFn<'a> = dyn Fn(&Options, &[String], bool) -> Result<(), Box<dyn Error>> + 'a;

fn open_web_with(
    options: &Options,
    settings: &[String],
    update_recovery: bool,
    connect_devices: bool,
    ensure: &EnsureFn<'_>,
) -> Result<(), Box<dyn Error>> {
    ensure(options, settings, update_recovery)?;
    let ready =
        web_service::owner(&options.data)?.ok_or("Web exited before its address could be read")?;
    println!("codexhost web: {}", ready.access.login_url);
    if let Ok(mut announced) = WEB_ANNOUNCED.lock() {
        *announced = true;
    }
    println!("Web is running in the background; use `codexhost stop` to stop it");
    if graphical_session() {
        codexhost_platform::open_external_url(&web_browser_url(
            &ready.access.login_url,
            connect_devices,
        ))?;
    }
    Ok(())
}

pub fn graphical_session() -> bool {
    env::var_os("SSH_CONNECTION").is_none()
        && env::var_os("SSH_TTY").is_none()
        && (!cfg!(target_os = "linux")
            || env::var_os("DISPLAY").is_some_and(|value| !value.is_empty())
            || env::var_os("WAYLAND_DISPLAY").is_some_and(|value| !value.is_empty()))
}

pub fn open_for_launch(options: &LaunchOptions, open_browser: bool) -> Result<(), Box<dyn Error>> {
    let resolved = resolve_options(
        options.node.clone(),
        options.host_runtime.clone(),
        options.web_runtime.clone(),
        None,
        options.node.clone(),
    )?;
    if open_browser {
        open_web(&resolved, &[], options.update_recovery, false)
    } else {
        ensure_current(&resolved, &[], options.update_recovery)
    }
}

fn select_app_shell(
    shell: Option<&Path>,
    onboarding: bool,
    graphical: bool,
) -> Result<Option<&Path>, &'static str> {
    if !graphical {
        if onboarding {
            return Err("Desktop shell onboarding requires a graphical session");
        }
        return Ok(None);
    }
    if onboarding && shell.is_none() {
        return Err("The codexhost desktop shell is required for onboarding");
    }
    Ok(shell)
}

pub fn open_app(shell: Option<&Path>, onboarding: bool) -> Result<(), Box<dyn Error>> {
    let Some(shell) = select_app_shell(shell, onboarding, graphical_session())? else {
        return open_for_launch(&crate::default_launch_options(), true);
    };
    let data = data_directory().ok_or("User data directory is unavailable")?;
    if onboarding {
        crate::service_update::ensure_start_allowed(&data)?;
    } else {
        open_for_launch(&crate::default_launch_options(), false)?;
    }
    desktop_shell::spawn(shell, &data, onboarding)
}

// LaunchServices may reparent Desktop, so its bridge cannot rely on Updater ancestry.
pub fn prepare_host_for_update(
    options: &LaunchOptions,
    desktop_root: Option<&Path>,
) -> Result<(), Box<dyn Error>> {
    let resolved = resolve_options(
        options.node.clone(),
        options.host_runtime.clone(),
        options.web_runtime.clone(),
        desktop_root,
        options.node.clone(),
    )?;
    let _guard = host_service::lifecycle_lock(&resolved.data, "web-service-lifecycle.lock")?;
    validate_installation(&resolved)?;
    host_service::run(&resolved.host_arguments("ensure"))
}

fn record_failure(error: &dyn std::fmt::Display) {
    if let Some(data) = data_directory() {
        let _ = fs::create_dir_all(&data);
        let _ = host_service::publish_status(&data.join(web_service::FAILURE), &error.to_string());
    }
}

pub fn start_for_launch(options: &LaunchOptions, desktop_root: Option<&Path>) {
    let prepare = || -> Result<Options, Box<dyn Error>> {
        let resolved = resolve_options(
            options.node.clone(),
            options.host_runtime.clone(),
            options.web_runtime.clone(),
            desktop_root,
            options.node.clone(),
        )?;
        let _guard = host_service::lifecycle_lock(&resolved.data, "web-service-lifecycle.lock")?;
        crate::service_update::ensure_start_allowed(&resolved.data)?;
        // Update recovery acts on behalf of the Updater: its orphan handling
        // must be scoped to this installation's runtime on every branch that
        // may stop a Web, or it could terminate an orphan that stop-for-update
        // deliberately left alone.
        let expected_runtime = options
            .update_recovery
            .then_some(resolved.runtime.as_path());
        replace_outdated(&resolved, false, expected_runtime)?;
        Ok(resolved)
    };
    let resolved = match prepare() {
        Ok(options) => options,
        Err(error) => {
            record_failure(&error);
            return;
        }
    };
    let update_recovery = options.update_recovery;
    let startup = thread::spawn(move || {
        let start = || -> Result<(), Box<dyn Error>> {
            let _guard =
                host_service::lifecycle_lock(&resolved.data, "web-service-lifecycle.lock")?;
            crate::service_update::ensure_start_allowed(&resolved.data)?;
            let expected_runtime = update_recovery.then_some(resolved.runtime.as_path());
            web_service::ensure(&resolved, expected_runtime)
        };
        if let Err(error) = start() {
            record_failure(&error);
        }
    });
    if let Ok(mut slot) = WEB_STARTUP.lock() {
        *slot = Some(startup);
    }
}

fn validate_web_and_host_installation(options: &Options) -> Result<(), Box<dyn Error>> {
    if let Some((runtime, _)) = host_service::current_runtime(&options.data) {
        let runtime = runtime
            .canonicalize()
            .map_err(|error| format!("Host: canonicalizing runtime failed: {error}"))?;
        let expected = options
            .host_runtime
            .canonicalize()
            .map_err(|error| format!("Host: canonicalizing host runtime failed: {error}"))?;
        if runtime != expected {
            return Err("The running Host belongs to a different installation".into());
        }
    }
    if let Some(owner) = web_service::owner(&options.data)? {
        let runtime = owner
            .runtime
            .canonicalize()
            .map_err(|error| format!("Web: canonicalizing running Web runtime failed: {error}"))?;
        let expected = options.runtime.canonicalize().map_err(|error| {
            format!("Web: canonicalizing configured Web runtime failed: {error}")
        })?;
        if runtime != expected {
            return Err("The running Web belongs to a different installation".into());
        }
    }
    Ok(())
}

fn validate_installation(options: &Options) -> Result<(), Box<dyn Error>> {
    validate_web_and_host_installation(options)?;
    desktop_attachment::running_for_update(&options.data)
        .map_err(|error| format!("Desktop ownership check failed: {error}"))?;
    Ok(())
}

fn stop_for_update(options: &Options) -> Result<(), Box<dyn Error>> {
    validate_installation(options)?;
    desktop_shell::stop(&options.data)
        .map_err(|error| format!("stopping desktop shell failed: {error}"))?;
    // Stop Desktop before taking web-service-lifecycle.lock: the Launcher joins its
    // background Web startup thread before exiting, and that thread waits on the same lock.
    desktop_attachment::stop_managed(&options.data)
        .map_err(|error| format!("stopping Desktop failed: {error}"))?;
    let _guard = host_service::lifecycle_lock(&options.data, "web-service-lifecycle.lock")?;
    validate_web_and_host_installation(options)?;
    // The orphan cleanup must apply the installation check to the record it
    // actually cleans: validate_installation only inspects the live owner
    // record, so a Web from another installation sharing this data directory
    // would otherwise be terminated here.
    web_service::stop(options, Some(&options.runtime))
        .map_err(|error| format!("stopping Web failed: {error}"))?;
    if host_service::current_runtime(&options.data).is_some() {
        host_service::run(&options.host_arguments("stop"))
            .map_err(|error| format!("stopping Host failed: {error}"))?;
    }
    Ok(())
}

fn stop_all(options: &Options) -> Result<(), Box<dyn Error>> {
    #[cfg(not(target_os = "windows"))]
    let home = PathBuf::from(env::var_os("HOME").ok_or("HOME is unavailable")?);
    let mut failures = Vec::new();
    let mut running = false;
    match desktop_shell::stop(&options.data) {
        Ok(stopped) => running |= stopped,
        Err(error) => failures.push(format!("Desktop shell: {error}")),
    }
    match desktop_attachment::stop_managed(&options.data) {
        Ok(stopped) => running |= stopped,
        Err(error) => failures.push(format!("GUI: {error}")),
    }
    let web_lock = host_service::lifecycle_lock(&options.data, "web-service-lifecycle.lock");
    let web = match &web_lock {
        Ok(_) => web_service::stop(options, None),
        Err(error) => Err(error.to_string().into()),
    };
    match web {
        Ok(stopped) => running |= stopped,
        Err(error) => failures.push(format!("Web: {error}")),
    }
    let host_running = host_service::current_runtime(&options.data).is_some();
    running |= host_running;
    if host_running && let Err(error) = host_service::run(&options.host_arguments("stop")) {
        failures.push(format!("Host: {error}"));
    }
    #[cfg(not(target_os = "windows"))]
    {
        if home.join(".codexhost/remote/manifest.json").is_file() {
            let remote = || -> Result<bool, Box<dyn Error>> {
                let output = Command::new(&options.host_node)
                    .arg(node_entrypoint_path(&options.host_runtime))
                    .args(["--codexhost-remote", "stop"])
                    .output()?;
                if !output.status.success() {
                    return Err(format!(
                        "stop failed ({}): {}",
                        output.status,
                        String::from_utf8_lossy(&output.stderr)
                    )
                    .into());
                }
                #[derive(serde::Deserialize)]
                struct Stopped {
                    changed: bool,
                }
                Ok(serde_json::from_slice::<Stopped>(&output.stdout)?.changed)
            };
            match remote() {
                Ok(true) => {
                    running = true;
                    println!(
                        "Remote service stopped; reconnect from the other computer to restore it"
                    );
                }
                Ok(false) => {}
                Err(error) => failures.push(format!("Remote: {error}")),
            }
        }
        #[cfg(target_os = "macos")]
        match crate::native_harness_broker::stop_installed_brokers(
            &home,
            &options.host_node,
            &options.host_runtime,
        ) {
            Ok(stopped) => running |= stopped,
            Err(error) => failures.push(format!("Broker: {error}")),
        }
    }
    let installed = InstalledResources::from_current_executable()?;
    match console::stop(&console::console_command_for(
        &options.node,
        &options.host_runtime,
        &installed.console_server,
    )) {
        Ok(stopped) => running |= stopped,
        Err(error) => failures.push(format!("Console: {error}")),
    }
    if !failures.is_empty() {
        return Err(failures.join("\n").into());
    }
    println!(
        "{}",
        if running {
            "codexhost services stopped"
        } else {
            "No codexhost services are running"
        }
    );
    Ok(())
}

pub fn run(action: &str, arguments: &[String]) -> Result<(), Box<dyn Error>> {
    if action == "status" {
        if !arguments.is_empty() {
            return Err("status accepts no arguments".into());
        }
        let data = data_directory().ok_or("User data directory is unavailable")?;
        match host_service::current_runtime(&data) {
            Some((_, version)) => println!(
                "Host: running; version {}",
                version.as_deref().unwrap_or("unknown")
            ),
            None => println!("Host: stopped"),
        }
        match web_service::owner(&data)? {
            Some(owner) => {
                // A failed presence query is not an exit: report the status as
                // unknown instead of showing a live Web as stopped.
                let state = match owner.web_running() {
                    Ok(true) => "running".to_string(),
                    Ok(false) => "stopped".to_string(),
                    Err(error) => format!("status unknown ({error})"),
                };
                println!(
                    "Web: {state}; version {}; {}",
                    owner.version, owner.access.address
                );
            }
            None => println!("Web: stopped"),
        }
        match fs::read_to_string(data.join(web_service::FAILURE)) {
            Ok(reason) => println!("Web last failure: {reason}"),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        println!("Autostart: {}", crate::autostart::status_line());
        return Ok(());
    }
    let mut node = None;
    let mut host = None;
    let mut web = None;
    let mut data = None;
    let mut settings = Vec::new();
    let mut background = false;
    let mut connect_devices = false;
    let mut update_recovery = false;
    let mut arguments = arguments.iter();
    while let Some(option) = arguments.next() {
        if option == "--background" && action == "web" {
            background = true;
            continue;
        }
        if option == "--connect-devices" && action == "web" {
            connect_devices = true;
            continue;
        }
        if option == "--update-recovery" && action == "web" {
            update_recovery = true;
            continue;
        }
        let value = arguments
            .next()
            .ok_or_else(|| format!("{option} requires a value"))?;
        let path = PathBuf::from(value);
        if matches!(
            option.as_str(),
            "--node" | "--host-runtime" | "--web-runtime" | "--data"
        ) && !path.is_absolute()
        {
            return Err(format!("{option} must be absolute").into());
        }
        match option.as_str() {
            "--node" => node = Some(path),
            "--host-runtime" => host = Some(path),
            "--web-runtime" => web = Some(path),
            "--data" if action == "stop-for-update" || action == "web" => data = Some(path),
            "--host" | "--port" | "--public-url" | "--trusted-proxy" | "--relay"
                if action == "web" =>
            {
                settings.extend([option.clone(), value.clone()])
            }
            _ => return Err(format!("Unknown {action} option: {option}").into()),
        }
    }
    if update_recovery && !background {
        return Err("--update-recovery requires --background".into());
    }
    let desktop = if action == "web" {
        Some(crate::discover_desktop(None))
    } else {
        None
    };
    let desktop_root = desktop
        .as_ref()
        .and_then(|result| result.as_ref().ok())
        .map(|desktop| desktop.install_root.as_path());
    let mut options = resolve_options(node, host, web, desktop_root, None)?;
    if let Some(data) = data {
        options.data = data;
    }
    if action == "web" {
        crate::autostart::refresh();
        if background {
            let result = ensure_current(&options, &settings, update_recovery);
            if let Err(error) = &result {
                record_failure(error);
            }
            result
        } else {
            open_web(&options, &settings, update_recovery, connect_devices)
        }
    } else if action == "stop-for-update" {
        stop_for_update(&options)
    } else {
        stop_all(&options)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(target_os = "windows")]
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn finishing_without_output_waits_for_web_startup() {
        let (done, completed) = std::sync::mpsc::channel();
        *WEB_STARTUP.lock().unwrap() = Some(thread::spawn(move || {
            thread::sleep(std::time::Duration::from_millis(30));
            done.send(()).unwrap();
        }));
        finish_launch(false);
        completed
            .try_recv()
            .expect("startup completed before returning");
        assert!(WEB_STARTUP.lock().unwrap().is_none());
        assert!(
            !*WEB_ANNOUNCED.lock().unwrap(),
            "joining must not announce Web"
        );
    }

    #[test]
    fn open_web_recovery_forwards_update_recovery_without_device_connection() {
        let root = env::temp_dir().join(format!("codexhost-open-web-flags-{}", std::process::id()));
        let options = Options {
            node: root.clone(),
            host_node: root.clone(),
            runtime: root.clone(),
            host_runtime: root.clone(),
            data: root.clone(),
            ready: None,
        };
        let captured = Mutex::new(None);
        let ensure = |_: &Options, settings: &[String], update_recovery: bool| {
            *captured.lock().unwrap() = Some((settings.to_vec(), update_recovery));
            Ok(())
        };
        // Recovery launch: ensure must see update_recovery=true, and the
        // device-connection page must stay closed (connect_devices=false).
        let result = open_web_with(&options, &[], true, false, &ensure);
        assert_eq!(
            captured
                .lock()
                .unwrap()
                .as_ref()
                .map(|(s, r)| (s.as_slice(), *r)),
            Some((&[][..], true)),
            "ensure_current must receive update_recovery=true on the recovery path"
        );
        assert!(result.is_err());
        // Plain interactive launch keeps device connection opt-in.
        let ensure = |_: &Options, _: &[String], update_recovery: bool| {
            assert!(!update_recovery, "plain launch is not update recovery");
            Ok(())
        };
        assert!(open_web_with(&options, &[], false, true, &ensure).is_err());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn headless_app_uses_web_even_with_a_shell_and_rejects_onboarding() {
        let shell = Some(Path::new("codexhost-shell"));
        assert_eq!(select_app_shell(shell, false, false), Ok(None));
        assert_eq!(
            select_app_shell(shell, true, false),
            Err("Desktop shell onboarding requires a graphical session")
        );
        assert_eq!(select_app_shell(shell, false, true), Ok(shell));
    }

    #[test]
    fn web_browser_url_only_appends_the_requested_section() {
        let login = "http://127.0.0.1:4478/?token=fixture-secret";
        assert_eq!(web_browser_url(login, false), login);
        assert_eq!(
            web_browser_url(login, true),
            "http://127.0.0.1:4478/?token=fixture-secret#connect-devices"
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn npm_node_is_shared_with_host_when_launch_options_omit_node() {
        const TEST: &str =
            "services::tests::npm_node_is_shared_with_host_when_launch_options_omit_node";
        if let Some(npm_node) = env::var_os("CODEXHOST_NPM_NODE_TEST") {
            let npm_node = PathBuf::from(npm_node);
            let options = resolve_options(None, None, None, None, None).unwrap();
            assert_eq!(options.node, npm_node);
            assert_eq!(options.host_node, npm_node);

            let explicit = PathBuf::from(r"C:\explicit\node.exe");
            let explicit_options =
                resolve_options(Some(explicit.clone()), None, None, None, None).unwrap();
            assert_eq!(explicit_options.node, explicit);
            assert_eq!(explicit_options.host_node, explicit);
            return;
        }

        let root = env::temp_dir().join(format!(
            "codexhost-service-npm-node-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        let npm_node = root.join("node.exe");
        fs::write(&npm_node, "fixture").unwrap();
        let status = Command::new(env::current_exe().unwrap())
            .args(["--exact", TEST])
            .env("CODEXHOST_NPM_NODE_TEST", &npm_node)
            .env(NPM_NODE_PATH_ENV, &npm_node)
            .status()
            .unwrap();
        fs::remove_dir_all(root).unwrap();
        assert!(status.success());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn web_uses_its_node_while_host_matches_the_gui_node_selection() {
        let root = env::temp_dir().join(format!("codexhost-service-nodes-{}", std::process::id()));
        let desktop_node = root.join("Contents/Resources/cua_node/bin/node");
        fs::create_dir_all(desktop_node.parent().unwrap()).unwrap();
        fs::write(&desktop_node, "fixture").unwrap();
        let web_node = root.join("npm-node");
        fs::write(&web_node, "fixture").unwrap();
        let options =
            resolve_options(Some(web_node.clone()), None, None, Some(&root), None).unwrap();
        assert_eq!(options.node, web_node);
        assert_eq!(options.host_node, desktop_node);
        assert_eq!(
            options.host_node,
            crate::select_host_node(None, Some(&root), web_node.clone())
        );
        assert_eq!(
            options.host_arguments("ensure")[2],
            desktop_node.to_string_lossy()
        );
        let without_desktop =
            resolve_options(Some(web_node.clone()), None, None, None, None).unwrap();
        assert_eq!(without_desktop.host_node, web_node);
        fs::remove_dir_all(root).unwrap();
    }
}
