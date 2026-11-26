//! The npm packages that replace a global npm installation of codexhost in place.
use std::error::Error;
use std::path::{Path, PathBuf};
use std::process::Command;

use codexhost_platform::configure_background_command;

const CLI_PACKAGE: &str = "@codexhost/cli";

pub(crate) struct GlobalInstallation {
    platform_package: String,
    nested_platform_root: PathBuf,
    global_platform_root: PathBuf,
}

impl GlobalInstallation {
    pub(crate) fn required_specs(&self, version: &str) -> [String; 2] {
        [
            format!("{CLI_PACKAGE}@{version}"),
            format!("{}@{version}", self.platform_package),
        ]
    }

    pub(crate) fn resolved_platform_root(&self) -> &Path {
        // The npm launcher resolves its own node_modules before the global sibling.
        if self.nested_platform_root.join("package.json").is_file() {
            &self.nested_platform_root
        } else {
            &self.global_platform_root
        }
    }
}

/// Finds the supported platform package locations when this npm owns the installation.
pub(crate) fn global_installation(
    node: &Path,
    npm_cli: &Path,
    launcher: &Path,
    package_root: &Path,
) -> Result<Option<GlobalInstallation>, Box<dyn Error>> {
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
    let platform_package = platform_package_name(&package_root)?;
    let global_cli_root = global_root.join(CLI_PACKAGE);
    let nested_platform_root = global_cli_root.join("node_modules").join(&platform_package);
    let global_platform_root = global_root.join(&platform_package);
    if package_root != global_platform_root
        && (cli_root != global_cli_root || package_root != nested_platform_root)
    {
        return Ok(None);
    }
    Ok(Some(GlobalInstallation {
        platform_package,
        nested_platform_root,
        global_platform_root,
    }))
}

/// The SSH updater restarts the same payload path, so keep its existing npm layout.
pub(crate) fn install_specs(
    node: &Path,
    npm_cli: &Path,
    launcher: &Path,
    package_root: &Path,
    version: &str,
) -> Result<Option<Vec<String>>, Box<dyn Error>> {
    let Some(installation) = global_installation(node, npm_cli, launcher, package_root)? else {
        return Ok(None);
    };
    let mut specs = Vec::from(installation.required_specs(version));
    if canonical(package_root.to_path_buf()) == installation.nested_platform_root {
        specs.pop();
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
