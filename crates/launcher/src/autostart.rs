//! CLI contract shared by the shell and the local connection-devices page.
use std::env;
use std::error::Error;
use std::path::PathBuf;

use codexhost_platform::{AutostartCommand, AutostartStatus};

use crate::installation_layout::is_source_checkout_build;
use crate::{NPM_LAUNCHER_PATH_ENV, NPM_NODE_PATH_ENV};

fn current_command() -> Result<AutostartCommand, Box<dyn Error>> {
    let wrapper = env::var_os(NPM_LAUNCHER_PATH_ENV).map(PathBuf::from);
    let executable = if wrapper.is_some() {
        env::var_os(NPM_NODE_PATH_ENV)
            .map(PathBuf::from)
            .ok_or("npm autostart requires the current Node path")?
    } else {
        env::current_exe()?
    };
    Ok(AutostartCommand {
        executable,
        wrapper,
    })
}

pub fn status_line() -> String {
    match codexhost_platform::autostart_status() {
        AutostartStatus::On => "on".into(),
        AutostartStatus::Off => "off".into(),
        AutostartStatus::Invalid(reason) => format!(
            "invalid {}; run `codexhost` again to repair",
            reason.replace(['\r', '\n'], " ")
        ),
    }
}

pub fn run(arguments: &[String]) -> Result<(), Box<dyn Error>> {
    match arguments.first().map(String::as_str) {
        Some("on") if arguments.len() == 1 => {
            codexhost_platform::enable_autostart(&current_command()?)?;
        }
        Some("off") if arguments.len() == 1 => codexhost_platform::disable_autostart()?,
        Some("status") if arguments.len() == 1 => println!("{}", status_line()),
        _ => return Err("autostart expects on|off|status".into()),
    }
    Ok(())
}

pub fn refresh() {
    // `npm start` must not point the login entry at a source build. Explicit
    // `autostart on` still registers whichever program the user ran.
    let result = current_command().and_then(|command| {
        if command.wrapper.is_none() && is_source_checkout_build(&command.executable) {
            return Ok(());
        }
        codexhost_platform::refresh_autostart(&command).map_err(Into::into)
    });
    if let Err(error) = result {
        eprintln!("codexhost: could not refresh autostart: {error}");
    }
}
