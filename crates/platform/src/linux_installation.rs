use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::Deserialize;

use super::installation::{canonical_unix_executable, sha256_file};
use crate::{DesktopIdentity, DesktopInstallation, PlatformError};

const LINUX_INSTALL_ROOT: &str = "/usr/lib/chatgpt";
const LINUX_DESKTOP_LAUNCHER: &str = "/usr/bin/chatgpt";
const LINUX_PACKAGE_NAME: &str = "chatgpt";
const ELF_MAGIC: [u8; 4] = [0x7f, b'E', b'L', b'F'];
const ELF_CLASS_64: u8 = 2;
const ELF_MACHINE_X86_64: u16 = 62;
const ELF_MACHINE_AARCH64: u16 = 183;

fn expected_elf_machine() -> Option<(u16, &'static str)> {
    if cfg!(target_arch = "x86_64") {
        Some((ELF_MACHINE_X86_64, "x86-64"))
    } else if cfg!(target_arch = "aarch64") {
        Some((ELF_MACHINE_AARCH64, "ARM64"))
    } else {
        None
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LinuxPackageMetadata {
    #[serde(rename = "codexAppBrand")]
    brand: String,
    #[serde(rename = "codexBuildFlavor")]
    flavor: String,
    version: String,
}

fn canonical_linux_elf(path: &Path, label: &str) -> Result<PathBuf, PlatformError> {
    let (expected_machine, architecture) =
        expected_elf_machine().ok_or(PlatformError::Unsupported(
            "official ChatGPT Linux packages are unsupported on this architecture",
        ))?;
    let canonical = canonical_unix_executable(path, label)?;
    let mut header = [0_u8; 20];
    File::open(&canonical)?
        .read_exact(&mut header)
        .map_err(|error| {
            PlatformError::Invalid(format!(
                "{label} '{}' has no complete ELF header: {error}",
                path.display()
            ))
        })?;
    let machine = u16::from_le_bytes([header[18], header[19]]);
    if header[..4] != ELF_MAGIC
        || header[4] != ELF_CLASS_64
        || header[5] != 1
        || machine != expected_machine
    {
        return Err(PlatformError::Invalid(format!(
            "{label} '{}' is not a little-endian {architecture} ELF executable",
            path.display()
        )));
    }
    Ok(canonical)
}

fn linux_installation(
    root: &Path,
    launcher_path: &Path,
) -> Result<DesktopInstallation, PlatformError> {
    let install_root = root.canonicalize().map_err(|error| {
        PlatformError::NotFound(format!(
            "official ChatGPT Linux package '{}' is unavailable: {error}",
            root.display()
        ))
    })?;
    let metadata_path = install_root.join("resources/linux-package-metadata.json");
    let metadata_file_type = metadata_path.symlink_metadata().map_err(|error| {
        PlatformError::NotFound(format!(
            "ChatGPT Linux package metadata '{}' is unavailable: {error}",
            metadata_path.display()
        ))
    })?;
    if !metadata_file_type.is_file() || metadata_file_type.file_type().is_symlink() {
        return Err(PlatformError::Invalid(format!(
            "ChatGPT Linux package metadata '{}' is not a regular package file",
            metadata_path.display()
        )));
    }
    let metadata_file = File::open(&metadata_path).map_err(|error| {
        PlatformError::NotFound(format!(
            "ChatGPT Linux package metadata '{}' is unavailable: {error}",
            metadata_path.display()
        ))
    })?;
    let mut metadata_bytes = Vec::new();
    metadata_file.take(4097).read_to_end(&mut metadata_bytes)?;
    if metadata_bytes.len() > 4096 {
        return Err(PlatformError::Invalid(
            "ChatGPT Linux package metadata exceeds 4096 bytes".into(),
        ));
    }
    let metadata: LinuxPackageMetadata =
        serde_json::from_slice(&metadata_bytes).map_err(|error| {
            PlatformError::Invalid(format!(
                "ChatGPT Linux package metadata '{}' is invalid: {error}",
                metadata_path.display()
            ))
        })?;
    if metadata.brand != "chatgpt" || metadata.flavor != "prod" || metadata.version.is_empty() {
        return Err(PlatformError::Invalid(format!(
            "ChatGPT Linux package '{}' has unsupported identity brand='{}' flavor='{}'",
            install_root.display(),
            metadata.brand,
            metadata.flavor
        )));
    }

    let desktop_executable =
        canonical_linux_elf(&install_root.join("ChatGPT"), "Desktop executable")?;
    let packaged_launcher =
        canonical_unix_executable(&install_root.join("codex-launcher"), "Desktop launcher")?;
    let packaged_codex_cli =
        canonical_linux_elf(&install_root.join("resources/codex"), "Codex CLI")?;
    if !desktop_executable.starts_with(&install_root)
        || !packaged_launcher.starts_with(&install_root)
        || !packaged_codex_cli.starts_with(&install_root)
    {
        return Err(PlatformError::Invalid(format!(
            "ChatGPT Linux package '{}' resolves an executable outside the package",
            install_root.display()
        )));
    }
    let launcher_metadata = launcher_path.symlink_metadata().map_err(|error| {
        PlatformError::NotFound(format!(
            "official ChatGPT launcher '{}' is unavailable: {error}",
            launcher_path.display()
        ))
    })?;
    if !launcher_metadata.file_type().is_symlink()
        || launcher_path.canonicalize().map_err(PlatformError::Io)? != packaged_launcher
    {
        return Err(PlatformError::Invalid(format!(
            "official ChatGPT launcher '{}' does not resolve to '{}'",
            launcher_path.display(),
            packaged_launcher.display()
        )));
    }
    let desktop_launcher = launcher_path.to_path_buf();
    let asar_path = install_root.join("resources/app.asar");
    let asar_metadata = asar_path.symlink_metadata().map_err(|error| {
        PlatformError::NotFound(format!(
            "ChatGPT app.asar '{}' is unavailable: {error}",
            asar_path.display()
        ))
    })?;
    if !asar_metadata.is_file() || asar_metadata.file_type().is_symlink() {
        return Err(PlatformError::Invalid(format!(
            "ChatGPT app.asar '{}' is not a regular package file",
            asar_path.display()
        )));
    }

    Ok(DesktopInstallation {
        identity: DesktopIdentity::LinuxPackage {
            package_name: LINUX_PACKAGE_NAME.into(),
            brand: metadata.brand,
            flavor: metadata.flavor,
        },
        version: metadata.version.clone(),
        build: metadata.version,
        asar_integrity: sha256_file(&asar_path)?,
        install_root,
        desktop_launcher,
        desktop_executable,
        packaged_codex_cli: packaged_codex_cli.clone(),
        executable_codex_cli: packaged_codex_cli,
    })
}

pub fn discover_codex_desktop() -> Result<DesktopInstallation, PlatformError> {
    linux_installation(
        Path::new(LINUX_INSTALL_ROOT),
        Path::new(LINUX_DESKTOP_LAUNCHER),
    )
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::os::unix::fs::{PermissionsExt, symlink};

    use super::linux_installation;
    use crate::{DesktopIdentity, PlatformError, temporary_directory};

    fn elf(machine: u16) -> Vec<u8> {
        let mut header = vec![0_u8; 20];
        header[..4].copy_from_slice(&[0x7f, b'E', b'L', b'F']);
        header[4] = 2;
        header[5] = 1;
        header[18..20].copy_from_slice(&machine.to_le_bytes());
        header
    }

    fn native_elf() -> Vec<u8> {
        elf(super::expected_elf_machine()
            .expect("supported test architecture")
            .0)
    }

    fn fixture(brand: &str, flavor: &str) -> std::path::PathBuf {
        let root = temporary_directory("codexhost-linux-installation");
        fs::create_dir_all(root.join("resources")).expect("create resources");
        fs::write(root.join("ChatGPT"), native_elf()).expect("write Desktop");
        fs::write(root.join("codex-launcher"), b"launcher").expect("write Desktop launcher");
        fs::write(root.join("resources/codex"), native_elf()).expect("write CLI");
        fs::write(root.join("resources/app.asar"), b"asar").expect("write app.asar");
        fs::write(
            root.join("resources/linux-package-metadata.json"),
            format!(
                r#"{{"codexAppBrand":"{brand}","codexBuildFlavor":"{flavor}","version":"26.803.81509"}}"#,
            ),
        )
        .expect("write metadata");
        for executable in [
            root.join("ChatGPT"),
            root.join("codex-launcher"),
            root.join("resources/codex"),
        ] {
            fs::set_permissions(executable, fs::Permissions::from_mode(0o755))
                .expect("make executable");
        }
        root
    }

    fn launcher(root: &std::path::Path) -> std::path::PathBuf {
        let path = root.parent().expect("fixture parent").join(format!(
            "{}-chatgpt",
            root.file_name().expect("fixture name").to_string_lossy()
        ));
        symlink(root.join("codex-launcher"), &path).expect("link official launcher");
        path
    }

    #[test]
    fn validates_the_official_deb_and_rpm_layout() {
        let root = fixture("chatgpt", "prod");
        let launcher = launcher(&root);
        let installation = linux_installation(&root, &launcher).expect("valid Linux package");
        assert_eq!(
            installation.identity,
            DesktopIdentity::LinuxPackage {
                package_name: "chatgpt".into(),
                brand: "chatgpt".into(),
                flavor: "prod".into(),
            }
        );
        assert_eq!(installation.version, "26.803.81509");
        assert!(installation.asar_integrity.starts_with("sha256:"));
        assert_eq!(installation.desktop_launcher, launcher);
        assert_eq!(installation.desktop_executable, root.join("ChatGPT"));
        assert_eq!(
            installation.packaged_codex_cli,
            installation.executable_codex_cli
        );
        fs::remove_dir_all(root).expect("remove fixture");
        fs::remove_file(launcher).expect("remove launcher");
    }

    #[test]
    fn rejects_symlinked_package_metadata() {
        let root = fixture("chatgpt", "prod");
        let official_launcher = launcher(&root);
        let external = root
            .parent()
            .expect("fixture parent")
            .join("external-metadata.json");
        fs::write(
            &external,
            r#"{"codexAppBrand":"chatgpt","codexBuildFlavor":"prod","version":"26.803.81509"}"#,
        )
        .expect("write external metadata");
        let metadata = root.join("resources/linux-package-metadata.json");
        fs::remove_file(&metadata).expect("remove package metadata");
        symlink(&external, &metadata).expect("link external metadata");

        assert!(matches!(
            linux_installation(&root, &official_launcher),
            Err(PlatformError::Invalid(_))
        ));

        fs::remove_dir_all(root).expect("remove fixture");
        fs::remove_file(official_launcher).expect("remove launcher");
        fs::remove_file(external).expect("remove external metadata");
    }

    #[test]
    fn rejects_nonproduction_identity_wrong_architecture_and_executable_escape() {
        let wrong = fixture("codex", "dev");
        let wrong_launcher = launcher(&wrong);
        assert!(matches!(
            linux_installation(&wrong, &wrong_launcher),
            Err(PlatformError::Invalid(_))
        ));
        fs::remove_dir_all(wrong).expect("remove wrong fixture");
        fs::remove_file(wrong_launcher).expect("remove wrong launcher");

        let wrong_architecture = fixture("chatgpt", "prod");
        let wrong_architecture_launcher = launcher(&wrong_architecture);
        let wrong_machine = if cfg!(target_arch = "aarch64") {
            62
        } else {
            183
        };
        fs::write(wrong_architecture.join("ChatGPT"), elf(wrong_machine))
            .expect("write wrong-architecture Desktop");
        assert!(matches!(
            linux_installation(&wrong_architecture, &wrong_architecture_launcher),
            Err(PlatformError::Invalid(_))
        ));
        fs::remove_dir_all(wrong_architecture).expect("remove wrong architecture fixture");
        fs::remove_file(wrong_architecture_launcher).expect("remove wrong architecture launcher");

        let wrong_cli_architecture = fixture("chatgpt", "prod");
        let wrong_cli_architecture_launcher = launcher(&wrong_cli_architecture);
        fs::write(
            wrong_cli_architecture.join("resources/codex"),
            elf(wrong_machine),
        )
        .expect("write wrong-architecture CLI");
        assert!(matches!(
            linux_installation(&wrong_cli_architecture, &wrong_cli_architecture_launcher),
            Err(PlatformError::Invalid(_))
        ));
        fs::remove_dir_all(wrong_cli_architecture).expect("remove wrong CLI architecture fixture");
        fs::remove_file(wrong_cli_architecture_launcher)
            .expect("remove wrong CLI architecture launcher");

        let escaped = fixture("chatgpt", "prod");
        let escaped_launcher = launcher(&escaped);
        let external = escaped.parent().expect("parent").join("external-codex");
        fs::write(&external, native_elf()).expect("write external CLI");
        fs::set_permissions(&external, fs::Permissions::from_mode(0o755))
            .expect("make external executable");
        fs::remove_file(escaped.join("resources/codex")).expect("remove CLI");
        symlink(&external, escaped.join("resources/codex")).expect("link external CLI");
        assert!(matches!(
            linux_installation(&escaped, &escaped_launcher),
            Err(PlatformError::Invalid(_))
        ));
        fs::remove_dir_all(escaped).expect("remove escaped fixture");
        fs::remove_file(escaped_launcher).expect("remove escaped launcher");
        fs::remove_file(external).expect("remove external CLI");
    }
}
