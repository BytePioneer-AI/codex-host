use std::fs;
use std::io;
use std::path::PathBuf;
use std::process::{Command, Output};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

fn launcher_path() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_codexhost"))
}

/// Runs a binary this test just copied. On Linux a child forked by a parallel test can
/// briefly inherit the copy's write descriptor, so exec fails with ETXTBSY until it exits.
fn output_of_copied_binary(command: &mut Command) -> io::Result<Output> {
    let mut attempt = 0;
    loop {
        match command.output() {
            Err(error) if error.kind() == io::ErrorKind::ExecutableFileBusy && attempt < 50 => {
                attempt += 1;
                thread::sleep(Duration::from_millis(20));
            }
            result => return result,
        }
    }
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

    let output = output_of_copied_binary(
        Command::new(&installed)
            .args(["launch"])
            .env("CODEXHOST_DATA_DIR", root.join("data"))
            .env("CODEXHOST_CONSOLE", "0")
            .env("CODEXHOST_INSTALL_ROOT", root.join("missing-desktop")),
    )
    .expect("run installed launcher");
    fs::remove_dir_all(&root).expect("remove release layout");

    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("bundled Shim"), "{stderr}");
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

    let output = output_of_copied_binary(
        Command::new(&installed)
            .env("CODEXHOST_DATA_DIR", root.join("data"))
            .env("CODEXHOST_CONSOLE", "0")
            .env("CODEXHOST_INSTALL_ROOT", root.join("missing-desktop")),
    )
    .expect("run Finder-style launcher");
    fs::remove_dir_all(&root).expect("remove app layout");

    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("bundled Shim"), "{stderr}");
    assert!(stderr.contains("Contents/Resources/libexec/codexhost-shim"));
    assert!(!stderr.contains("invalid launcher arguments"));
}

#[cfg(target_os = "macos")]
#[test]
fn npm_launch_starts_recovery_console_without_desktop_or_bundled_node() {
    use std::os::unix::fs::PermissionsExt;

    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!(
        "codexhost npm console {} {unique}",
        std::process::id()
    ));
    let bin = root.join("bin");
    fs::create_dir_all(&bin).unwrap();
    let installed = bin.join("codexhost");
    fs::copy(launcher_path(), &installed).unwrap();
    let host_runtime = root.join("host-runtime.mjs");
    fs::write(&host_runtime, "fixture").unwrap();
    fs::write(root.join("console-server.mjs"), "fixture").unwrap();
    let node = root.join("npm-node");
    let calls = root.join("calls");
    fs::write(&node, "#!/bin/sh\nprintf '%s\n' \"$3\" >> \"$TEST_CONSOLE_CALLS\"\necho 'codexhost console: http://127.0.0.1:4399/'\n").unwrap();
    fs::set_permissions(&node, fs::Permissions::from_mode(0o755)).unwrap();

    let output = output_of_copied_binary(
        Command::new(&installed)
            .args(["launch", "--host-runtime"])
            .arg(&host_runtime)
            .env("CODEXHOST_DATA_DIR", root.join("data"))
            .env("CODEXHOST_INSTALL_ROOT", root.join("missing-desktop"))
            .env("CODEXHOST_CONSOLE", "1")
            .env("CODEXHOST_NPM_NODE_PATH", &node)
            .env("TEST_CONSOLE_CALLS", &calls),
    )
    .unwrap();
    let calls = fs::read_to_string(calls).unwrap_or_default();
    fs::remove_dir_all(&root).unwrap();

    assert!(!output.status.success());
    assert!(calls.lines().any(|action| action == "ensure"), "{calls}");
    assert!(String::from_utf8_lossy(&output.stderr).contains("bundled Shim"));
    assert!(
        String::from_utf8_lossy(&output.stderr)
            .contains("codexhost console: http://127.0.0.1:4399/")
    );
}
