use std::path::PathBuf;
use std::process::Command;

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
    assert!(!stderr.contains("--shim"));
}
