use std::fs;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use codexhost_platform::{
    DesktopIdentity, DesktopInstallation, DesktopProcess, ProcessSnapshot, SupervisedChild,
    configure_background_command, descendant_process_snapshots, process_instance_exists,
    process_snapshot, spawn_supervised, terminate_process_instance,
};

use super::{installation_executables, stop_managed_desktop_for_update};
use crate::ResolvedLaunchOptions;

struct Fixture {
    directory: PathBuf,
    desktop: DesktopProcess,
    root: ProcessSnapshot,
    descendants: Vec<ProcessSnapshot>,
    controller: SupervisedChild,
    unrelated_node: Child,
    installation: DesktopInstallation,
    options: ResolvedLaunchOptions,
}

fn ping(executable: &Path) -> Child {
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        match Command::new(executable)
            .args(["-n", "30", "127.0.0.1"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
        {
            Ok(child) => return child,
            Err(error)
                if matches!(error.raw_os_error(), Some(5 | 32)) && Instant::now() < deadline =>
            {
                thread::sleep(Duration::from_millis(20));
            }
            Err(error) => panic!("spawn fixture: {error}"),
        }
    }
}

impl Fixture {
    fn new() -> Self {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "codexhost-update-ownership-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir(&directory).unwrap();
        let system = PathBuf::from(std::env::var_os("SystemRoot").unwrap()).join("System32");
        let shim = directory.join("shim.exe");
        let node = directory.join("node.exe");
        let desktop_executable = directory.join("desktop.exe");
        for executable in [&shim, &node, &desktop_executable] {
            fs::copy(system.join("ping.exe"), executable).unwrap();
        }
        let mut command = Command::new("cmd.exe");
        command
            .args(["/d", "/s", "/c"])
            .raw_arg(format!(
                "\"start \"\" /b \"{}\" -n 30 127.0.0.1 >nul & \"{}\" -n 30 127.0.0.1 >nul\"",
                shim.display(),
                node.display()
            ))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let desktop = DesktopProcess::from_child(command.spawn().unwrap());
        let root = process_snapshot(desktop.id()).unwrap();
        let mut controller_command = Command::new(&desktop_executable);
        controller_command
            .args(["-n", "30", "127.0.0.1"])
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        configure_background_command(&mut controller_command);
        let controller = spawn_supervised(&mut controller_command).unwrap();
        let unrelated_node = ping(&node);
        let installation = DesktopInstallation {
            identity: DesktopIdentity::WindowsPackage {
                package_name: "test".into(),
                package_family_name: "test".into(),
                appx_activation: None,
            },
            version: "0.0.0-test".into(),
            build: "test".into(),
            asar_integrity: String::new(),
            install_root: directory.clone(),
            desktop_launcher: desktop_executable.clone(),
            desktop_executable,
            packaged_codex_cli: PathBuf::new(),
            executable_codex_cli: PathBuf::new(),
        };
        let options = ResolvedLaunchOptions {
            shim,
            node,
            host_runtime: PathBuf::new(),
            desktop_controller: PathBuf::new(),
            renderer_extension: PathBuf::new(),
            pi: None,
            custom_install_root: None,
        };
        let mut fixture = Self {
            directory,
            desktop,
            root,
            descendants: Vec::new(),
            controller,
            unrelated_node,
            installation,
            options,
        };
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            match descendant_process_snapshots(
                &fixture.root,
                &[&fixture.options.shim, &fixture.options.node],
            ) {
                Ok(descendants) => {
                    fixture.descendants = descendants;
                    break;
                }
                Err(error) if Instant::now() >= deadline => {
                    panic!("fixture chain not ready: {error}")
                }
                Err(_) => thread::sleep(Duration::from_millis(20)),
            }
        }
        fixture
    }

    fn stop(
        &mut self,
        waiting: impl FnMut() -> std::io::Result<bool>,
    ) -> Result<(), Box<dyn std::error::Error>> {
        stop_managed_desktop_for_update(
            &mut self.desktop,
            &self.root,
            &self.installation,
            &mut self.controller,
            &self.options,
            waiting,
        )
    }

    fn assert_descendants_alive(&self) {
        for process in &self.descendants {
            assert!(process_instance_exists(process.id, process.started_at_micros).unwrap());
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self.desktop.kill();
        let _ = self.desktop.wait();
        for process in &self.descendants {
            let _ = terminate_process_instance(process, true);
        }
        let _ = self.controller.force_terminate();
        let _ = self.controller.wait();
        let _ = self.unrelated_node.kill();
        let _ = self.unrelated_node.wait();
        let deadline = Instant::now() + Duration::from_secs(2);
        while fs::remove_dir_all(&self.directory).is_err() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(20));
        }
    }
}

#[test]
fn root_exit_before_capture_aborts_without_sweeping_shared_executables() {
    let mut fixture = Fixture::new();
    fixture.desktop.kill().unwrap();
    fixture.desktop.wait().unwrap();
    assert!(fixture.stop(|| Ok(true)).is_err());
    fixture.assert_descendants_alive();
    assert!(fixture.unrelated_node.try_wait().unwrap().is_none());
    assert!(fixture.controller.try_wait().unwrap().is_none());
}

#[test]
fn missing_ownership_aborts_without_stopping_any_live_process() {
    let mut fixture = Fixture::new();
    fixture.options.shim = fixture.directory.join("absent-shim.exe");
    assert!(fixture.stop(|| Ok(true)).is_err());
    assert!(fixture.desktop.try_wait().unwrap().is_none());
    fixture.assert_descendants_alive();
    assert!(fixture.unrelated_node.try_wait().unwrap().is_none());
    assert!(fixture.controller.try_wait().unwrap().is_none());
}

#[test]
fn captured_tree_stays_alive_when_the_updater_stops_waiting() {
    let mut fixture = Fixture::new();
    // Both required executables exist in the managed tree: exercise the normal
    // capture branch, not the missing-chain error used by the old fixture.
    assert!(
        descendant_process_snapshots(
            &fixture.root,
            &[&fixture.options.shim, &fixture.options.node]
        )
        .is_ok()
    );
    assert!(fixture.stop(|| Ok(false)).is_err());
    assert!(fixture.desktop.try_wait().unwrap().is_none());
    fixture.assert_descendants_alive();
    assert!(fixture.controller.try_wait().unwrap().is_none());
}

#[test]
fn successful_stop_terminates_owned_descendants_and_preserves_shared_node() {
    let mut fixture = Fixture::new();
    fixture.stop(|| Ok(true)).unwrap();
    assert!(fixture.desktop.try_wait().unwrap().is_some());
    for process in &fixture.descendants {
        assert!(!process_instance_exists(process.id, process.started_at_micros).unwrap());
    }
    assert!(fixture.controller.try_wait().unwrap().is_some());
    assert!(fixture.unrelated_node.try_wait().unwrap().is_none());
}

#[test]
fn helper_exit_during_shutdown_stops_further_termination() {
    let mut fixture = Fixture::new();
    let mut checks = 0;
    assert!(
        fixture
            .stop(|| {
                checks += 1;
                Ok(checks == 1)
            })
            .is_err()
    );
    fixture.assert_descendants_alive();
    assert!(fixture.unrelated_node.try_wait().unwrap().is_none());
}

#[test]
fn final_scan_includes_bundled_node_but_not_shared_system_node() {
    let fixture = Fixture::new();
    let desktop = &fixture.installation.desktop_executable;
    let shim = &fixture.options.shim;
    let node = &fixture.options.node;
    assert_eq!(
        installation_executables(desktop, shim, node, node).unwrap(),
        vec![desktop.as_path(), shim.as_path(), node.as_path()]
    );
    assert_eq!(
        installation_executables(
            desktop,
            shim,
            node,
            &fixture.directory.join("missing-bundled-node.exe")
        )
        .unwrap(),
        vec![desktop.as_path(), shim.as_path()]
    );
    assert_eq!(
        installation_executables(desktop, shim, node, shim).unwrap(),
        vec![desktop.as_path(), shim.as_path()]
    );
}
