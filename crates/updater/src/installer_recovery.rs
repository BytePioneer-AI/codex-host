//! Fixed-directory, offline original-Inno recovery using published file ownership.
use crate::request::UpdateRequest;
use crate::{
    installer_files::{self, Manifest},
    request::WindowsInstallation,
};
use serde::Deserialize;
use std::process::Command;
#[cfg(target_os = "windows")]
use std::time::{Duration, Instant};
use std::{
    error::Error,
    fmt, fs,
    path::{Path, PathBuf},
};
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Materials {
    pub installer_path: PathBuf,
    pub artifact_sha256: String,
    pub manifest_path: PathBuf,
    pub manifest_sha256: String,
    pub target_manifest_path: PathBuf,
    pub target_manifest_sha256: String,
    pub replacement_files_path: PathBuf,
    pub protected_roots: Vec<PathBuf>,
}
fn manifests(
    windows: &WindowsInstallation,
    operation: &Path,
    version: &str,
    arch: &str,
) -> Result<(Manifest, Manifest), Box<dyn Error>> {
    let m=windows.recovery.as_ref().ok_or("original installer has no verified file-recovery capability; use manual original-directory repair")?;
    let root = &windows.install_root;
    let canonical = operation.canonicalize()?;
    if installer_files::inside(&root.canonicalize()?, &canonical) {
        return Err("installer recovery materials are inside installation".into());
    }
    for (file, name) in [
        (&windows.installer_path, "update.exe"),
        (&m.installer_path, "previous.exe"),
        (&m.manifest_path, "previous-installer.json"),
        (&m.target_manifest_path, "target-installer.json"),
        (&m.replacement_files_path, "replacement-files.txt"),
    ] {
        if !crate::windows_installation::same_path(file, &operation.join(name)) {
            return Err("installer recovery material path changed".into());
        }
        crate::windows_installation::owned_file(operation, file)?;
    }
    crate::install::verify_artifact(&windows.installer_path, &windows.artifact_sha256)?;
    crate::install::verify_artifact(&m.installer_path, &m.artifact_sha256)?;
    let old = installer_files::sidecar(
        &m.manifest_path,
        &m.manifest_sha256,
        &m.artifact_sha256,
        windows
            .installed_version
            .as_deref()
            .ok_or("missing original version")?,
        &format!("windows-{arch}"),
    )?;
    let next = installer_files::sidecar(
        &m.target_manifest_path,
        &m.target_manifest_sha256,
        &windows.artifact_sha256,
        version,
        &format!("windows-{arch}"),
    )?;
    let previous = operation.join("previous-files.txt");
    crate::windows_installation::owned_file(operation, &previous)?;
    if installer_files::bounded(&previous)? != old.text.as_bytes()
        || installer_files::bounded(&m.replacement_files_path)? != next.text.as_bytes()
    {
        return Err("prepared installer ownership text changed".into());
    }
    Ok((old, next))
}
pub(crate) fn preflight(
    windows: &WindowsInstallation,
    operation: &Path,
    version: &str,
    arch: &str,
) -> Result<(), Box<dyn Error>> {
    let (old, next) = manifests(windows, operation, version, arch)?;
    crate::windows_installation::owned_file(
        &windows.install_root,
        &windows.install_root.join(installer_files::MARKER),
    )?;
    if installer_files::bounded(&windows.install_root.join(installer_files::MARKER))?
        != old.text.as_bytes()
    {
        return Err("installed recovery ownership differs from original release".into());
    }
    installer_files::validate_layout(
        &windows.install_root,
        &old,
        &next,
        &windows
            .recovery
            .as_ref()
            .ok_or("missing recovery")?
            .protected_roots,
        true,
    )?;
    #[cfg(target_os = "windows")]
    {
        let total = old.files.iter().chain(&next.files).try_fold(0u64, |n, f| {
            n.checked_add(f.bytes).ok_or("installer size overflow")
        })?;
        let mut directories = std::collections::BTreeSet::new();
        for f in old.files.iter().chain(&next.files) {
            let file = windows.install_root.join(&f.path);
            let mut parent = file.parent().ok_or("missing software parent")?;
            while !parent.is_dir() {
                parent = parent.parent().ok_or("missing software ancestor")?;
            }
            directories.insert(parent.to_owned());
        }
        for dir in directories {
            codexhost_platform::check_directory_mutation_capacity(&dir, total)?;
        }
    }
    Ok(())
}
pub(crate) fn verify_target(
    windows: &WindowsInstallation,
    operation: &Path,
    version: &str,
    arch: &str,
) -> Result<(), Box<dyn Error>> {
    let (old, next) = manifests(windows, operation, version, arch)?;
    verify_files(&windows.install_root, &next, &old)
}
#[cfg(any(target_os = "windows", test))]
pub(crate) fn stopped_failure(error: Box<dyn Error>) -> Box<dyn Error> {
    Box::new(ToolFailure {
        tool_stopped: true,
        restart_pending: false,
        message: error.to_string(),
    })
}
pub(crate) fn replacement_argument(path: &Path) -> std::ffi::OsString {
    let mut value = std::ffi::OsString::from("/CODEXHOSTREPLACEFILES=");
    value.push(path);
    value
}
pub(crate) fn verify_files(
    root: &Path,
    expected: &Manifest,
    replaced: &Manifest,
) -> Result<(), Box<dyn Error>> {
    for f in &expected.files {
        let path = root.join(&f.path);
        crate::windows_installation::owned_file(root, &path)?;
        if fs::metadata(&path)?.len() != f.bytes {
            return Err("installed software size mismatch".into());
        }
        crate::install::verify_artifact(&path, &f.sha256)?;
    }
    crate::windows_installation::owned_file(root, &root.join(installer_files::MARKER))?;
    if installer_files::bounded(&root.join(installer_files::MARKER))? != expected.text.as_bytes() {
        return Err("installed file capability differs from original tool".into());
    }
    for f in &replaced.files {
        if !expected
            .files
            .iter()
            .any(|own| own.path.eq_ignore_ascii_case(&f.path))
            && root.join(&f.path).try_exists()?
        {
            return Err(
                format!("original tool retained replaced software file: {}", f.path).into(),
            );
        }
    }
    Ok(())
}
#[derive(Debug)]
pub(crate) struct ToolFailure {
    pub tool_stopped: bool,
    pub restart_pending: bool,
    message: String,
}
impl ToolFailure {
    pub(crate) fn may_restore(&self) -> bool {
        self.tool_stopped && !self.restart_pending
    }
}
impl fmt::Display for ToolFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.message.fmt(f)
    }
}
impl Error for ToolFailure {}
#[cfg(target_os = "windows")]
pub(crate) fn run_installer(command: &mut Command, _label: &str) -> Result<(), Box<dyn Error>> {
    let job = codexhost_platform::WindowsLaunchJob::create_unique()?;
    let mut child = job.spawn_supervised(command).map_err(|e| {
        Box::<dyn Error>::from(ToolFailure {
            tool_stopped: false,
            restart_pending: false,
            message: format!("installer spawn/isolation failed: {e}"),
        })
    })?;
    let deadline = Instant::now() + Duration::from_secs(300);
    let mut restart_pending = false;
    let result = loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                restart_pending = status.code() == Some(3010);
                break if status.success() {
                    Ok(())
                } else {
                    Err(if restart_pending {
                        "Inno requested restart; queued writes are unproven; automatic recovery refused".into()
                    } else {
                        format!("Inno failed with {status}")
                    })
                };
            }
            Ok(None) => {}
            Err(e) => break Err(format!("cannot observe Inno exit: {e}")),
        }
        if Instant::now() >= deadline {
            break Err("Inno exceeded execution budget".into());
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    let stopped = job.terminate_and_wait(Duration::from_secs(5));
    match (result, stopped) {
        (Ok(()), Ok(())) => Ok(()),
        (result, stopped) => Err(ToolFailure {
            tool_stopped: stopped.is_ok(),
            restart_pending,
            message: format!(
                "{}; tool cleanup: {:?}",
                result
                    .err()
                    .unwrap_or("installer descendants did not exit".into()),
                stopped.err()
            ),
        }
        .into()),
    }
}
#[cfg(target_os = "windows")]
pub(crate) fn restore_files(request: &UpdateRequest) -> Result<String, Box<dyn Error>> {
    restore_files_with_runner(
        request,
        crate::windows_installation::architecture(),
        |command, label| {
            let crate::request::Installation::WindowsInstaller(windows) = &request.installation
            else {
                return Err("not an EXE installation".into());
            };
            codexhost_platform::WindowsLaunchJob::ensure_no_images_under(&windows.install_root)?;
            run_installer(command, label)
        },
    )
}
#[cfg(any(target_os = "windows", test))]
pub(crate) fn restore_files_with_runner(
    request: &UpdateRequest,
    architecture: &str,
    run: impl FnOnce(&mut Command, &str) -> Result<(), Box<dyn Error>>,
) -> Result<String, Box<dyn Error>> {
    let crate::request::Installation::WindowsInstaller(windows) = &request.installation else {
        return Err("not an EXE installation".into());
    };
    let operation = request.status_path.parent().ok_or("missing operation")?;
    let (old, next) = manifests(windows, operation, &request.version, architecture)?;
    let m = windows
        .recovery
        .as_ref()
        .ok_or("missing original installer")?;
    installer_files::validate_layout(
        &windows.install_root,
        &old,
        &next,
        &m.protected_roots,
        false,
    )?;
    let mut command = Command::new(&m.installer_path);
    command
        .args(crate::install::windows_installer_arguments(windows))
        .arg(replacement_argument(&m.replacement_files_path));
    let mut log = std::ffi::OsString::from("/LOG=");
    log.push(operation.join("restore-inno.log"));
    command.arg(log);
    codexhost_platform::configure_background_command(&mut command);
    run(&mut command, "original Inno installer")?;
    verify_files(&windows.install_root, &old, &next)?;
    crate::windows_installation::metadata(
        &windows.install_root,
        &old.version,
        "installer",
        architecture,
    )?;
    Ok(old.version)
}
#[cfg(test)]
#[path = "installer_recovery_tests.rs"]
mod tests;
