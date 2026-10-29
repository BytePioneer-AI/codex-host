//! Restore the independent console only after update/recovery has committed.
use crate::request::{Installation, UpdateRequest};
use std::{
    error::Error,
    ffi::OsStr,
    process::{Command, Stdio},
};

#[cfg(target_os = "windows")]
pub(crate) fn start(request: &UpdateRequest) -> Result<(), Box<dyn Error>> {
    if let Some(mut command) = console_command(
        request,
        crate::windows_installation::architecture(),
        std::env::var_os("CODEXHOST_CONSOLE").as_deref(),
    )? {
        // The Updater is outside the Desktop Job. The console must outlive both
        // the Updater and Desktop, and must never participate in launch rollback.
        command.spawn()?;
    }
    Ok(())
}

fn console_command(
    request: &UpdateRequest,
    architecture: &str,
    setting: Option<&OsStr>,
) -> Result<Option<Command>, Box<dyn Error>> {
    if setting == Some(OsStr::new("0")) {
        return Ok(None);
    }
    let (root, node) = match &request.installation {
        Installation::Npm(npm) => (
            npm.prefix
                .as_ref()
                .ok_or("console restart has no npm prefix")?
                .join(format!("node_modules/@codexhost/cli-win32-{architecture}")),
            npm.node_path.clone(),
        ),
        Installation::WindowsInstaller(windows) => (
            windows.install_root.clone(),
            windows.install_root.join("runtime/node.exe"),
        ),
        _ => return Err("console restart requires a Windows installation".into()),
    };
    let entry = root.join("app/console-server.mjs");
    let launcher = root.join("bin/codexhost.exe");
    for file in [&entry, &launcher] {
        crate::windows_installation::owned_file(&root, file)?;
    }
    let mut command = Command::new(node);
    command
        .arg("--disable-warning=UNDICI-EHPA")
        .arg(codexhost_platform::node_entrypoint_path(&entry))
        // serve binds the configured port without replacing another console or
        // opening a browser. An occupied port leaves its current owner alone.
        .arg("serve")
        .current_dir(&root)
        .env("CODEXHOST_LAUNCHER_EXECUTABLE", launcher)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if let Installation::Npm(npm) = &request.installation {
        // Offline installation hoists the platform package even when the
        // initiating runtime used npm's nested optional-dependency layout.
        command
            .env("CODEXHOST_NPM_PACKAGE_ROOT", &root)
            .env("CODEXHOST_NPM_NODE_PATH", &npm.node_path)
            .env("CODEXHOST_NPM_CLI_PATH", &npm.npm_cli_path)
            .env("CODEXHOST_NPM_LAUNCHER_PATH", &npm.npm_launcher_path);
    } else {
        for key in [
            "CODEXHOST_NPM_PACKAGE_ROOT",
            "CODEXHOST_NPM_NODE_PATH",
            "CODEXHOST_NPM_CLI_PATH",
            "CODEXHOST_NPM_LAUNCHER_PATH",
        ] {
            command.env_remove(key);
        }
    }
    codexhost_platform::configure_background_command(&mut command);
    Ok(Some(command))
}

#[cfg(test)]
#[path = "windows_console_tests.rs"]
mod tests;
