#![forbid(unsafe_code)]
#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

#[cfg(target_os = "windows")]
const CONSOLE_ARGUMENT: &str = "--console";

#[cfg(target_os = "windows")]
fn launcher_command() -> Result<std::process::Command, Box<dyn std::error::Error>> {
    use std::env;
    use std::process::Command;

    use codexhost_platform::{
        configure_background_command, existing_file_preserving_links,
    };

    let executable = env::current_exe()?;
    let directory = executable
        .parent()
        .ok_or("codexhost Start Menu executable has no parent directory")?;
    // Keep the link intact. The launcher derives every resource path from its own
    // location, and it re-injects the Shim path into the Desktop. Resolving a
    // directory junction here would move the whole installation to the link target
    // and hand the Desktop a path it may not be able to read.
    let launcher = existing_file_preserving_links(&directory.join("codexhost.exe"))?;
    let mut command = Command::new(launcher);
    configure_background_command(&mut command);
    Ok(command)
}

#[cfg(target_os = "windows")]
fn run() -> Result<(), Box<dyn std::error::Error>> {
    let mut command = launcher_command()?;
    command.arg("--start-menu");
    command.spawn()?;
    Ok(())
}

/// Opens the codexhost console without flashing a terminal window.
#[cfg(target_os = "windows")]
fn run_console() -> Result<(), Box<dyn std::error::Error>> {
    let output = launcher_command()?.arg("console").output()?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    Err(stderr.trim().to_owned().into())
}

#[cfg(target_os = "windows")]
fn main() {
    if std::env::args().nth(1).as_deref() == Some(CONSOLE_ARGUMENT) {
        if let Err(error) = run_console() {
            codexhost_platform::show_error_dialog(&format!(
                "codexhost console could not open: {error}"
            ));
        }
        return;
    }
    if let Err(error) = run() {
        codexhost_platform::show_error_dialog(&format!("codexhost could not start: {error}"));
    }
}

#[cfg(not(target_os = "windows"))]
fn main() {}
