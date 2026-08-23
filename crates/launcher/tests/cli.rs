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
