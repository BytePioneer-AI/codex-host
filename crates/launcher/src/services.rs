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
        && owner.web_running()
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
    LaunchOptions, NPM_NODE_PATH_ENV, console, desktop_attachment, host_service, web_service,
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
    let host_node = crate::select_host_node(
        host_node,
        desktop_root,
        node.clone().unwrap_or(installed.node.clone()),
    );
    Ok(Options {
        node: node
            .or_else(|| env::var_os(NPM_NODE_PATH_ENV).map(PathBuf::from))
            .unwrap_or(installed.node),
        host_node,
        host_runtime: host.unwrap_or(installed.host_runtime),
        runtime: web.unwrap_or(installed.web_runtime),
        data: data_directory().ok_or("User data directory is unavailable")?,
        ready: None,
    })
}

// Called with the Web lifecycle lock held, before GUI clients can connect.
fn replace_outdated(options: &Options, changed: bool) -> Result<(), Box<dyn Error>> {
    let host = host_service::current_runtime(&options.data);
    let web = web_service::owner(&options.data)?;
    let host_mismatched = host.as_ref().is_some_and(|(runtime, version)| {
        runtime != &options.host_runtime || version.as_deref() != Some(env!("CARGO_PKG_VERSION"))
    });
    let web_mismatched = web.as_ref().is_some_and(|owner| {
        owner.runtime != options.runtime || owner.version != env!("CARGO_PKG_VERSION")
    });
    if changed || host_mismatched || web_mismatched {
        web_service::stop(options)?;
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
    replace_outdated(options, changed)?;
    web_service::ensure(options)
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
    connect_devices: bool,
) -> Result<(), Box<dyn Error>> {
    ensure_current(options, settings, false)?;
    let ready =
        web_service::owner(&options.data)?.ok_or("Web exited before its address could be read")?;
    println!("codexhost web: {}", ready.access.login_url);
    println!("Web is running in the background; use `codexhost stop` to stop it");
    let graphical = env::var_os("SSH_CONNECTION").is_none()
        && env::var_os("SSH_TTY").is_none()
        && (!cfg!(target_os = "linux")
            || env::var_os("DISPLAY").is_some()
            || env::var_os("WAYLAND_DISPLAY").is_some());
    if graphical {
        codexhost_platform::open_external_url(&web_browser_url(
            &ready.access.login_url,
            connect_devices,
        ))?;
    }
    Ok(())
}

pub fn open_for_launch(options: &LaunchOptions) -> Result<(), Box<dyn Error>> {
    let resolved = resolve_options(
        options.node.clone(),
        options.host_runtime.clone(),
        options.web_runtime.clone(),
        None,
        options.node.clone(),
    )?;
    if console::presentation() == Some(console::Presentation::Print) {
        ensure_current(&resolved, &[], false)
    } else {
        open_web(&resolved, &[], false)
    }
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
        replace_outdated(&resolved, false)?;
        Ok(resolved)
    };
    let resolved = match prepare() {
        Ok(options) => options,
        Err(error) => {
            record_failure(&error);
            return;
        }
    };
    let startup = thread::spawn(move || {
        let start = || -> Result<(), Box<dyn Error>> {
            let _guard =
                host_service::lifecycle_lock(&resolved.data, "web-service-lifecycle.lock")?;
            web_service::ensure(&resolved)
        };
        if let Err(error) = start() {
            record_failure(&error);
        }
    });
    if let Ok(mut slot) = WEB_STARTUP.lock() {
        *slot = Some(startup);
    }
}

fn validate_installation(options: &Options) -> Result<(), Box<dyn Error>> {
    if let Some((runtime, _)) = host_service::current_runtime(&options.data)
        && runtime.canonicalize()? != options.host_runtime.canonicalize()?
    {
        return Err("The running Host belongs to a different installation".into());
    }
    if let Some(owner) = web_service::owner(&options.data)?
        && owner.runtime.canonicalize()? != options.runtime.canonicalize()?
    {
        return Err("The running Web belongs to a different installation".into());
    }
    if let Some((launcher, _)) = desktop_attachment::managed_processes(&options.data)?
        && launcher.executable.canonicalize()? != env::current_exe()?.canonicalize()?
    {
        return Err("The running Desktop belongs to a different installation".into());
    }
    Ok(())
}

fn stop_for_update(options: &Options) -> Result<(), Box<dyn Error>> {
    let _guard = host_service::lifecycle_lock(&options.data, "web-service-lifecycle.lock")?;
    validate_installation(options)?;
    desktop_attachment::stop_managed(&options.data)?;
    web_service::stop(options)?;
    if host_service::current_runtime(&options.data).is_some() {
        host_service::run(&options.host_arguments("stop"))?;
    }
    Ok(())
}

fn stop_all(options: &Options) -> Result<(), Box<dyn Error>> {
    #[cfg(not(target_os = "windows"))]
    let home = PathBuf::from(env::var_os("HOME").ok_or("HOME is unavailable")?);
    let mut failures = Vec::new();
    let mut running = false;
    match desktop_attachment::stop_managed(&options.data) {
        Ok(stopped) => running |= stopped,
        Err(error) => failures.push(format!("GUI: {error}")),
    }
    let web_lock = host_service::lifecycle_lock(&options.data, "web-service-lifecycle.lock");
    let web = match &web_lock {
        Ok(_) => web_service::stop(options),
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
            Some(owner) => println!(
                "Web: {}; version {}; {}",
                if owner.web_running() {
                    "running"
                } else {
                    "stopped"
                },
                owner.version,
                owner.access.address
            ),
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
            open_web(&options, &settings, connect_devices)
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
    fn web_browser_url_only_appends_the_requested_section() {
        let login = "http://127.0.0.1:4478/?token=fixture-secret";
        assert_eq!(web_browser_url(login, false), login);
        assert_eq!(
            web_browser_url(login, true),
            "http://127.0.0.1:4478/?token=fixture-secret#connect-devices"
        );
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
