use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

fn launcher_path() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_codexhost"))
}

#[test]
fn production_launcher_uses_the_three_state_running_desktop_flow() {
    let source = fs::read_to_string(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/main.rs"))
        .expect("read Launcher source");
    assert!(source.contains("StartupState::RecoverStale"));
    assert!(source.contains("StartupState::CleanLaunch"));
    assert!(source.contains("StartupState::Attach"));
    assert!(source.contains("acquire_launcher_ownership"));
    assert!(source.contains("completely quit it before starting codexhost"));
    assert!(!source.contains("attach_unmanaged_desktop"));
}

#[test]
fn production_launcher_rejects_the_gate_probe_command() {
    let output = Command::new(launcher_path())
        .arg("probe")
        .output()
        .expect("run launcher");
    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("codexhost inspect"));
    assert!(stderr.contains("codexhost launch"));
    assert!(!stderr.contains("codexhost probe"));
}

#[test]
fn production_launcher_rejects_the_removed_process_stop_command() {
    let output = Command::new(launcher_path())
        .args([
            "process-stop",
            "--name",
            "codexhost-nonexistent-test-process",
        ])
        .output()
        .expect("run launcher");
    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("codexhost inspect"));
    assert!(!stderr.contains("native process stop"));
}

#[cfg(target_os = "windows")]
#[test]
fn production_launcher_reads_only_a_matching_process_environment() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system time")
        .as_nanos();
    let name = format!("CODEXHOST_PROCESS_ENV_TEST_{unique}");
    let value = format!("snapshot-{unique}");
    let marker = format!("codexhost-process-environment-{unique}");
    let command = std::env::var_os("ComSpec").expect("ComSpec");
    let command_string = command.to_string_lossy().into_owned();
    let target_arguments = format!("echo {marker} > nul & ping -n 8 127.0.0.1 > nul");
    let mut target = Command::new(&command)
        .args(["/d", "/c", &target_arguments])
        .env(&name, &value)
        .spawn()
        .expect("spawn process environment fixture");
    std::thread::sleep(std::time::Duration::from_millis(200));

    let wrong_process = Command::new(launcher_path())
        .args([
            "--codexhost-read-process-environment",
            "--executable",
            &command_string,
            "--command-line-contains",
            "codexhost-wrong-process",
            "--name",
            &name,
        ])
        .output()
        .expect("reject a different process command line");
    let output = Command::new(launcher_path())
        .args([
            "--codexhost-read-process-environment",
            "--executable",
            &command_string,
            "--command-line-contains",
            &marker,
            "--name",
            &name,
        ])
        .output()
        .expect("read process environment");
    let _ = target.kill();
    let _ = target.wait();

    assert!(wrong_process.status.success());
    assert!(wrong_process.stdout.is_empty());
    assert!(wrong_process.stderr.is_empty());
    assert!(output.status.success());
    assert_eq!(output.stdout, value.as_bytes());
    assert!(output.stderr.is_empty());
}

#[test]
fn production_launcher_resolves_resources_beside_its_installed_location() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system time")
        .as_nanos();
    let root = std::env::temp_dir().join(format!(
        "codexhost release layout {} {unique}",
        std::process::id()
    ));
    let bin = root.join("bin");
    fs::create_dir_all(&bin).expect("create release bin directory");
    let source = launcher_path();
    let installed = bin.join(source.file_name().expect("launcher file name"));
    fs::copy(&source, &installed).expect("copy installed launcher");

    let output = Command::new(&installed)
        .args(["launch"])
        .output()
        .expect("run installed launcher");
    fs::remove_dir_all(&root).expect("remove release layout");

    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("bundled Shim"));
    assert!(stderr.contains("libexec"));
    assert!(stderr.contains("codexhost-shim"));
    assert!(!stderr.contains("--shim is required"));
}

#[cfg(target_os = "macos")]
#[test]
fn finder_launch_resolves_standard_app_resources_and_defaults_to_codex() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system time")
        .as_nanos();
    let root = std::env::temp_dir().join(format!(
        "codexhost installed app {} {unique}",
        std::process::id()
    ));
    let macos = root.join("codexhost.app/Contents/MacOS");
    fs::create_dir_all(&macos).expect("create app executable directory");
    let installed = macos.join("codexhost");
    fs::copy(launcher_path(), &installed).expect("copy app launcher");

    let output = Command::new(&installed)
        .output()
        .expect("run Finder-style launcher");
    fs::remove_dir_all(&root).expect("remove app layout");

    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("bundled Shim"));
    assert!(stderr.contains("Contents/Resources/libexec/codexhost-shim"));
    assert!(!stderr.contains("invalid launcher arguments"));
}
