//! Restore the requested interface and verify the services belonging to this installation.
use std::error::Error;
use std::fs;
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use codexhost_platform::{
    ProcessIdentity, configure_background_command, process_identity, process_snapshot,
};
use serde::{Deserialize, de::DeserializeOwned};

use crate::request::{Installation, RestartTarget, UpdateRequest};

const RELAUNCH_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_DESCRIPTOR_BYTES: u64 = 16 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DesktopDescriptor {
    schema_version: u8,
    launcher_pid: u32,
    control_port: u16,
    nonce: String,
}

#[derive(Deserialize)]
struct ServiceOwner {
    pid: u32,
    started_at_micros: u64,
    executable: PathBuf,
    runtime: PathBuf,
    version: String,
}

#[derive(Deserialize)]
struct WebOwner {
    #[serde(flatten)]
    owner: ServiceOwner,
    web_pid: u32,
    address: String,
}

fn read_descriptor<T: DeserializeOwned>(path: &Path) -> Result<Option<T>, Box<dyn Error>> {
    match fs::symlink_metadata(path) {
        Ok(metadata)
            if metadata.is_file()
                && !metadata.file_type().is_symlink()
                && metadata.len() <= MAX_DESCRIPTOR_BYTES =>
        {
            Ok(Some(serde_json::from_slice(&fs::read(path)?)?))
        }
        Ok(_) => Err(format!(
            "service descriptor is not a bounded regular file: {}",
            path.display()
        )
        .into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn matches_owner(
    owner: &ServiceOwner,
    expected_runtime: &Path,
    expected_version: Option<&str>,
    live: Option<&ProcessIdentity>,
) -> bool {
    same_path(&owner.runtime, expected_runtime)
        && !owner.version.is_empty()
        && expected_version.is_none_or(|version| owner.version == version)
        && live.is_some_and(|live| {
            live.id == owner.pid && live.started_at_micros == owner.started_at_micros
        })
}

fn same_path(left: &Path, right: &Path) -> bool {
    crate::same_executable(
        &left.canonicalize().unwrap_or_else(|_| left.to_path_buf()),
        &right.canonicalize().unwrap_or_else(|_| right.to_path_buf()),
    )
}

fn connects(address: SocketAddr) -> bool {
    TcpStream::connect_timeout(&address, Duration::from_millis(300)).is_ok()
}

fn verify_available_services(request: &UpdateRequest) -> Result<(), Box<dyn Error>> {
    let data = request
        .data_directory
        .clone()
        .or_else(|| std::env::var_os("CODEXHOST_DATA_DIR").map(PathBuf::from))
        .or_else(|| {
            std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
                .map(|home| PathBuf::from(home).join(".codexhost"))
        });
    if let Some(data) = data {
        let app = request.installation.resources_root().join("app");
        for (file, runtime) in [
            ("shared-host-ready.json", "host-runtime.mjs"),
            ("web-service-ready.json", "web-server.mjs"),
        ] {
            if let Some(owner) = read_descriptor::<ServiceOwner>(&data.join(file))?
                && matches_owner(
                    &owner,
                    &owner.runtime,
                    None,
                    process_identity(owner.pid).ok().as_ref(),
                )
                && !same_path(&owner.runtime, &app.join(runtime))
            {
                return Err(
                    "another installation owns the running services; recovery was not started"
                        .into(),
                );
            }
        }
    }
    if let Some(descriptor) =
        read_descriptor::<DesktopDescriptor>(&request.runtime_descriptor_path)?
        && let Ok(live) = process_snapshot(descriptor.launcher_pid)
        && !same_path(&live.executable, &request.installation.launcher_path())
    {
        return Err(
            "another installation owns the running Desktop; recovery was not started".into(),
        );
    }
    Ok(())
}

fn web_listening(address: &str) -> bool {
    address
        .strip_prefix("http://")
        .and_then(|address| address.trim_end_matches('/').to_socket_addrs().ok())
        .is_some_and(|addresses| addresses.into_iter().any(connects))
}

fn services_ready(
    request: &UpdateRequest,
    expected_version: Option<&str>,
    require_web: bool,
    snapshot: impl Fn(u32) -> Option<ProcessIdentity>,
    listening: impl Fn(&str) -> bool,
) -> Result<bool, Box<dyn Error>> {
    let Some(data) = &request.data_directory else {
        return Ok(true);
    };
    let app = request.installation.resources_root().join("app");
    let Some(host) = read_descriptor::<ServiceOwner>(&data.join("shared-host-ready.json"))? else {
        return Ok(false);
    };
    if !matches_owner(
        &host,
        &app.join("host-runtime.mjs"),
        expected_version,
        snapshot(host.pid).as_ref(),
    ) {
        return Ok(false);
    }
    if !require_web {
        return Ok(true);
    }
    let Some(web) = read_descriptor::<WebOwner>(&data.join("web-service-ready.json"))? else {
        return Ok(false);
    };
    Ok(matches_owner(
        &web.owner,
        &app.join("web-server.mjs"),
        expected_version,
        snapshot(web.owner.pid).as_ref(),
    ) && same_path(&web.owner.executable, &request.installation.launcher_path())
        && web.owner.version == host.version
        && snapshot(web.web_pid).is_some_and(|child| child.parent_id == web.owner.pid)
        && listening(&web.address))
}

fn desktop_ready(request: &UpdateRequest) -> Result<bool, Box<dyn Error>> {
    let Some(descriptor) = read_descriptor::<DesktopDescriptor>(&request.runtime_descriptor_path)?
    else {
        return Ok(false);
    };
    if descriptor.schema_version != 1
        || descriptor.launcher_pid == 0
        || descriptor.control_port == 0
        || descriptor.nonce.len() != 32
        || !descriptor
            .nonce
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err("runtime descriptor is invalid".into());
    }
    let Some(launcher) = process_snapshot(descriptor.launcher_pid).ok() else {
        return Ok(false);
    };
    if descriptor.launcher_pid == request.wait_pid {
        return Ok(false);
    }
    // Legacy requests predate service ownership records and retain their existing probe.
    if request.data_directory.is_none() {
        return Ok(true);
    }
    Ok(
        same_path(&launcher.executable, &request.installation.launcher_path())
            && connects(SocketAddr::from(([127, 0, 0, 1], descriptor.control_port))),
    )
}

// An explicit --node overrides Host Node selection, which prefers Desktop's Node on macOS.
fn pass_npm_node(command: &mut Command, request: &UpdateRequest) {
    if let Installation::Npm(npm) = &request.installation {
        command.arg("--node").arg(&npm.node_path);
    }
}

fn command(request: &UpdateRequest) -> Command {
    let mut command = if request.restart_target == RestartTarget::Web {
        let mut command = Command::new(request.installation.launcher_path());
        command.args(["web", "--background", "--update-recovery"]);
        pass_npm_node(&mut command, request);
        command.arg("--data").arg(
            request
                .data_directory
                .as_ref()
                .expect("validated Web data directory"),
        );
        command
    } else if request.data_directory.is_some() {
        let mut command = Command::new(request.installation.launcher_path());
        command.args(["launch", "--update-recovery"]);
        pass_npm_node(&mut command, request);
        command
    } else {
        match &request.installation {
            Installation::Npm(npm) => {
                let mut command = Command::new(&npm.node_path);
                command.arg(&npm.npm_launcher_path);
                command
            }
            Installation::WindowsInstaller(windows) => {
                Command::new(windows.install_root.join("bin/codexhost-start.exe"))
            }
            Installation::MacosDmg(macos) => {
                let mut command = Command::new("/usr/bin/open");
                command.arg(&macos.app_path);
                command
            }
        }
    };
    if let Some(data) = &request.data_directory {
        command.env("CODEXHOST_DATA_DIR", data);
    }
    if let Installation::Npm(npm) = &request.installation {
        command
            .env("CODEXHOST_NPM_NODE_PATH", &npm.node_path)
            .env("CODEXHOST_NPM_CLI_PATH", &npm.npm_cli_path)
            .env("CODEXHOST_NPM_LAUNCHER_PATH", &npm.npm_launcher_path)
            .env("CODEXHOST_NPM_PACKAGE_ROOT", &npm.npm_package_root);
    }
    configure_background_command(&mut command);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    command
}

pub(crate) fn restore(
    request: &UpdateRequest,
    expected_version: Option<&str>,
) -> Result<(), Box<dyn Error>> {
    verify_available_services(request)?;
    let mut child = command(request).spawn()?;
    let require_web = request.restart_target == RestartTarget::Web
        || std::env::var_os("CODEXHOST_WEB_SERVICE").as_deref() != Some(std::ffi::OsStr::new("0"));
    let started = Instant::now();
    while started.elapsed() < RELAUNCH_TIMEOUT {
        if let Some(status) = child.try_wait()?
            && !status.success()
        {
            return Err(format!("codexhost restart exited with {status}").into());
        }
        if (request.restart_target == RestartTarget::Web || desktop_ready(request)?)
            && services_ready(
                request,
                expected_version,
                require_web,
                |pid| process_identity(pid).ok(),
                web_listening,
            )?
        {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(100));
    }
    Err("codexhost services did not become ready after restart".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_stale_or_wrong_installation_service_owners() {
        let runtime = PathBuf::from("/fixture/app/host-runtime.mjs");
        let owner = ServiceOwner {
            pid: 42,
            started_at_micros: 10,
            executable: PathBuf::from("/fixture/node"),
            runtime: runtime.clone(),
            version: "1.2.3".into(),
        };
        let mut live = ProcessIdentity {
            id: 42,
            parent_id: 1,
            started_at_micros: 10,
        };
        assert!(matches_owner(&owner, &runtime, Some("1.2.3"), Some(&live)));
        assert!(!matches_owner(&owner, &runtime, Some("1.2.4"), Some(&live)));
        assert!(!matches_owner(
            &owner,
            Path::new("/other/app/host-runtime.mjs"),
            None,
            Some(&live)
        ));
        assert!(matches_owner(&owner, &runtime, None, Some(&live)));
        live.started_at_micros = 11;
        assert!(!matches_owner(&owner, &runtime, None, Some(&live)));
        assert!(!matches_owner(&owner, &runtime, None, None));
    }

    #[test]
    fn restart_commands_preserve_target_environment_and_legacy_entrypoint() {
        let root = std::env::temp_dir().join("codexhost-restart-command");
        let mut request: UpdateRequest = serde_json::from_value(serde_json::json!({
            "schema_version": 1, "version": "1.2.3", "wait_pid": 1,
            "wait_executable": root.join("node"), "runtime_descriptor_path": root.join("desktop.json"),
            "status_path": root.join("status.json"), "restart_target": "web", "data_directory": root.join("data"),
            "installation": {"kind":"npm", "node_path":root.join("node"), "npm_cli_path":root.join("npm.js"), "npm_launcher_path":root.join("wrapper.js"), "npm_package_root":root.join("package")}
        })).unwrap();
        let command = command(&request);
        assert_eq!(command.get_program(), request.installation.launcher_path());
        let args = command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert_eq!(&args[..2], ["web", "--background"]);
        assert_eq!(args[2], "--update-recovery");
        assert_eq!(
            &args[args.len() - 2..],
            [
                "--data".to_owned(),
                root.join("data").to_string_lossy().into_owned()
            ]
        );
        assert!(
            command
                .get_envs()
                .any(|(key, value)| key == "CODEXHOST_DATA_DIR"
                    && value == Some(root.join("data").as_os_str()))
        );
        for key in [
            "CODEXHOST_NPM_NODE_PATH",
            "CODEXHOST_NPM_CLI_PATH",
            "CODEXHOST_NPM_LAUNCHER_PATH",
            "CODEXHOST_NPM_PACKAGE_ROOT",
        ] {
            assert!(
                command
                    .get_envs()
                    .any(|(name, value)| name == key && value.is_some())
            );
        }
        request.restart_target = RestartTarget::Desktop;
        let desktop = super::command(&request);
        assert_eq!(desktop.get_program(), request.installation.launcher_path());
        assert_eq!(
            desktop.get_args().collect::<Vec<_>>(),
            [
                std::ffi::OsStr::new("launch"),
                std::ffi::OsStr::new("--update-recovery"),
                std::ffi::OsStr::new("--node"),
                root.join("node").as_os_str(),
            ]
        );
        let packaged: UpdateRequest = serde_json::from_value(serde_json::json!({
            "schema_version": 1, "version": "1.2.3", "wait_pid": 1,
            "wait_executable": root.join("node"), "runtime_descriptor_path": root.join("desktop.json"),
            "status_path": root.join("status.json"), "data_directory": root.join("data"),
            "installation": {"kind":"macos-dmg", "dmg_path":root.join("a.dmg"), "artifact_sha256":"0".repeat(64), "app_path":root.join("codexhost.app")}
        })).unwrap();
        assert_eq!(
            super::command(&packaged).get_args().collect::<Vec<_>>(),
            ["launch", "--update-recovery"]
        );
        request.data_directory = None;
        let legacy = super::command(&request);
        assert_eq!(legacy.get_program(), root.join("node"));
        assert_eq!(
            legacy.get_args().collect::<Vec<_>>(),
            [root.join("wrapper.js").as_os_str()]
        );
    }

    #[test]
    fn web_readiness_requires_both_live_services_at_the_target_version() {
        let root = std::env::temp_dir().join(format!("codexhost-ready-{}", std::process::id()));
        let data = root.join("data");
        fs::create_dir_all(&data).unwrap();
        let request: UpdateRequest = serde_json::from_value(serde_json::json!({
            "schema_version": 1, "version": "1.2.3", "wait_pid": 1,
            "wait_executable": root.join("node"), "runtime_descriptor_path": root.join("desktop.json"),
            "status_path": root.join("status.json"), "restart_target": "web", "data_directory": data,
            "installation": {"kind":"npm", "node_path":root.join("node"), "npm_cli_path":root.join("npm.js"), "npm_launcher_path":root.join("wrapper.js"), "npm_package_root":root.join("package")}
        })).unwrap();
        let launcher = request.installation.launcher_path();
        let app = request.installation.resources_root().join("app");
        let snapshot = |pid| {
            Some(ProcessIdentity {
                id: pid,
                parent_id: if pid == 43 { 42 } else { 1 },
                started_at_micros: 100,
            })
        };
        fs::write(data.join("shared-host-ready.json"), serde_json::to_vec(&serde_json::json!({
            "pid":41, "started_at_micros":100, "executable":root.join("node"), "runtime":app.join("host-runtime.mjs"), "version":"1.2.2"
        })).unwrap()).unwrap();
        let mut web = serde_json::json!({
            "pid":42, "started_at_micros":100, "executable":launcher, "runtime":app.join("web-server.mjs"), "version":"1.2.2",
            "web_pid":43, "address":"http://127.0.0.1:4321/"
        });
        assert!(services_ready(&request, Some("1.2.2"), false, snapshot, |_| true).unwrap());
        assert!(!services_ready(&request, None, true, snapshot, |_| true).unwrap());
        fs::write(
            data.join("web-service-ready.json"),
            serde_json::to_vec(&web).unwrap(),
        )
        .unwrap();
        assert!(!services_ready(&request, Some("1.2.3"), true, snapshot, |_| true).unwrap());
        assert!(services_ready(&request, Some("1.2.2"), true, snapshot, |_| true).unwrap());
        assert!(services_ready(&request, None, true, snapshot, |_| true).unwrap());
        assert!(!services_ready(&request, None, true, snapshot, |_| false).unwrap());
        assert!(
            !services_ready(
                &request,
                None,
                true,
                |pid| (pid != 43).then(|| snapshot(pid).unwrap()),
                |_| true
            )
            .unwrap()
        );
        web["started_at_micros"] = 101.into();
        fs::write(
            data.join("web-service-ready.json"),
            serde_json::to_vec(&web).unwrap(),
        )
        .unwrap();
        assert!(!services_ready(&request, None, true, snapshot, |_| true).unwrap());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn recovery_refuses_live_services_from_another_installation() {
        let root =
            std::env::temp_dir().join(format!("codexhost-recovery-owner-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let live = process_snapshot(std::process::id()).unwrap();
        let request: UpdateRequest = serde_json::from_value(serde_json::json!({
            "schema_version":1, "version":"1.2.3", "wait_pid":1,
            "wait_executable":live.executable, "runtime_descriptor_path":root.join("desktop.json"),
            "status_path":root.join("status.json"), "restart_target":"web", "data_directory":root,
            "installation":{"kind":"npm", "node_path":live.executable, "npm_cli_path":root.join("npm.js"), "npm_launcher_path":root.join("wrapper.js"), "npm_package_root":root.join("package")}
        })).unwrap();
        let mut owner = serde_json::json!({
            "pid":live.id, "started_at_micros":live.started_at_micros, "executable":root.join("deleted-package/node"),
            "runtime":root.join("other/app/host-runtime.mjs"), "version":"1.2.2"
        });
        fs::write(
            root.join("shared-host-ready.json"),
            serde_json::to_vec(&owner).unwrap(),
        )
        .unwrap();
        assert!(
            verify_available_services(&request)
                .unwrap_err()
                .to_string()
                .contains("another installation")
        );
        owner["runtime"] = serde_json::to_value(
            request
                .installation
                .resources_root()
                .join("app/host-runtime.mjs"),
        )
        .unwrap();
        fs::write(
            root.join("shared-host-ready.json"),
            serde_json::to_vec(&owner).unwrap(),
        )
        .unwrap();
        verify_available_services(&request).unwrap();
        fs::remove_dir_all(root).unwrap();
    }
}
