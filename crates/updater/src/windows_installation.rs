//! Validates the fixed Windows installation again immediately before replacement.

use std::error::Error;
use std::fs;
use std::path::Path;

use serde_json::Value;

use crate::request::{NpmInstallation, WindowsInstallation};

pub(crate) fn same_path(left: &Path, right: &Path) -> bool {
    let key = |path: &Path| {
        let text = path.to_string_lossy().replace('/', "\\");
        let text = text.strip_prefix("\\\\?\\").unwrap_or(&text);
        if cfg!(target_os = "windows") {
            text.to_lowercase()
        } else {
            text.to_owned()
        }
    };
    key(left) == key(right)
}

pub(crate) fn owned_file(root: &Path, file: &Path) -> Result<(), Box<dyn Error>> {
    let prefix = file
        .components()
        .take(root.components().count())
        .collect::<std::path::PathBuf>();
    if !same_path(root, &prefix) {
        return Err("Windows installation path escapes its root".into());
    }
    let relative = file
        .components()
        .skip(root.components().count())
        .collect::<std::path::PathBuf>();
    if relative
        .components()
        .any(|part| !matches!(part, std::path::Component::Normal(_)))
    {
        return Err("Windows installation path has ambiguous components".into());
    }
    let mut current = root.to_path_buf();
    for part in std::iter::once(None).chain(relative.components().map(Some)) {
        if let Some(part) = part {
            current.push(part);
        }
        let info = fs::symlink_metadata(&current)?;
        let linked = info.file_type().is_symlink();
        #[cfg(target_os = "windows")]
        let linked = {
            use std::os::windows::fs::MetadataExt;
            linked || info.file_attributes() & 0x400 != 0
        };
        if linked {
            return Err("Windows installation links are unsupported".into());
        }
    }
    if !fs::metadata(file)?.is_file()
        || !same_path(&file.canonicalize()?, &root.canonicalize()?.join(relative))
    {
        return Err("Windows installation file is redirected or not regular".into());
    }
    Ok(())
}

fn manifest(root: &Path) -> Result<Value, Box<dyn Error>> {
    Ok(serde_json::from_slice(&fs::read(
        root.join("package.json"),
    )?)?)
}

pub(crate) fn metadata(
    root: &Path,
    version: &str,
    distribution: &str,
    arch: &str,
) -> Result<(), Box<dyn Error>> {
    let file = root.join("app/codexhost-distribution.json");
    owned_file(root, &file)?;
    let value = serde_json::from_slice::<crate::install::DistributionMetadata>(&fs::read(file)?)?;
    if value.schema_version != 1
        || value.version != version
        || value.distribution != distribution
        || value.target != format!("windows-{arch}")
    {
        return Err("Windows installed distribution identity changed or does not match".into());
    }
    crate::request::validate_version(version)?;
    Ok(())
}

pub(crate) fn validate_npm(
    npm: &NpmInstallation,
    arch: &str,
    owner: &Path,
) -> Result<(), Box<dyn Error>> {
    let prefix = npm
        .prefix
        .as_deref()
        .ok_or("Windows npm request is missing its verified prefix")?;
    let root = npm
        .package_root
        .as_deref()
        .ok_or("Windows npm request is missing its platform package root")?;
    let version = npm
        .installed_version
        .as_deref()
        .ok_or("Windows npm request is missing its installed version")?;
    if !prefix.is_absolute() || !root.is_absolute() || !matches!(arch, "x64" | "arm64") {
        return Err("Windows npm installation identity is invalid".into());
    }
    let cli_root = prefix.join("node_modules/@codexhost/cli");
    let entry = cli_root.join("bin/codexhost.js");
    if !same_path(&npm.npm_launcher_path, &entry) {
        return Err("Windows npm entry is outside its global prefix".into());
    }
    let name = format!("@codexhost/cli-win32-{arch}");
    let nested = cli_root.join("node_modules").join(&name);
    let expected = if fs::symlink_metadata(&nested).is_ok() {
        nested
    } else {
        prefix.join("node_modules").join(&name)
    };
    if !same_path(root, &expected) {
        return Err("Windows npm platform package does not belong to this CLI entry".into());
    }
    let binary = root.join("bin/codexhost.exe");
    for file in [
        &entry,
        &cli_root.join("package.json"),
        &root.join("package.json"),
        &binary,
        &prefix.join("codexhost.cmd"),
    ] {
        owned_file(prefix, file)?;
    }
    metadata(root, version, "npm", arch)?;
    let cli = manifest(&cli_root)?;
    let platform = manifest(root)?;
    if cli["name"] != "@codexhost/cli"
        || cli["version"] != version
        || cli["bin"]["codexhost"] != "bin/codexhost.js"
        || cli["optionalDependencies"][&name] != version
        || platform["name"] != name
        || platform["version"] != version
        || platform["os"] != serde_json::json!(["win32"])
        || platform["cpu"] != serde_json::json!([arch])
    {
        return Err(
            "Windows npm package version, target or dependency identity does not match".into(),
        );
    }
    let shim = fs::read_to_string(prefix.join("codexhost.cmd"))?
        .replace('/', "\\")
        .to_lowercase();
    if !shim.contains("\"%dp0%\\node_modules\\@codexhost\\cli\\bin\\codexhost.js\"") {
        return Err("Windows npm global shim does not target this CLI".into());
    }
    validate_npm_tool(npm)?;
    let owner = owner.canonicalize()?;
    if !same_path(&owner, &binary.canonicalize()?)
        && !same_path(&owner, &npm.node_path.canonicalize()?)
    {
        return Err("Windows npm owner is outside this installation".into());
    }
    Ok(())
}

pub(crate) fn validate_npm_tool(npm: &NpmInstallation) -> Result<(), Box<dyn Error>> {
    let root = npm
        .npm_cli_path
        .parent()
        .and_then(Path::parent)
        .ok_or("invalid npm CLI path")?;
    if !npm.node_path.is_absolute()
        || !npm.node_path.is_file()
        || !same_path(&npm.npm_cli_path, &root.join("bin/npm-cli.js"))
        || manifest(root)?["name"] != "npm"
    {
        return Err("unverified npm CLI or Node executable".into());
    }
    Ok(())
}

pub(crate) fn validate_installer(
    windows: &WindowsInstallation,
    arch: &str,
    owner: &Path,
) -> Result<(), Box<dyn Error>> {
    let version = windows
        .installed_version
        .as_deref()
        .ok_or("Windows installer request is missing its installed version")?;
    metadata(&windows.install_root, version, "installer", arch)?;
    let owner = owner.canonicalize()?;
    for relative in ["bin/codexhost.exe", "runtime/node.exe"] {
        let candidate = windows.install_root.join(relative);
        if same_path(&owner, &candidate.canonicalize()?) {
            return owned_file(&windows.install_root, &candidate);
        }
    }
    Err("Windows installer owner is outside this installation".into())
}

#[cfg(target_os = "windows")]
pub(crate) fn architecture() -> &'static str {
    if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        "x64"
    }
}

#[cfg(test)]
#[path = "windows_installation_tests.rs"]
mod tests;
