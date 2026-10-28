use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use super::{executable_key, shutdown_processes_for_executables};

#[test]
fn normalizes_windows_executable_paths_without_matching_sibling_directories() {
    assert_eq!(
        executable_key(Path::new(r"\\?\C:\Programs\codexhost\runtime\node.exe")),
        executable_key(Path::new(r"c:/programs/codexhost/runtime/node.exe"))
    );
    assert_ne!(
        executable_key(Path::new(r"C:\Programs\codexhost\runtime\node.exe")),
        executable_key(Path::new(r"C:\Programs\codexhost-other\runtime\node.exe"))
    );
}

#[test]
fn refuses_to_shut_down_the_installer_helper_itself() {
    let error =
        shutdown_processes_for_executables(&[std::env::current_exe().unwrap()]).unwrap_err();
    assert!(error.to_string().contains("outside the installation"));
}

#[test]
fn accepts_no_targets_and_rejects_relative_paths() {
    shutdown_processes_for_executables(&[]).unwrap();
    assert!(shutdown_processes_for_executables(&[PathBuf::from("node.exe")]).is_err());
}

#[test]
fn installer_wait_fixture() {
    let Some(ready) = std::env::var_os("CODEXHOST_INSTALLER_TEST_READY") else {
        return;
    };
    fs::write(ready, "ready").unwrap();
    thread::sleep(Duration::from_secs(120));
}

struct Process(Child);

impl Process {
    fn start(executable: &Path, ready: &Path) -> Self {
        let mut command = Command::new(executable);
        command
            .args([
                "--exact",
                "windows_installer::tests::installer_wait_fixture",
                "--nocapture",
            ])
            .env("CODEXHOST_INSTALLER_TEST_READY", ready)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        crate::configure_background_command(&mut command);
        let mut process = Self(command.spawn().unwrap());
        let started = Instant::now();
        while !ready.exists() {
            assert!(
                process.0.try_wait().unwrap().is_none(),
                "fixture exited early"
            );
            assert!(
                started.elapsed() < Duration::from_secs(15),
                "fixture did not start"
            );
            thread::sleep(Duration::from_millis(20));
        }
        process
    }
}

impl Drop for Process {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

struct Directory(PathBuf);

impl Drop for Directory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn closes_only_the_selected_installation_and_releases_its_executable() {
    let root = Directory(
        std::env::temp_dir().join(format!("codexhost installer 测试-{}", std::process::id())),
    );
    let selected = root.0.join("codexhost/runtime/node.exe");
    let other = root.0.join("codexhost-other/runtime/node.exe");
    for executable in [&selected, &other] {
        fs::create_dir_all(executable.parent().unwrap()).unwrap();
        fs::copy(std::env::current_exe().unwrap(), executable).unwrap();
    }
    let mut selected_process = Process::start(&selected, &root.0.join("selected-ready"));
    let mut other_process = Process::start(&other, &root.0.join("other-ready"));

    shutdown_processes_for_executables(std::slice::from_ref(&selected)).unwrap();

    assert!(selected_process.0.try_wait().unwrap().is_some());
    assert!(other_process.0.try_wait().unwrap().is_none());
    // Installation must be able to replace the image, not merely observe a signal.
    fs::remove_file(&selected).unwrap();
    fs::write(&selected, "replacement").unwrap();
}
