use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

fn launcher_path() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_codexhost"))
}

#[test]
fn production_launcher_rejects_the_gate_probe_command() {
    let output = Command::new(launcher_path())
        .arg("probe")
        .output()
        .expect("run launcher");
    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("usage:\n  codexhost inspect"));
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
        .args(["launch", "--agent", "codex"])
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
