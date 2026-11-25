//! The npm packages that replace a global npm installation of codexhost in place.
use std::error::Error;
use std::path::{Path, PathBuf};
use std::process::Command;

use codexhost_platform::configure_background_command;

const CLI_PACKAGE: &str = "@codexhost/cli";

/// Returns the package specs for `npm install --global`, or `None` when that npm does
/// not own this installation.
///
/// npm places the platform package inside `@codexhost/cli`, where installing the CLI
/// replaces it. A platform package installed as its own global package (the startup
/// version-mismatch command does this) is only replaced when npm is given its name.
/// Restart runs `package_root`, so any other layout cannot be updated in place.
pub(crate) fn install_specs(
    node: &Path,
    npm_cli: &Path,
    launcher: &Path,
    package_root: &Path,
    version: &str,
) -> Result<Option<Vec<String>>, Box<dyn Error>> {
    let mut command = Command::new(node);
    command.arg(npm_cli).args(["root", "--global"]);
    configure_background_command(&mut command);
    let output = command.output()?;
    if !output.status.success() {
        return Err("Could not identify the global npm installation".into());
    }
    let global_root = canonical(PathBuf::from(String::from_utf8(output.stdout)?.trim()));
    let package_root = canonical(package_root.to_path_buf());
    let cli_root = canonical(
        launcher
            .parent()
            .and_then(Path::parent)
            .ok_or("Invalid npm launcher path")?
            .to_path_buf(),
    );
    let mut specs = vec![format!("{CLI_PACKAGE}@{version}")];
    if package_root.parent().and_then(Path::parent) == Some(global_root.as_path()) {
        specs.push(format!(
            "{}@{version}",
            platform_package_name(&package_root)?
        ));
    } else if !(cli_root.parent().and_then(Path::parent) == Some(global_root.as_path())
        && package_root.starts_with(cli_root.join("node_modules")))
    {
        return Ok(None);
    }
    Ok(Some(specs))
}

fn canonical(path: PathBuf) -> PathBuf {
    path.canonicalize().unwrap_or(path)
}

fn platform_package_name(package_root: &Path) -> Result<String, Box<dyn Error>> {
    let scope = package_root
        .parent()
        .and_then(Path::file_name)
        .and_then(|name| name.to_str());
    let name = package_root.file_name().and_then(|name| name.to_str());
    match (scope, name) {
        (Some("@codexhost"), Some(name))
            if name.strip_prefix("cli-").is_some_and(|target| {
                !target.is_empty()
                    && target.bytes().all(|byte| {
                        byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-'
                    })
            }) =>
        {
            Ok(format!("@codexhost/{name}"))
        }
        _ => Err(format!("Unknown platform package path: {}", package_root.display()).into()),
    }
}
