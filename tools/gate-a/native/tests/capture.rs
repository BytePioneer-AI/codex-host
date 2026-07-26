#![cfg(feature = "gate-tools")]

use std::fs;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

use codexhost_gate_a_native::{
    DESKTOP_VERSION_ENV, INSTALL_ROOT_ENV, LAUNCH_MODE_ENV, PROBE_OUTPUT_ENV,
};
use codexhost_platform::{CODEX_CLI_PATH_ENV, STOCK_CODEX_PATH_ENV};

fn gate_shim_path() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_codexhost-shim-probe"))
}

fn harmless_command() -> (PathBuf, Vec<&'static str>) {
    if cfg!(target_os = "windows") {
        (
            std::env::var_os("COMSPEC")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from(r"C:\Windows\System32\cmd.exe")),
            vec!["/C", "exit", "0"],
        )
    } else {
        (PathBuf::from("/usr/bin/true"), Vec::new())
    }
}

fn temporary_directory() -> PathBuf {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system time")
        .as_nanos();
    let directory = std::env::temp_dir().join(format!(
        "codexhost-gate-capture-{}-{unique}",
        std::process::id()
    ));
    fs::create_dir(&directory).expect("create capture directory");
    directory
}

#[test]
fn gate_shim_writes_invocation_and_exit_records() {
    let gate_shim = gate_shim_path();
    let output_directory = temporary_directory();
    let (stock_command, arguments) = harmless_command();
    let output = Command::new(&gate_shim)
        .args(arguments)
        .env(STOCK_CODEX_PATH_ENV, stock_command)
        .env(CODEX_CLI_PATH_ENV, &gate_shim)
        .env(PROBE_OUTPUT_ENV, &output_directory)
        .env(DESKTOP_VERSION_ENV, "test-desktop")
        .env(INSTALL_ROOT_ENV, "test-install")
        .env(LAUNCH_MODE_ENV, "direct-executable")
        .stdin(Stdio::null())
        .output()
        .expect("run Gate Shim");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );

    let records = output_directory
        .read_dir()
        .expect("read captures")
        .map(|entry| {
            fs::read_to_string(entry.expect("capture entry").path()).expect("capture JSON")
        })
        .collect::<Vec<_>>();
    assert_eq!(records.len(), 2);
    assert!(
        records
            .iter()
            .any(|record| record.contains("\"record_type\":\"invocation\""))
    );
    assert!(
        records
            .iter()
            .any(|record| record.contains("\"record_type\":\"exit\""))
    );
}
