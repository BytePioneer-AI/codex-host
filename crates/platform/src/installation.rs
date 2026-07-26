#[cfg(target_os = "windows")]
use std::env;
#[cfg(any(target_os = "windows", target_os = "macos"))]
use std::fs::File;
#[cfg(any(target_os = "windows", target_os = "macos"))]
use std::io::Read;
#[cfg(target_os = "macos")]
use std::os::unix::fs::PermissionsExt;
#[cfg(any(target_os = "windows", target_os = "macos"))]
use std::path::{Path, PathBuf};

#[cfg(target_os = "macos")]
use plist::Value;

use super::{DesktopIdentity, DesktopInstallation, PlatformError};
#[cfg(target_os = "windows")]
use super::{
    PROBE_DESKTOP_VERSION_ENV, PROBE_INSTALL_ROOT_ENV, PROBE_PACKAGE_FAMILY_ENV,
    PROBE_PACKAGE_NAME_ENV,
};

#[cfg(target_os = "windows")]
fn files_equal(left: &Path, right: &Path) -> Result<bool, PlatformError> {
    let left_metadata = left.metadata()?;
    let right_metadata = right.metadata()?;
    if left_metadata.len() != right_metadata.len() {
        return Ok(false);
    }

    let mut left_file = File::open(left)?;
    let mut right_file = File::open(right)?;
    let mut left_buffer = vec![0_u8; 1024 * 1024];
    let mut right_buffer = vec![0_u8; 1024 * 1024];

    loop {
        let left_read = left_file.read(&mut left_buffer)?;
        let right_read = right_file.read(&mut right_buffer)?;
        if left_read != right_read {
            return Ok(false);
        }
        if left_read == 0 {
            return Ok(true);
        }
        if left_buffer[..left_read] != right_buffer[..right_read] {
            return Ok(false);
        }
    }
}

#[cfg(target_os = "windows")]
fn find_executable_codex_cli(packaged_cli: &Path) -> Result<PathBuf, PlatformError> {
    let local_app_data = env::var_os("LOCALAPPDATA").ok_or_else(|| {
        PlatformError::NotFound(
            "LOCALAPPDATA is unavailable; cannot locate the Desktop CLI cache".into(),
        )
    })?;
    let cache_root = PathBuf::from(local_app_data).join("OpenAI/Codex/bin");
    let mut candidates = vec![cache_root.join("codex.exe")];

    if let Ok(entries) = cache_root.read_dir() {
        for entry in entries.flatten() {
            if entry.file_type().is_ok_and(|file_type| file_type.is_dir()) {
                candidates.push(entry.path().join("codex.exe"));
            }
        }
    }

    for candidate in candidates {
        if candidate.is_file() && files_equal(packaged_cli, &candidate).unwrap_or(false) {
            return candidate.canonicalize().map_err(PlatformError::Io);
        }
    }

    Err(PlatformError::NotFound(format!(
        "no executable Desktop-managed Codex CLI cache matches '{}'; run the official Desktop once before probing",
        packaged_cli.display()
    )))
}

#[cfg(target_os = "windows")]
pub fn discover_codex_desktop() -> Result<DesktopInstallation, PlatformError> {
    let required = |name: &'static str| {
        env::var_os(name)
            .filter(|value| !value.is_empty())
            .ok_or(PlatformError::NotFound(
                "Gate A installation environment is unavailable; run through tools/gate-a".into(),
            ))
    };
    let package_name = required(PROBE_PACKAGE_NAME_ENV)?
        .to_string_lossy()
        .into_owned();
    let package_family_name = required(PROBE_PACKAGE_FAMILY_ENV)?
        .to_string_lossy()
        .into_owned();
    let version = required(PROBE_DESKTOP_VERSION_ENV)?
        .to_string_lossy()
        .into_owned();
    let install_root = PathBuf::from(required(PROBE_INSTALL_ROOT_ENV)?);
    let desktop_executable = install_root.join("app/ChatGPT.exe");
    let packaged_codex_cli = install_root.join("app/resources/codex.exe");
    if !desktop_executable.is_file() || !packaged_codex_cli.is_file() {
        return Err(PlatformError::NotFound(format!(
            "Codex Desktop package '{}' does not contain the observed app/ChatGPT.exe and app/resources/codex.exe layout",
            install_root.display()
        )));
    }
    let executable_codex_cli = find_executable_codex_cli(&packaged_codex_cli)?;

    Ok(DesktopInstallation {
        identity: DesktopIdentity::WindowsPackage {
            package_name,
            package_family_name,
        },
        version,
        install_root,
        desktop_executable,
        packaged_codex_cli,
        executable_codex_cli,
    })
}

#[cfg(target_os = "macos")]
const CODEX_BUNDLE_IDENTIFIER: &str = "com.openai.codex";
#[cfg(target_os = "macos")]
const MACH_O_MAGICS: [[u8; 4]; 8] = [
    [0xfe, 0xed, 0xfa, 0xce],
    [0xce, 0xfa, 0xed, 0xfe],
    [0xfe, 0xed, 0xfa, 0xcf],
    [0xcf, 0xfa, 0xed, 0xfe],
    [0xca, 0xfe, 0xba, 0xbe],
    [0xbe, 0xba, 0xfe, 0xca],
    [0xca, 0xfe, 0xba, 0xbf],
    [0xbf, 0xba, 0xfe, 0xca],
];

#[cfg(target_os = "macos")]
fn required_string<'a>(
    dictionary: &'a plist::Dictionary,
    key: &str,
    bundle: &Path,
) -> Result<&'a str, PlatformError> {
    dictionary
        .get(key)
        .and_then(Value::as_string)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            PlatformError::Invalid(format!(
                "Codex App '{}' has no string {key}",
                bundle.display()
            ))
        })
}

#[cfg(target_os = "macos")]
fn canonical_executable(path: &Path, label: &str) -> Result<PathBuf, PlatformError> {
    let metadata = path.metadata().map_err(|error| {
        PlatformError::NotFound(format!(
            "{label} '{}' is unavailable: {error}",
            path.display()
        ))
    })?;
    if !metadata.is_file() || metadata.permissions().mode() & 0o111 == 0 {
        return Err(PlatformError::Invalid(format!(
            "{label} '{}' is not an executable file",
            path.display()
        )));
    }
    let mut magic = [0_u8; 4];
    File::open(path)?.read_exact(&mut magic).map_err(|error| {
        PlatformError::Invalid(format!(
            "{label} '{}' has no complete Mach-O header: {error}",
            path.display()
        ))
    })?;
    if !MACH_O_MAGICS.contains(&magic) {
        return Err(PlatformError::Invalid(format!(
            "{label} '{}' is not a Mach-O executable",
            path.display()
        )));
    }
    path.canonicalize().map_err(PlatformError::Io)
}

#[cfg(target_os = "macos")]
fn inspect_bundle(bundle: &Path) -> Result<DesktopInstallation, PlatformError> {
    let bundle = bundle.canonicalize().map_err(|error| {
        PlatformError::NotFound(format!(
            "Codex App bundle '{}' is unavailable: {error}",
            bundle.display()
        ))
    })?;
    let plist_path = bundle.join("Contents/Info.plist");
    let value = Value::from_file(&plist_path).map_err(|error| {
        PlatformError::Invalid(format!(
            "Codex App Info.plist '{}' is invalid: {error}",
            plist_path.display()
        ))
    })?;
    let dictionary = value.as_dictionary().ok_or_else(|| {
        PlatformError::Invalid(format!(
            "Codex App Info.plist '{}' is not a dictionary",
            plist_path.display()
        ))
    })?;
    let bundle_identifier = required_string(dictionary, "CFBundleIdentifier", &bundle)?;
    if bundle_identifier != CODEX_BUNDLE_IDENTIFIER {
        return Err(PlatformError::Invalid(format!(
            "App bundle '{}' has unexpected identifier '{bundle_identifier}'",
            bundle.display()
        )));
    }
    let executable_name = required_string(dictionary, "CFBundleExecutable", &bundle)?;
    if Path::new(executable_name).components().count() != 1 {
        return Err(PlatformError::Invalid(format!(
            "App bundle '{}' has unsafe CFBundleExecutable '{executable_name}'",
            bundle.display()
        )));
    }
    let version = required_string(dictionary, "CFBundleShortVersionString", &bundle)?.to_owned();
    let desktop_executable = canonical_executable(
        &bundle.join("Contents/MacOS").join(executable_name),
        "Desktop executable",
    )?;
    let packaged_codex_cli =
        canonical_executable(&bundle.join("Contents/Resources/codex"), "Codex CLI")?;
    if !desktop_executable.starts_with(&bundle) || !packaged_codex_cli.starts_with(&bundle) {
        return Err(PlatformError::Invalid(format!(
            "App bundle '{}' resolves an executable outside the bundle",
            bundle.display()
        )));
    }

    Ok(DesktopInstallation {
        identity: DesktopIdentity::MacOsBundle {
            bundle_identifier: bundle_identifier.to_owned(),
        },
        version,
        install_root: bundle,
        desktop_executable,
        packaged_codex_cli: packaged_codex_cli.clone(),
        executable_codex_cli: packaged_codex_cli,
    })
}

#[cfg(target_os = "macos")]
fn discover_from_candidates(
    candidates: impl IntoIterator<Item = PathBuf>,
) -> Result<DesktopInstallation, PlatformError> {
    let mut installations = Vec::new();
    let mut invalid = Vec::new();
    for candidate in candidates {
        if !candidate.exists() {
            continue;
        }
        match inspect_bundle(&candidate) {
            Ok(installation) => installations.push(installation),
            Err(error) => invalid.push(format!("{}: {error}", candidate.display())),
        }
    }
    match installations.len() {
        1 => Ok(installations.remove(0)),
        0 if invalid.is_empty() => Err(PlatformError::NotFound(
            "official Codex App was not found in /Applications or ~/Applications".into(),
        )),
        0 => Err(PlatformError::Invalid(format!(
            "no valid official Codex App candidate: {}",
            invalid.join("; ")
        ))),
        _ => Err(PlatformError::Invalid(format!(
            "multiple valid official Codex App installations were found: {}",
            installations
                .iter()
                .map(|installation| installation.install_root.display().to_string())
                .collect::<Vec<_>>()
                .join(", ")
        ))),
    }
}

#[cfg(target_os = "macos")]
pub fn discover_codex_desktop() -> Result<DesktopInstallation, PlatformError> {
    let mut candidates = vec![PathBuf::from("/Applications/Codex.app")];
    if let Some(home) = std::env::var_os("HOME") {
        candidates.push(PathBuf::from(home).join("Applications/Codex.app"));
    }
    discover_from_candidates(candidates)
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub fn discover_codex_desktop() -> Result<DesktopInstallation, PlatformError> {
    Err(PlatformError::Unsupported(
        "the Codex Desktop probe currently supports Windows and macOS only",
    ))
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use std::fs;
    use std::os::unix::fs::{PermissionsExt, symlink};
    use std::path::PathBuf;

    use super::{DesktopIdentity, PlatformError, discover_from_candidates};
    use crate::temporary_directory;

    fn temporary_bundle(name: &str, bundle_identifier: &str, include_cli: bool) -> PathBuf {
        let bundle = temporary_directory("codexhost-platform-bundle").join(name);
        fs::create_dir_all(bundle.join("Contents/MacOS")).expect("create MacOS directory");
        fs::create_dir_all(bundle.join("Contents/Resources")).expect("create Resources directory");
        fs::write(
            bundle.join("Contents/Info.plist"),
            format!(
                concat!(
                    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
                    "<plist version=\"1.0\"><dict>",
                    "<key>CFBundleIdentifier</key><string>{}</string>",
                    "<key>CFBundleExecutable</key><string>ChatGPT</string>",
                    "<key>CFBundleShortVersionString</key><string>1.2.3</string>",
                    "</dict></plist>"
                ),
                bundle_identifier
            ),
        )
        .expect("write plist");
        for path in [
            Some(bundle.join("Contents/MacOS/ChatGPT")),
            include_cli.then(|| bundle.join("Contents/Resources/codex")),
        ]
        .into_iter()
        .flatten()
        {
            fs::write(&path, [0xcf, 0xfa, 0xed, 0xfe]).expect("write Mach-O marker");
            fs::set_permissions(&path, fs::Permissions::from_mode(0o755))
                .expect("make fixture executable");
        }
        bundle
    }

    #[test]
    fn discovers_a_valid_macos_bundle() {
        let bundle = temporary_bundle("Codex.app", "com.openai.codex", true);
        let installation = discover_from_candidates([bundle.clone()]).expect("valid bundle");
        assert_eq!(installation.version, "1.2.3");
        assert_eq!(
            installation.install_root,
            bundle.canonicalize().expect("bundle")
        );
        assert_eq!(
            installation.identity,
            DesktopIdentity::MacOsBundle {
                bundle_identifier: "com.openai.codex".into()
            }
        );
        assert_eq!(
            installation.packaged_codex_cli,
            installation.executable_codex_cli
        );
    }

    #[test]
    fn rejects_wrong_bundle_identity_and_missing_cli() {
        let wrong = temporary_bundle("Wrong.app", "example.invalid", true);
        let missing = temporary_bundle("Missing.app", "com.openai.codex", false);
        assert!(matches!(
            discover_from_candidates([wrong]),
            Err(PlatformError::Invalid(_))
        ));
        assert!(matches!(
            discover_from_candidates([missing]),
            Err(PlatformError::Invalid(_))
        ));
    }

    #[test]
    fn rejects_cli_symlink_outside_bundle() {
        let bundle = temporary_bundle("Codex.app", "com.openai.codex", false);
        let external = bundle.parent().expect("parent").join("external-codex");
        fs::write(&external, [0xcf, 0xfa, 0xed, 0xfe]).expect("write external CLI");
        fs::set_permissions(&external, fs::Permissions::from_mode(0o755))
            .expect("make external CLI executable");
        symlink(&external, bundle.join("Contents/Resources/codex")).expect("link external CLI");
        assert!(matches!(
            discover_from_candidates([bundle]),
            Err(PlatformError::Invalid(_))
        ));
    }

    #[test]
    fn rejects_ambiguous_valid_bundles() {
        let first = temporary_bundle("First.app", "com.openai.codex", true);
        let second = temporary_bundle("Second.app", "com.openai.codex", true);
        assert!(matches!(
            discover_from_candidates([first, second]),
            Err(PlatformError::Invalid(message)) if message.contains("multiple valid")
        ));
    }
}
