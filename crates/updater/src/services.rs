//! Stop the services using the installation being replaced.
use std::error::Error;
use std::process::Command;

use codexhost_platform::configure_background_command;

use crate::request::UpdateRequest;

fn stop_command(request: &UpdateRequest) -> Command {
    let mut command = Command::new(request.installation.launcher_path());
    command
        .arg("stop-for-update")
        .arg("--node")
        .arg(request.installation.node_path());
    if let Some(data) = &request.data_directory {
        command
            .arg("--data")
            .arg(data)
            .env("CODEXHOST_DATA_DIR", data);
    }
    configure_background_command(&mut command);
    command
}

pub(crate) fn stop(request: &UpdateRequest) -> Result<Option<String>, Box<dyn Error>> {
    let output = stop_command(request).output()?;
    if !output.status.success() {
        return Err(format!(
            "stopping Web and Host failed ({}): {}{}",
            output.status,
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        )
        .into());
    }
    let text = String::from_utf8_lossy(&output.stdout).into_owned();
    Ok((!text.is_empty()).then_some(text))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::env;

    #[test]
    fn locates_the_old_launcher_and_node_from_each_existing_installation_request() {
        let root = std::env::temp_dir().join("codexhost-update-command");
        let executable = format!("codexhost{}", env::consts::EXE_SUFFIX);
        for (installation, launcher, node) in [
            (
                json!({"kind":"npm", "node_path":root.join("npm-node"), "npm_cli_path":root.join("npm.js"), "npm_launcher_path":root.join("wrapper.js"), "npm_package_root":root.join("package")}),
                root.join("package/bin").join(&executable),
                root.join("npm-node"),
            ),
            (
                json!({"kind":"windows-installer", "install_root":root.join("installed"), "installer_path":root.join("setup.exe"), "artifact_sha256":"a".repeat(64)}),
                root.join("installed/bin").join(&executable),
                root.join("installed/runtime/node.exe"),
            ),
            (
                json!({"kind":"macos-dmg", "app_path":root.join("installed.app"), "dmg_path":root.join("setup.dmg"), "artifact_sha256":"a".repeat(64)}),
                root.join("installed.app/Contents/MacOS").join(&executable),
                root.join("installed.app/Contents/Resources/runtime/node"),
            ),
        ] {
            let request: UpdateRequest = serde_json::from_value(json!({
                "schema_version":1, "version":"1.2.3", "wait_pid":12,
                "wait_executable":root.join("console-node"), "runtime_descriptor_path":root.join("runtime.json"),
                "status_path":root.join("status.json"), "installation":installation,
            })).unwrap();
            let command = stop_command(&request);
            assert_eq!(command.get_program(), launcher);
            let arguments = command.get_args().collect::<Vec<_>>();
            assert_eq!(arguments.len(), 3);
            assert_eq!(
                &arguments[..2],
                [
                    std::ffi::OsStr::new("stop-for-update"),
                    std::ffi::OsStr::new("--node"),
                ]
            );
            assert_eq!(std::path::Path::new(arguments[2]), node);
        }
    }
}
