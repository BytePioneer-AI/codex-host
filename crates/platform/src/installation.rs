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
#[cfg(any(target_os = "windows", target_os = "macos"))]
use sha2::{Digest, Sha256};
#[cfg(target_os = "windows")]
use windows::Management::Deployment::PackageManager;
#[cfg(target_os = "windows")]
use windows::core::HSTRING;

use super::{DesktopIdentity, DesktopInstallation, PlatformError};

#[cfg(any(target_os = "windows", target_os = "macos"))]
fn sha256_file(path: &Path) -> Result<String, PlatformError> {
    let metadata = path.metadata().map_err(|error| {
        PlatformError::NotFound(format!(
            "Codex Desktop resource '{}' is unavailable: {error}",
            path.display()
        ))
    })?;
    if !metadata.is_file() {
        return Err(PlatformError::Invalid(format!(
            "Codex Desktop resource '{}' is not a regular file",
            path.display()
        )));
    }
    let mut file = File::open(path)?;
    let mut digest = Sha256::new();
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(format!("sha256:{:x}", digest.finalize()))
}
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
const WINDOWS_CODEX_PACKAGE_NAME: &str = "OpenAI.Codex";

#[cfg(target_os = "windows")]
#[derive(Clone, Debug, PartialEq, Eq)]
struct WindowsPackageDetails {
    package_name: String,
    package_family_name: String,
    version: String,
    install_root: PathBuf,
}

#[cfg(target_os = "windows")]
fn find_executable_codex_cli(
    packaged_cli: &Path,
    local_app_data: &Path,
) -> Result<PathBuf, PlatformError> {
    let cache_root = local_app_data.join("OpenAI/Codex/bin");
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
        "no executable Desktop-managed Codex CLI cache matches '{}'; run the official Desktop once before launching codexhost",
        packaged_cli.display()
    )))
}

#[cfg(target_os = "windows")]
fn probe_package_details(
    value: impl Fn(&'static str) -> Option<std::ffi::OsString>,
) -> Result<Option<WindowsPackageDetails>, PlatformError> {
    let values = [
        (PROBE_PACKAGE_NAME_ENV, value(PROBE_PACKAGE_NAME_ENV)),
        (PROBE_PACKAGE_FAMILY_ENV, value(PROBE_PACKAGE_FAMILY_ENV)),
        (PROBE_DESKTOP_VERSION_ENV, value(PROBE_DESKTOP_VERSION_ENV)),
        (PROBE_INSTALL_ROOT_ENV, value(PROBE_INSTALL_ROOT_ENV)),
    ];
    let present = values
        .iter()
        .filter(|(_, value)| value.as_ref().is_some_and(|value| !value.is_empty()))
        .count();
    if present == 0 {
        return Ok(None);
    }
    if present != values.len() {
        return Err(PlatformError::Invalid(
            "Gate A installation override must set all package identity, version, and root variables"
                .into(),
        ));
    }
    let text = |index: usize| {
        values[index]
            .1
            .as_ref()
            .expect("complete Gate A override")
            .to_string_lossy()
            .into_owned()
    };
    Ok(Some(WindowsPackageDetails {
        package_name: text(0),
        package_family_name: text(1),
        version: text(2),
        install_root: PathBuf::from(values[3].1.as_ref().expect("complete Gate A override")),
    }))
}

#[cfg(target_os = "windows")]
fn windows_api_error(context: &str, error: windows::core::Error) -> PlatformError {
    PlatformError::Invalid(format!("{context}: {error}"))
}

#[cfg(target_os = "windows")]
fn discover_installed_windows_package() -> Result<WindowsPackageDetails, PlatformError> {
    let manager = PackageManager::new()
        .map_err(|error| windows_api_error("cannot initialize Windows PackageManager", error))?;
    let packages = manager
        .FindPackagesByUserSecurityId(&HSTRING::new())
        .map_err(|error| windows_api_error("cannot enumerate current-user AppX packages", error))?;
    let mut candidates = Vec::new();
    for package in packages {
        let id = package
            .Id()
            .map_err(|error| windows_api_error("cannot read AppX package identity", error))?;
        let package_name = id
            .Name()
            .map_err(|error| windows_api_error("cannot read AppX package name", error))?
            .to_string_lossy();
        if package_name != WINDOWS_CODEX_PACKAGE_NAME {
            continue;
        }
        let package_version = id
            .Version()
            .map_err(|error| windows_api_error("cannot read Codex package version", error))?;
        let version_key = [
            package_version.Major,
            package_version.Minor,
            package_version.Build,
            package_version.Revision,
        ];
        let package_family_name = id
            .FamilyName()
            .map_err(|error| windows_api_error("cannot read Codex package family", error))?
            .to_string_lossy();
        let install_root = package
            .InstalledLocation()
            .and_then(|folder| folder.Path())
            .map_err(|error| windows_api_error("cannot read Codex install location", error))?;
        candidates.push((
            version_key,
            WindowsPackageDetails {
                package_name,
                package_family_name,
                version: format!(
                    "{}.{}.{}.{}",
                    version_key[0], version_key[1], version_key[2], version_key[3]
                ),
                install_root: PathBuf::from(install_root.to_string_lossy()),
            },
        ));
    }
    candidates
        .into_iter()
        .max_by_key(|(version, _)| *version)
        .map(|(_, details)| details)
        .ok_or_else(|| {
            PlatformError::NotFound(
                "official OpenAI.Codex AppX package is not installed for the current user".into(),
            )
        })
}

#[cfg(target_os = "windows")]
fn windows_installation(
    details: WindowsPackageDetails,
    local_app_data: &Path,
) -> Result<DesktopInstallation, PlatformError> {
    let install_root = details.install_root.canonicalize().map_err(|error| {
        PlatformError::NotFound(format!(
            "Codex Desktop package '{}' is unavailable: {error}",
            details.install_root.display()
        ))
    })?;
    let desktop_executable = install_root.join("app/ChatGPT.exe");
    let packaged_codex_cli = install_root.join("app/resources/codex.exe");
    let asar_path = install_root.join("app/resources/app.asar");
    if !desktop_executable.is_file() || !packaged_codex_cli.is_file() || !asar_path.is_file() {
        return Err(PlatformError::NotFound(format!(
            "Codex Desktop package '{}' does not contain the required executable, CLI, and app.asar resources",
            install_root.display()
        )));
    }
    let executable_codex_cli = find_executable_codex_cli(&packaged_codex_cli, local_app_data)?;

    Ok(DesktopInstallation {
        identity: DesktopIdentity::WindowsPackage {
            package_name: details.package_name,
            package_family_name: details.package_family_name,
        },
        build: details.version.clone(),
        version: details.version,
        asar_integrity: sha256_file(&asar_path)?,
        install_root,
        desktop_executable,
        packaged_codex_cli,
        executable_codex_cli,
    })
}

#[cfg(target_os = "windows")]
pub fn discover_codex_desktop() -> Result<DesktopInstallation, PlatformError> {
    let details =
        probe_package_details(env::var_os)?.map_or_else(discover_installed_windows_package, Ok)?;
    let local_app_data = env::var_os("LOCALAPPDATA").ok_or_else(|| {
        PlatformError::NotFound(
            "LOCALAPPDATA is unavailable; cannot locate the Desktop CLI cache".into(),
        )
    })?;
    windows_installation(details, &PathBuf::from(local_app_data))
}

#[cfg(all(test, target_os = "windows"))]
mod windows_tests {
    use std::collections::HashMap;
    use std::ffi::OsString;
    use std::fs;
    use std::path::PathBuf;

    use super::{WindowsPackageDetails, probe_package_details, windows_installation};
    use crate::{DesktopIdentity, PlatformError, temporary_directory};
    use crate::{
        PROBE_DESKTOP_VERSION_ENV, PROBE_INSTALL_ROOT_ENV, PROBE_PACKAGE_FAMILY_ENV,
        PROBE_PACKAGE_NAME_ENV,
    };

    #[test]
    fn gate_override_is_optional_but_must_be_complete() {
        assert_eq!(
            probe_package_details(|_| None).expect("no Gate override"),
            None
        );

        let partial = HashMap::from([(PROBE_PACKAGE_NAME_ENV, OsString::from("OpenAI.Codex"))]);
        let error = probe_package_details(|name| partial.get(name).cloned())
            .expect_err("partial Gate override must fail");
        assert!(
            matches!(error, PlatformError::Invalid(message) if message.contains("must set all"))
        );

        let complete = HashMap::from([
            (PROBE_PACKAGE_NAME_ENV, OsString::from("OpenAI.Codex")),
            (
                PROBE_PACKAGE_FAMILY_ENV,
                OsString::from("OpenAI.Codex_family"),
            ),
            (PROBE_DESKTOP_VERSION_ENV, OsString::from("1.2.3.4")),
            (PROBE_INSTALL_ROOT_ENV, OsString::from("C:\\Codex")),
        ]);
        assert_eq!(
            probe_package_details(|name| complete.get(name).cloned())
                .expect("complete Gate override"),
            Some(WindowsPackageDetails {
                package_name: "OpenAI.Codex".into(),
                package_family_name: "OpenAI.Codex_family".into(),
                version: "1.2.3.4".into(),
                install_root: PathBuf::from("C:\\Codex"),
            })
        );
    }

    #[test]
    fn validates_package_layout_and_matches_the_desktop_cli_cache() {
        let root = temporary_directory("codexhost-windows-installation");
        let install_root = root.join("WindowsApps/OpenAI.Codex_1.2.3.4_x64");
        let desktop = install_root.join("app/ChatGPT.exe");
        let packaged_cli = install_root.join("app/resources/codex.exe");
        let app_asar = install_root.join("app/resources/app.asar");
        fs::create_dir_all(desktop.parent().expect("Desktop parent"))
            .expect("create Desktop directory");
        fs::create_dir_all(packaged_cli.parent().expect("CLI parent"))
            .expect("create CLI directory");
        fs::write(&desktop, b"desktop").expect("write Desktop executable");
        fs::write(&packaged_cli, b"matching codex cli").expect("write packaged CLI");
        fs::write(&app_asar, b"reviewed app asar").expect("write app.asar");

        let local_app_data = root.join("LocalAppData");
        let cached_cli = local_app_data.join("OpenAI/Codex/bin/version/codex.exe");
        fs::create_dir_all(cached_cli.parent().expect("cache parent")).expect("create CLI cache");
        fs::write(&cached_cli, b"matching codex cli").expect("write cached CLI");

        let installation = windows_installation(
            WindowsPackageDetails {
                package_name: "OpenAI.Codex".into(),
                package_family_name: "OpenAI.Codex_family".into(),
                version: "1.2.3.4".into(),
                install_root: install_root.clone(),
            },
            &local_app_data,
        )
        .expect("valid Windows installation");

        assert_eq!(
            installation.identity,
            DesktopIdentity::WindowsPackage {
                package_name: "OpenAI.Codex".into(),
                package_family_name: "OpenAI.Codex_family".into(),
            }
        );
        assert_eq!(installation.version, "1.2.3.4");
        assert_eq!(installation.build, "1.2.3.4");
        assert!(installation.asar_integrity.starts_with("sha256:"));
        assert_eq!(
            installation.install_root,
            install_root.canonicalize().expect("canonical install root")
        );
        assert_eq!(
            installation.executable_codex_cli,
            cached_cli.canonicalize().expect("canonical cached CLI")
        );

        fs::remove_dir_all(root).expect("remove Windows installation fixture");
    }
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
fn macos_asar_integrity(
    dictionary: &plist::Dictionary,
    bundle: &Path,
) -> Result<String, PlatformError> {
    let official = dictionary
        .get("ElectronAsarIntegrity")
        .and_then(Value::as_dictionary)
        .and_then(|entries| entries.get("Resources/app.asar"))
        .and_then(Value::as_dictionary)
        .and_then(|entry| {
            let algorithm = entry.get("algorithm")?.as_string()?;
            let hash = entry.get("hash")?.as_string()?;
            (algorithm == "SHA256"
                && hash.len() == 64
                && hash.bytes().all(|byte| byte.is_ascii_hexdigit()))
            .then(|| format!("sha256:{}", hash.to_ascii_lowercase()))
        });
    official.map_or_else(
        || sha256_file(&bundle.join("Contents/Resources/app.asar")),
        Ok,
    )
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
    let build = required_string(dictionary, "CFBundleVersion", &bundle)?.to_owned();
    let asar_integrity = macos_asar_integrity(dictionary, &bundle)?;
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
        build,
        asar_integrity,
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
    let mut candidates = vec![
        PathBuf::from("/Applications/Codex.app"),
        PathBuf::from("/Applications/ChatGPT.app"),
    ];
    if let Some(home) = std::env::var_os("HOME") {
        let applications = PathBuf::from(home).join("Applications");
        candidates.push(applications.join("Codex.app"));
        candidates.push(applications.join("ChatGPT.app"));
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
                    "<key>CFBundleVersion</key><string>456</string>",
                    "</dict></plist>"
                ),
                bundle_identifier
            ),
        )
        .expect("write plist");
        fs::write(
            bundle.join("Contents/Resources/app.asar"),
            b"reviewed app asar",
        )
        .expect("write app.asar");
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
    fn discovers_a_valid_macos_bundle_under_current_or_legacy_app_names() {
        for app_name in ["Codex.app", "ChatGPT.app"] {
            let bundle = temporary_bundle(app_name, "com.openai.codex", true);
            let installation = discover_from_candidates([bundle.clone()]).expect("valid bundle");
            assert_eq!(installation.version, "1.2.3");
            assert_eq!(installation.build, "456");
            assert!(installation.asar_integrity.starts_with("sha256:"));
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
