//! Executes only the prevalidated local npm package set; never fetches after exit.
use std::error::Error;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::windows_installation::same_path;
use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Archive {
    pub(crate) path: PathBuf,
    pub(crate) sha256: String,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Materials {
    pub(crate) unpacked_bytes: u64,
    pub(crate) cache_path: PathBuf,
    pub(crate) user_config_path: PathBuf,
    pub(crate) global_config_path: PathBuf,
    pub(crate) cli: Archive,
    pub(crate) platform: Archive,
}

fn regular(path: &Path, directory: bool) -> Result<(), Box<dyn Error>> {
    let info = fs::symlink_metadata(path)?;
    let linked = info.file_type().is_symlink();
    #[cfg(target_os = "windows")]
    let linked = {
        use std::os::windows::fs::MetadataExt;
        linked || info.file_attributes() & 0x400 != 0
    };
    if linked
        || if directory {
            !info.is_dir()
        } else {
            !info.is_file()
        }
    {
        return Err("npm preparation path is redirected or has the wrong file type".into());
    }
    Ok(())
}

pub(crate) fn validate(
    materials: &Materials,
    operation: &Path,
    prefix: &Path,
) -> Result<(), Box<dyn Error>> {
    validate_at(materials, &operation.join("npm"), prefix)
}

pub(crate) fn validate_recovery(
    materials: &Materials,
    operation: &Path,
    prefix: &Path,
) -> Result<(), Box<dyn Error>> {
    validate_at(materials, &operation.join("npm-previous"), prefix)
}

fn validate_at(materials: &Materials, root: &Path, prefix: &Path) -> Result<(), Box<dyn Error>> {
    if !root.is_absolute() || !prefix.is_absolute() || !materials.cache_path.is_absolute() {
        return Err("npm material roots must be absolute".into());
    }
    if materials.unpacked_bytes == 0 || materials.unpacked_bytes > 2 * 1024 * 1024 * 1024 {
        return Err("npm unpacked size is invalid".into());
    }
    regular(root, true)?;
    let root = root.canonicalize()?;
    let prefix = prefix.canonicalize()?;
    if root
        .ancestors()
        .any(|ancestor| same_path(ancestor, &prefix))
    {
        return Err("npm preparation is inside the installed prefix".into());
    }
    for file in [
        &materials.cli.path,
        &materials.platform.path,
        &materials.user_config_path,
        &materials.global_config_path,
    ] {
        regular(file, false)?;
        if !file.is_absolute()
            || !same_path(
                file.canonicalize()?
                    .parent()
                    .ok_or("npm material has no parent")?,
                &root,
            )
        {
            return Err("npm material is outside this update operation".into());
        }
    }
    regular(&materials.cache_path, true)?;
    if !same_path(&materials.cache_path.canonicalize()?, &root.join("cache")) {
        return Err("npm cache is outside this operation".into());
    }
    for file in [&materials.user_config_path, &materials.global_config_path] {
        if fs::metadata(file)?.len() != 0 {
            return Err("npm offline configuration changed after preparation".into());
        }
    }
    if same_path(
        &materials.cli.path.canonicalize()?,
        &materials.platform.path.canonicalize()?,
    ) {
        return Err("npm CLI and platform materials must be distinct".into());
    }
    for archive in [&materials.cli, &materials.platform] {
        let size = fs::metadata(&archive.path)?.len();
        if size == 0 || size > 512 * 1024 * 1024 {
            return Err("npm archive is not a bounded nonempty file".into());
        }
        if archive.sha256.len() != 64
            || !archive
                .sha256
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        {
            return Err("npm prepared archive digest is invalid".into());
        }
        crate::install::verify_artifact(&archive.path, &archive.sha256)?;
    }
    Ok(())
}

#[cfg(target_os = "windows")]
pub(crate) fn preflight(npm: &crate::request::NpmInstallation) -> Result<(), Box<dyn Error>> {
    let prefix = npm.prefix.as_ref().ok_or("npm preflight has no prefix")?;
    let target = npm
        .prepared
        .as_ref()
        .ok_or("npm preflight has no target materials")?;
    let old = npm
        .recovery
        .as_ref()
        .ok_or("npm preflight has no old materials")?;
    let required = target
        .unpacked_bytes
        .checked_add(old.unpacked_bytes)
        .and_then(|bytes| bytes.checked_mul(2))
        .and_then(|bytes| bytes.checked_add(64 * 1024 * 1024))
        .ok_or("npm space estimate overflow")?;
    codexhost_platform::check_directory_mutation_capacity(prefix, required)?;
    for path in [
        prefix.join("node_modules"),
        prefix.join("node_modules/@codexhost"),
    ] {
        codexhost_platform::check_directory_mutation_capacity(&path, 0)?;
    }
    Ok(())
}

pub(crate) fn arguments(materials: &Materials, prefix: &Path) -> Vec<std::ffi::OsString> {
    let mut args = ["install", "--global", "--prefix"]
        .map(std::ffi::OsString::from)
        .to_vec();
    args.push(prefix.as_os_str().to_owned());
    args.extend(
        [
            "--offline",
            "--ignore-scripts",
            "--omit=optional",
            "--force=false",
            "--no-audit",
            "--no-fund",
            "--update-notifier=false",
            "--package-lock=false",
            "--cache",
        ]
        .map(std::ffi::OsString::from),
    );
    args.push(materials.cache_path.as_os_str().to_owned());
    args.push("--userconfig".into());
    args.push(materials.user_config_path.as_os_str().to_owned());
    args.push("--globalconfig".into());
    args.push(materials.global_config_path.as_os_str().to_owned());
    args.push("--".into());
    args.push(materials.cli.path.as_os_str().to_owned());
    args.push(materials.platform.path.as_os_str().to_owned());
    args
}

#[derive(Debug)]
pub(crate) struct InstallFailure {
    pub(crate) tool_stopped: bool,
    message: String,
}
impl std::fmt::Display for InstallFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}
impl Error for InstallFailure {}
pub(crate) fn install_failure(message: String, tool_stopped: bool) -> Box<dyn Error> {
    Box::new(InstallFailure {
        tool_stopped,
        message,
    })
}
fn stop_tool(child: &mut std::process::Child) -> bool {
    if matches!(child.try_wait(), Ok(Some(_))) {
        return true;
    }
    if child.kill().is_err() {
        return matches!(child.try_wait(), Ok(Some(_)));
    }
    child.wait().is_ok()
}

pub(crate) fn install(
    node: &Path,
    npm: &Path,
    materials: &Materials,
    prefix: &Path,
    before_write: &mut dyn FnMut() -> Result<(), Box<dyn Error>>,
) -> Result<(), Box<dyn Error>> {
    let mut command = Command::new(node);
    command
        .arg(npm)
        .args(arguments(materials, prefix))
        .current_dir(
            materials
                .cli
                .path
                .parent()
                .ok_or("npm material has no parent")?,
        )
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    for (key, _) in std::env::vars_os() {
        let name = key.to_string_lossy().to_ascii_lowercase();
        if name.starts_with("npm_config_") || matches!(name.as_str(), "node_options" | "node_path")
        {
            command.env_remove(key);
        }
    }
    codexhost_platform::configure_background_command(&mut command);
    before_write()?;
    let mut child = command
        .spawn()
        .map_err(|error| install_failure(format!("npm could not start: {error}"), true))?;
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                return if status.success() {
                    Ok(())
                } else {
                    Err(install_failure(
                        format!("npm offline installation failed with {status}"),
                        true,
                    ))
                };
            }
            Ok(None) => {}
            Err(error) => {
                let stopped = stop_tool(&mut child);
                return Err(install_failure(
                    format!("cannot observe npm tool exit: {error}"),
                    stopped,
                ));
            }
        }
        if started.elapsed() >= Duration::from_secs(300) {
            let stopped = stop_tool(&mut child);
            return Err(install_failure(
                "npm offline installation exceeded its time limit".into(),
                stopped,
            ));
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[cfg(test)]
#[path = "npm_prepared_tests.rs"]
mod tests;
