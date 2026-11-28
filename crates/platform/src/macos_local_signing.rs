use std::error::Error;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
#[cfg(target_os = "macos")]
use std::process::Command;

use serde::{Deserialize, Serialize};

pub const MACOS_LOCAL_SIGNING_FILE: &str = "macos-local-signing-v1.json";
pub const DEFAULT_LOCAL_SIGNING_CERT_NAME: &str = "CodexHost Local Signer";
const SCHEMA_VERSION: u8 = 1;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MacOsLocalSigningConfig {
    pub version: u8,
    pub enabled: bool,
    pub certificate_name: String,
    pub certificate_sha1: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MacOsLocalSigningStatus {
    pub supported: bool,
    pub enabled: bool,
    pub certificate_present: bool,
    pub app_signed_with_local_cert: bool,
    pub app_path: Option<String>,
    pub certificate_name: String,
    pub certificate_sha1: Option<String>,
}

pub fn read_macos_local_signing_config(
    data_dir: &Path,
) -> Result<Option<MacOsLocalSigningConfig>, Box<dyn Error>> {
    let path = data_dir.join(MACOS_LOCAL_SIGNING_FILE);
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let config: MacOsLocalSigningConfig = serde_json::from_slice(&bytes)
        .map_err(|error| format!("invalid {MACOS_LOCAL_SIGNING_FILE}: {error}"))?;
    if config.version != SCHEMA_VERSION {
        return Ok(None);
    }
    if !is_valid_sha1(&config.certificate_sha1) {
        return Err(format!(
            "invalid certificateSha1 in {MACOS_LOCAL_SIGNING_FILE}: {}",
            config.certificate_sha1
        )
        .into());
    }
    Ok(Some(config))
}

pub fn write_macos_local_signing_config(
    data_dir: &Path,
    config: &MacOsLocalSigningConfig,
) -> Result<(), Box<dyn Error>> {
    if !is_valid_sha1(&config.certificate_sha1) {
        return Err("certificateSha1 must be a 40-character hexadecimal SHA-1 fingerprint".into());
    }
    fs::create_dir_all(data_dir)?;
    let target = data_dir.join(MACOS_LOCAL_SIGNING_FILE);
    let temp = data_dir.join(format!(
        ".{MACOS_LOCAL_SIGNING_FILE}.{}.tmp",
        std::process::id()
    ));
    let content = format!("{}\n", serde_json::to_string_pretty(config)?);
    fs::write(&temp, content)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&temp, fs::Permissions::from_mode(0o600))?;
    }
    fs::rename(&temp, &target)?;
    Ok(())
}

pub fn remove_macos_local_signing_config(data_dir: &Path) -> Result<(), Box<dyn Error>> {
    let target = data_dir.join(MACOS_LOCAL_SIGNING_FILE);
    match fs::remove_file(target) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

pub fn is_valid_sha1(value: &str) -> bool {
    value.len() == 40 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

#[cfg(any(target_os = "macos", test))]
pub fn parse_openssl_sha1_fingerprint(output: &str) -> Option<String> {
    let line = output
        .lines()
        .find(|line| line.to_ascii_lowercase().contains("fingerprint"))?;
    let (_, raw) = line.split_once('=')?;
    let normalized: String = raw
        .chars()
        .filter(|character| character.is_ascii_hexdigit())
        .map(|character| character.to_ascii_uppercase())
        .collect();
    is_valid_sha1(&normalized).then_some(normalized)
}

#[cfg(any(target_os = "macos", test))]
pub fn parse_designated_certificate_leaf_sha1(output: &str) -> Option<String> {
    let marker = "certificate leaf = H\"";
    let start = output.find(marker)? + marker.len();
    let rest = &output[start..];
    let end = rest.find('"')?;
    let candidate = rest[..end].to_ascii_uppercase();
    is_valid_sha1(&candidate).then_some(candidate)
}

#[cfg(any(target_os = "macos", test))]
pub fn openssl_codesign_config(common_name: &str) -> String {
    let safe_cn = common_name.replace(['\r', '\n'], " ");
    format!(
        "[req]\n\
         distinguished_name = dn\n\
         x509_extensions = v3_codesign\n\
         prompt = no\n\
         \n\
         [dn]\n\
         CN = {safe_cn}\n\
         \n\
         [v3_codesign]\n\
         basicConstraints = critical,CA:FALSE\n\
         keyUsage = critical,digitalSignature\n\
         extendedKeyUsage = codeSigning\n"
    )
}

/// Inner binaries and nested bundles to sign in dependency order before the app root.
#[cfg(any(target_os = "macos", test))]
pub fn macos_app_signing_targets(app_path: &Path) -> Vec<PathBuf> {
    let contents = app_path.join("Contents");
    let resources = contents.join("Resources");
    let candidates = [
        resources.join("runtime/node"),
        resources.join("libexec/codexhost-shim"),
        resources.join("libexec/codexhost-updater"),
        contents.join("Helpers/CodexHost.app/Contents/MacOS/CodexHost"),
        contents.join("Helpers/CodexHost.app"),
        resources.join("libexec/codexhost-shell"),
        contents.join("MacOS/codexhost"),
    ];
    let mut targets: Vec<PathBuf> = candidates
        .into_iter()
        .filter(|path| path.exists())
        .collect();
    targets.push(app_path.to_path_buf());
    targets
}

#[cfg(target_os = "macos")]
fn login_keychain_path() -> Result<PathBuf, Box<dyn Error>> {
    let home = std::env::var_os("HOME").ok_or("HOME directory is unavailable")?;
    Ok(PathBuf::from(home).join("Library/Keychains/login.keychain-db"))
}

#[cfg(target_os = "macos")]
fn random_passphrase() -> Result<String, Box<dyn Error>> {
    use sha2::{Digest, Sha256};
    let mut entropy = [0_u8; 32];
    let mut file = fs::File::open("/dev/urandom")?;
    std::io::Read::read_exact(&mut file, &mut entropy)?;
    let digest = Sha256::digest(entropy);
    Ok(digest.iter().map(|byte| format!("{byte:02x}")).collect())
}

#[cfg(target_os = "macos")]
fn identity_exists_in_keychain(sha1: &str, valid_only: bool) -> bool {
    let mut command = Command::new("/usr/bin/security");
    command.arg("find-identity");
    if valid_only {
        command.arg("-v");
    }
    command.args(["-p", "codesigning"]);
    if let Ok(keychain) = login_keychain_path()
        && keychain.is_file()
    {
        command.arg(&keychain);
    }
    let Ok(output) = command.output() else {
        return false;
    };
    if !output.status.success() {
        return false;
    }
    let stdout = String::from_utf8_lossy(&output.stdout).to_ascii_uppercase();
    stdout.contains(&sha1.to_ascii_uppercase())
}

#[cfg(target_os = "macos")]
fn app_leaf_certificate_sha1(app_path: &Path) -> Option<String> {
    if !app_path.is_dir() {
        return None;
    }
    let output = Command::new("/usr/bin/codesign")
        .args(["-d", "-r-"])
        .arg(app_path)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let combined = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    parse_designated_certificate_leaf_sha1(&combined)
}

#[cfg(target_os = "macos")]
pub fn sign_macos_app_bundle(app_path: &Path, identity: &str) -> Result<(), Box<dyn Error>> {
    if !app_path.is_dir() || !app_path.join("Contents/MacOS/codexhost").is_file() {
        return Err(format!(
            "expected a codexhost macOS app bundle at {}",
            app_path.display()
        )
        .into());
    }
    for target in macos_app_signing_targets(app_path) {
        let output = Command::new("/usr/bin/codesign")
            .args(["--force", "--sign", identity])
            .arg(&target)
            .output()?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!(
                "codesign failed for {}: {}",
                target.display(),
                stderr.trim()
            )
            .into());
        }
    }
    let verify = Command::new("/usr/bin/codesign")
        .args(["--verify", "--deep", "--strict"])
        .arg(app_path)
        .output()?;
    if !verify.status.success() {
        let stderr = String::from_utf8_lossy(&verify.stderr);
        return Err(format!(
            "codesign verification failed for {}: {}",
            app_path.display(),
            stderr.trim()
        )
        .into());
    }
    Ok(())
}

#[cfg(target_os = "macos")]
pub fn inspect_macos_local_signing(
    data_dir: &Path,
    app_path: Option<&Path>,
) -> Result<MacOsLocalSigningStatus, Box<dyn Error>> {
    let config = read_macos_local_signing_config(data_dir)?;
    let resolved_app = app_path.filter(|path| path.is_dir());
    let (enabled, certificate_name, certificate_sha1) = match config {
        Some(config) => (
            config.enabled,
            config.certificate_name,
            Some(config.certificate_sha1),
        ),
        None => (false, DEFAULT_LOCAL_SIGNING_CERT_NAME.to_string(), None),
    };
    let certificate_present = certificate_sha1
        .as_deref()
        .is_some_and(|sha1| identity_exists_in_keychain(sha1, true));
    let app_signed_with_local_cert = match (resolved_app, certificate_sha1.as_deref()) {
        (Some(app), Some(sha1)) => {
            app_leaf_certificate_sha1(app).is_some_and(|leaf| leaf.eq_ignore_ascii_case(sha1))
        }
        _ => false,
    };
    Ok(MacOsLocalSigningStatus {
        supported: true,
        enabled,
        certificate_present,
        app_signed_with_local_cert,
        app_path: resolved_app.map(|path| path.display().to_string()),
        certificate_name,
        certificate_sha1,
    })
}

#[cfg(not(target_os = "macos"))]
pub fn inspect_macos_local_signing(
    _data_dir: &Path,
    _app_path: Option<&Path>,
) -> Result<MacOsLocalSigningStatus, Box<dyn Error>> {
    Ok(MacOsLocalSigningStatus {
        supported: false,
        enabled: false,
        certificate_present: false,
        app_signed_with_local_cert: false,
        app_path: None,
        certificate_name: DEFAULT_LOCAL_SIGNING_CERT_NAME.to_string(),
        certificate_sha1: None,
    })
}

#[cfg(target_os = "macos")]
fn create_and_trust_local_certificate(common_name: &str) -> Result<String, Box<dyn Error>> {
    use std::os::unix::fs::PermissionsExt;

    let keychain = login_keychain_path()?;
    let temp_dir = std::env::temp_dir().join(format!(
        "codexhost-local-signing-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0)
    ));
    fs::create_dir_all(&temp_dir)?;
    fs::set_permissions(&temp_dir, fs::Permissions::from_mode(0o700))?;

    let result = (|| -> Result<String, Box<dyn Error>> {
        let config_path = temp_dir.join("openssl.cnf");
        let key_path = temp_dir.join("signer.key");
        let cert_path = temp_dir.join("signer.crt");
        let p12_path = temp_dir.join("signer.p12");
        fs::write(&config_path, openssl_codesign_config(common_name))?;

        let req_output = Command::new("/usr/bin/openssl")
            .args([
                "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "3650", "-keyout",
            ])
            .arg(&key_path)
            .arg("-out")
            .arg(&cert_path)
            .arg("-config")
            .arg(&config_path)
            .output()?;
        if !req_output.status.success() {
            return Err(format!(
                "openssl certificate generation failed: {}",
                String::from_utf8_lossy(&req_output.stderr).trim()
            )
            .into());
        }

        let fp_output = Command::new("/usr/bin/openssl")
            .args(["x509", "-in"])
            .arg(&cert_path)
            .args(["-noout", "-fingerprint", "-sha1"])
            .output()?;
        if !fp_output.status.success() {
            return Err("could not compute local signing certificate SHA-1 fingerprint".into());
        }
        let sha1 = parse_openssl_sha1_fingerprint(&String::from_utf8_lossy(&fp_output.stdout))
            .ok_or("could not parse local signing certificate SHA-1 fingerprint")?;

        let passphrase = random_passphrase()?;
        let p12_output = Command::new("/usr/bin/openssl")
            .args(["pkcs12", "-export", "-in"])
            .arg(&cert_path)
            .arg("-inkey")
            .arg(&key_path)
            .arg("-out")
            .arg(&p12_path)
            .args(["-passout", "env:CODEXHOST_P12_PASS"])
            .env("CODEXHOST_P12_PASS", &passphrase)
            .output()?;
        if !p12_output.status.success() {
            return Err(format!(
                "openssl PKCS#12 export failed: {}",
                String::from_utf8_lossy(&p12_output.stderr).trim()
            )
            .into());
        }

        let import_output = Command::new("/usr/bin/security")
            .arg("import")
            .arg(&p12_path)
            .arg("-k")
            .arg(&keychain)
            .arg("-P")
            .arg(&passphrase)
            .args(["-T", "/usr/bin/codesign"])
            .output()?;
        if !import_output.status.success() {
            return Err(format!(
                "keychain import failed: {}",
                String::from_utf8_lossy(&import_output.stderr).trim()
            )
            .into());
        }

        let trust_output = Command::new("/usr/bin/security")
            .args([
                "add-trusted-cert",
                "-r",
                "trustRoot",
                "-p",
                "codeSign",
                "-k",
            ])
            .arg(&keychain)
            .arg(&cert_path)
            .output()?;
        if !trust_output.status.success() {
            // Roll back the imported identity if the user canceled or trust failed.
            let _ = Command::new("/usr/bin/security")
                .args(["delete-identity", "-Z", &sha1])
                .arg(&keychain)
                .output();
            let _ = Command::new("/usr/bin/security")
                .args(["delete-certificate", "-Z", &sha1])
                .arg(&keychain)
                .output();
            return Err(format!(
                "could not trust local code-signing certificate (authorization may have been canceled): {}",
                String::from_utf8_lossy(&trust_output.stderr).trim()
            )
            .into());
        }

        Ok(sha1)
    })();

    let _ = fs::remove_dir_all(&temp_dir);
    result
}

#[cfg(target_os = "macos")]
pub fn setup_macos_local_signing(
    data_dir: &Path,
    app_path: &Path,
) -> Result<MacOsLocalSigningStatus, Box<dyn Error>> {
    if !app_path.is_dir() || !app_path.join("Contents/MacOS/codexhost").is_file() {
        return Err(format!(
            "codexhost.app was not found at {}; install the macOS app bundle first",
            app_path.display()
        )
        .into());
    }

    let existing = read_macos_local_signing_config(data_dir)?;
    let (certificate_name, sha1) = match existing {
        Some(config) if identity_exists_in_keychain(&config.certificate_sha1, true) => {
            (config.certificate_name, config.certificate_sha1)
        }
        _ => {
            let name = DEFAULT_LOCAL_SIGNING_CERT_NAME.to_string();
            let sha1 = create_and_trust_local_certificate(&name)?;
            (name, sha1)
        }
    };

    sign_macos_app_bundle(app_path, &sha1)?;

    let config = MacOsLocalSigningConfig {
        version: SCHEMA_VERSION,
        enabled: true,
        certificate_name,
        certificate_sha1: sha1,
    };
    write_macos_local_signing_config(data_dir, &config)?;
    inspect_macos_local_signing(data_dir, Some(app_path))
}

#[cfg(not(target_os = "macos"))]
pub fn setup_macos_local_signing(
    _data_dir: &Path,
    _app_path: &Path,
) -> Result<MacOsLocalSigningStatus, Box<dyn Error>> {
    Err("macOS local signing is only supported on macOS".into())
}

#[cfg(target_os = "macos")]
pub fn remove_macos_local_signing(
    data_dir: &Path,
    app_path: Option<&Path>,
) -> Result<MacOsLocalSigningStatus, Box<dyn Error>> {
    let config = read_macos_local_signing_config(data_dir)?;
    let keychain = login_keychain_path()?;

    if let Some(config) = &config {
        let _ = Command::new("/usr/bin/security")
            .args(["delete-identity", "-Z", &config.certificate_sha1])
            .arg(&keychain)
            .output();
        let _ = Command::new("/usr/bin/security")
            .args(["delete-certificate", "-Z", &config.certificate_sha1])
            .arg(&keychain)
            .output();
    } else {
        let _ = Command::new("/usr/bin/security")
            .args(["delete-identity", "-c", DEFAULT_LOCAL_SIGNING_CERT_NAME])
            .arg(&keychain)
            .output();
    }

    remove_macos_local_signing_config(data_dir)?;

    if let Some(app) = app_path
        && app.is_dir()
        && app.join("Contents/MacOS/codexhost").is_file()
    {
        sign_macos_app_bundle(app, "-")?;
    }

    inspect_macos_local_signing(data_dir, app_path)
}

#[cfg(not(target_os = "macos"))]
pub fn remove_macos_local_signing(
    _data_dir: &Path,
    _app_path: Option<&Path>,
) -> Result<MacOsLocalSigningStatus, Box<dyn Error>> {
    Err("macOS local signing is only supported on macOS".into())
}

/// Re-signs a staged macOS app bundle during an in-app update when the user has
/// enabled local signing and the trusted certificate is available in their keychain.
/// Returns `Ok(true)` if re-signed, `Ok(false)` if local signing is disabled or the
/// certificate is unavailable (never fails an update for a deleted keychain cert).
#[cfg(target_os = "macos")]
pub fn resign_staged_macos_app_if_enabled(
    data_dir: &Path,
    staged_app_path: &Path,
) -> Result<bool, Box<dyn Error>> {
    let Some(config) = read_macos_local_signing_config(data_dir)? else {
        return Ok(false);
    };
    if !config.enabled {
        return Ok(false);
    }
    if !identity_exists_in_keychain(&config.certificate_sha1, true) {
        eprintln!(
            "codexhost updater: local signing certificate '{}' ({}) is not available in login keychain; keeping package signature",
            config.certificate_name, config.certificate_sha1
        );
        return Ok(false);
    }
    sign_macos_app_bundle(staged_app_path, &config.certificate_sha1)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use std::env;

    use super::*;

    #[test]
    fn parses_openssl_sha1_fingerprint_and_designated_leaf() {
        let openssl_out =
            "SHA1 Fingerprint=53:DC:A7:F8:18:73:FB:B4:33:FB:48:73:62:84:52:BC:22:C7:CE:73\n";
        assert_eq!(
            parse_openssl_sha1_fingerprint(openssl_out).as_deref(),
            Some("53DCA7F81873FBB433FB4873628452BC22C7CE73")
        );

        let codesign_out = "designated => identifier \"com.codexhost.app\" and certificate leaf = H\"53dca7f81873fbb433fb4873628452bc22c7ce73\"\n";
        assert_eq!(
            parse_designated_certificate_leaf_sha1(codesign_out).as_deref(),
            Some("53DCA7F81873FBB433FB4873628452BC22C7CE73")
        );
    }

    #[test]
    fn config_round_trip_and_removal() {
        let dir = env::temp_dir().join(format!(
            "codexhost-local-signing-cfg-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        assert_eq!(read_macos_local_signing_config(&dir).unwrap(), None);

        let config = MacOsLocalSigningConfig {
            version: SCHEMA_VERSION,
            enabled: true,
            certificate_name: DEFAULT_LOCAL_SIGNING_CERT_NAME.into(),
            certificate_sha1: "53DCA7F81873FBB433FB4873628452BC22C7CE73".into(),
        };
        write_macos_local_signing_config(&dir, &config).unwrap();
        assert_eq!(read_macos_local_signing_config(&dir).unwrap(), Some(config));
        remove_macos_local_signing_config(&dir).unwrap();
        assert_eq!(read_macos_local_signing_config(&dir).unwrap(), None);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn openssl_config_restricts_cert_to_code_signing_only() {
        let cnf = openssl_codesign_config("CodexHost Local Signer");
        assert!(cnf.contains("basicConstraints = critical,CA:FALSE"));
        assert!(cnf.contains("keyUsage = critical,digitalSignature"));
        assert!(cnf.contains("extendedKeyUsage = codeSigning"));
        assert!(!cnf.contains("serverAuth"));
    }

    #[test]
    fn app_signing_targets_places_nested_binaries_before_bundle_root() {
        let dir = env::temp_dir().join(format!("codexhost-signing-targets-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let app = dir.join("codexhost.app");
        let files = [
            "Contents/Resources/runtime/node",
            "Contents/Resources/libexec/codexhost-shim",
            "Contents/Resources/libexec/codexhost-updater",
            "Contents/Helpers/CodexHost.app/Contents/MacOS/CodexHost",
            "Contents/MacOS/codexhost",
        ];
        for rel in files {
            let full = app.join(rel);
            fs::create_dir_all(full.parent().unwrap()).unwrap();
            fs::write(full, b"fixture").unwrap();
        }
        let targets = macos_app_signing_targets(&app);
        assert_eq!(targets.last(), Some(&app));
        assert!(
            targets.iter().position(
                |p| p.ends_with("Contents/Helpers/CodexHost.app/Contents/MacOS/CodexHost")
            ) < targets
                .iter()
                .position(|p| p.ends_with("Contents/Helpers/CodexHost.app"))
        );
        assert!(
            targets
                .iter()
                .position(|p| p.ends_with("Contents/MacOS/codexhost"))
                < targets.iter().position(|p| p == &app)
        );
        fs::remove_dir_all(&dir).unwrap();
    }
}
