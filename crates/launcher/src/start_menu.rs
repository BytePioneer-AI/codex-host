#![forbid(unsafe_code)]
#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

#[cfg(target_os = "windows")]
fn run() -> Result<(), Box<dyn std::error::Error>> {
    use std::env;
    use std::process::Command;

    use codexhost_platform::{canonical_existing_file, configure_background_command};

    let executable = env::current_exe()?;
    let directory = executable
        .parent()
        .ok_or("codexhost Start Menu executable has no parent directory")?;
    let launcher = canonical_existing_file(&directory.join("codexhost.exe"))?;
    let mut command = Command::new(launcher);
    command.arg("--start-menu");
    configure_background_command(&mut command);
    command.spawn()?;
    Ok(())
}

#[cfg(target_os = "windows")]
fn main() {
    if let Err(error) = run() {
        codexhost_platform::show_error_dialog(&format!("codexhost could not start: {error}"));
    }
}

#[cfg(not(target_os = "windows"))]
fn main() {}
