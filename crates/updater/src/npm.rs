//! The npm packages that replace a global npm installation of codexhost in place.
use std::borrow::Cow;
use std::error::Error;
use std::path::{Path, PathBuf};
use std::process::Command;

use codexhost_platform::configure_background_command;

const CLI_PACKAGE: &str = "@codexhost/cli";

pub(crate) struct NpmConfiguration {
    registry: String,
    cache: String,
    prefix: String,
    scoped_registry: String,
}

impl NpmConfiguration {
    pub(crate) fn verify(
        node: &Path,
        npm_cli: &Path,
        expected: &str,
    ) -> Result<Self, Box<dyn Error>> {
        let output = npm_command(node, npm_cli)
            .args([
                "config",
                "get",
                "registry",
                "cache",
                "prefix",
                "@codexhost:registry",
                "--global",
            ])
            .output()?;
        if !output.status.success() {
            return Err("Could not resolve the global npm registry, cache and prefix".into());
        }
        let configuration = String::from_utf8(output.stdout)?.replace("\r\n", "\n");
        let configuration = configuration.trim();
        use sha2::{Digest, Sha256};
        if format!("{:x}", Sha256::digest(configuration.as_bytes())) != expected {
            return Err(
                "The global npm registry, cache or prefix changed after download; retry the update"
                    .into(),
            );
        }
        let value = |key: &str| -> Result<String, Box<dyn Error>> {
            configuration
                .lines()
                .filter_map(|line| line.split_once('='))
                .find_map(|(name, value)| {
                    (name == key && !value.is_empty()).then(|| value.to_owned())
                })
                .ok_or_else(|| "Could not resolve the global npm configuration".into())
        };
        let registry = value("registry")?;
        let scoped = value("@codexhost:registry")?;
        Ok(Self {
            scoped_registry: if scoped == "undefined" {
                registry.clone()
            } else {
                scoped
            },
            registry,
            cache: value("cache")?,
            prefix: value("prefix")?,
        })
    }

    pub(crate) fn apply(&self, command: &mut Command) {
        command
            .env("npm_config_registry", &self.registry)
            .env("npm_config_cache", &self.cache)
            .env("npm_config_prefix", &self.prefix)
            .env("npm_config_@codexhost:registry", &self.scoped_registry);
    }
}

pub(crate) struct GlobalInstallation {
    platform_package: String,
    nested_platform_root: PathBuf,
    global_platform_root: PathBuf,
    pub(crate) configuration: Option<NpmConfiguration>,
}

impl GlobalInstallation {
    pub(crate) fn required_specs(&self, version: &str) -> [String; 2] {
        [
            format!("{CLI_PACKAGE}@{version}"),
            format!("{}@{version}", self.platform_package),
        ]
    }

    pub(crate) fn resolved_platform_root(&self) -> PathBuf {
        // The npm launcher resolves its own node_modules before the global sibling.
        let root = if self.nested_platform_root.join("package.json").is_file() {
            &self.nested_platform_root
        } else {
            &self.global_platform_root
        };
        ordinary_npm_path(root).into_owned()
    }

    /// The headless updater stops the previous Host after npm finishes. Preserve the payload
    /// path recorded in its manifest so the previous Shim can still stop that process.
    pub(crate) fn uses_nested_platform(&self, package_root: &Path) -> bool {
        canonical(package_root.to_path_buf()) == self.nested_platform_root
    }
}

/// npm restart paths cross into Node, which distinguishes extended paths from ordinary paths.
pub(crate) fn ordinary_npm_path(path: &Path) -> Cow<'_, Path> {
    #[cfg(windows)]
    {
        use std::ffi::OsString;
        use std::os::windows::ffi::{OsStrExt, OsStringExt};
        use std::path::{Component, Prefix};

        if let Some(Component::Prefix(prefix)) = path.components().next() {
            let (skip, replacement): (usize, &[u16]) = match prefix.kind() {
                Prefix::VerbatimDisk(_) => (4, &[]),
                Prefix::VerbatimUNC(..) => (8, &[b'\\' as u16, b'\\' as u16]),
                _ => return Cow::Borrowed(path),
            };
            let wide: Vec<_> = replacement
                .iter()
                .copied()
                .chain(path.as_os_str().encode_wide().skip(skip))
                .collect();
            return Cow::Owned(PathBuf::from(OsString::from_wide(&wide)));
        }
    }
    Cow::Borrowed(path)
}

pub(crate) fn npm_command(node: &Path, npm_cli: &Path) -> Command {
    let mut command = Command::new(node);
    command.arg(npm_cli);
    if let Some(directory) = npm_cli.parent() {
        command.current_dir(directory);
    }
    configure_background_command(&mut command);
    command
}

/// Finds the supported platform package locations when this npm owns the installation.
pub(crate) fn global_installation(
    node: &Path,
    npm_cli: &Path,
    launcher: &Path,
    package_root: &Path,
) -> Result<Option<GlobalInstallation>, Box<dyn Error>> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        if std::fs::symlink_metadata(package_root)?.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT
            != 0
        {
            return Err(
                "The npm platform package is a link or junction; update it manually with npm"
                    .into(),
            );
        }
    }
    let mut command = npm_command(node, npm_cli);
    command.args(["root", "--global"]);
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
        configuration: None,
    }))
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

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn npm_paths_use_ordinary_drive_and_unc_prefixes() {
        for (input, expected) in [
            (r"\\?\C:\npm\包", r"C:\npm\包"),
            (r"\\?\UNC\server\share\npm", r"\\server\share\npm"),
            (r"C:\npm", r"C:\npm"),
            (r"\\server\share\npm", r"\\server\share\npm"),
            (r"\\?\Volume{example}\npm", r"\\?\Volume{example}\npm"),
        ] {
            assert_eq!(
                ordinary_npm_path(Path::new(input)).as_ref(),
                Path::new(expected)
            );
        }
    }
}
