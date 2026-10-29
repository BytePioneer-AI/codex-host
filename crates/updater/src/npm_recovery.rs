//! Bounded original-channel recovery after our npm tool has stopped.
use crate::request::NpmInstallation;
use std::error::Error;
use std::path::Path;

pub(crate) fn restore(npm: &NpmInstallation, operation: &Path) -> Result<(), Box<dyn Error>> {
    let prefix = npm
        .prefix
        .as_ref()
        .ok_or("npm recovery has no original prefix")?;
    let metadata = std::fs::symlink_metadata(prefix)?;
    let redirected = metadata.file_type().is_symlink();
    #[cfg(target_os = "windows")]
    let redirected = {
        use std::os::windows::fs::MetadataExt;
        redirected || metadata.file_attributes() & 0x400 != 0
    };
    if !metadata.is_dir()
        || redirected
        || !crate::windows_installation::same_path(prefix, &prefix.canonicalize()?)
    {
        return Err("npm recovery prefix identity changed".into());
    }
    crate::windows_installation::validate_npm_tool(npm)?;
    let materials = npm
        .recovery
        .as_ref()
        .ok_or("npm recovery materials are missing")?;
    crate::npm_prepared::validate_recovery(materials, operation, prefix)?;
    crate::npm_prepared::install(
        &npm.node_path,
        &npm.npm_cli_path,
        materials,
        prefix,
        &mut || Ok(()),
    )
}

#[cfg(target_os = "windows")]
pub(crate) fn restore_files(
    request: &crate::request::UpdateRequest,
) -> Result<String, Box<dyn Error>> {
    let crate::request::Installation::Npm(npm) = &request.installation else {
        return Err("recovery is not an npm installation".into());
    };
    let version = npm
        .installed_version
        .as_ref()
        .ok_or("old npm version is unavailable")?;
    restore(
        npm,
        request
            .status_path
            .parent()
            .ok_or("recovery operation has no directory")?,
    )?;
    crate::install::verify_npm_target(
        npm.prefix.as_ref().ok_or("recovery has no prefix")?,
        version,
        crate::windows_installation::architecture(),
    )?;
    Ok(version.clone())
}
