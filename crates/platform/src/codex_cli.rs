//! Native Codex CLI selection is independent of Desktop package discovery.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};

use crate::{PlatformError, canonical_existing_file, validate_proxy_target};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CodexCliSource {
    CommandLine,
    Environment,
    Packaged,
    DesktopManagedCache,
}

impl CodexCliSource {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::CommandLine => "command-line",
            Self::Environment => "environment",
            Self::Packaged => "packaged",
            Self::DesktopManagedCache => "desktop-managed-cache",
        }
    }
}

/// A validated override captured before Desktop's CODEX_CLI_PATH becomes the Shim.
#[derive(Debug, Clone)]
pub struct CodexCliOverride {
    pub(crate) executable: PathBuf,
    pub(crate) source: CodexCliSource,
}

/// Explicit options win over the inherited Desktop CLI selection. An invalid
/// selection is an error, never a reason to fall back to a packaged executable.
/// Empty environment values match Desktop's behavior and mean no override.
/// A managed caller already points CODEX_CLI_PATH at this installation's Shim;
/// recover its forwarded native target without treating the Shim as a new CLI.
pub fn resolve_codex_cli_override(
    explicit: Option<&Path>,
    inherited: Option<&OsStr>,
    forwarded_stock: Option<&OsStr>,
    shim: Option<&Path>,
) -> Result<Option<CodexCliOverride>, PlatformError> {
    let (path, source, label) = if let Some(path) = explicit {
        (path, CodexCliSource::CommandLine, "--codex-cli")
    } else if let Some(value) = inherited.filter(|value| !value.to_string_lossy().trim().is_empty())
    {
        let inherited_path = Path::new(value);
        let managed_caller = inherited_path.is_absolute()
            && shim.is_some_and(|shim| {
                inherited_path
                    .canonicalize()
                    .ok()
                    .zip(shim.canonicalize().ok())
                    .is_some_and(|(inherited, shim)| inherited == shim)
            });
        match forwarded_stock.filter(|_| managed_caller) {
            Some(stock) => (
                Path::new(stock),
                CodexCliSource::Environment,
                "CODEXHOST_STOCK_CODEX_PATH",
            ),
            None => (
                inherited_path,
                CodexCliSource::Environment,
                "CODEX_CLI_PATH",
            ),
        }
    } else {
        return Ok(None);
    };
    if !path.is_absolute() {
        return Err(PlatformError::Invalid(format!(
            "{label} must be an absolute executable path"
        )));
    }
    let executable = canonical_existing_file(path).map_err(|error| {
        PlatformError::Invalid(format!("{label} '{}': {error}", path.display()))
    })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if executable.metadata()?.permissions().mode() & 0o111 == 0 {
            return Err(PlatformError::Invalid(format!(
                "{label} '{}' is not executable",
                path.display()
            )));
        }
    }
    if let Some(shim) = shim {
        validate_proxy_target(shim, &executable)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            let shim_metadata = shim.metadata()?;
            let target_metadata = executable.metadata()?;
            if shim_metadata.dev() == target_metadata.dev()
                && shim_metadata.ino() == target_metadata.ino()
            {
                return Err(PlatformError::Invalid(
                    "native Codex CLI is a hard link to the Shim itself".into(),
                ));
            }
        }
    }
    Ok(Some(CodexCliOverride { executable, source }))
}

/// Default discovery is lazy: a valid override does not require a bundled CLI
/// or a Desktop-managed cache to be runnable or present.
pub(crate) fn select_codex_cli(
    selected: Option<&CodexCliOverride>,
    default_source: CodexCliSource,
    default: impl FnOnce() -> Result<PathBuf, PlatformError>,
) -> Result<(PathBuf, CodexCliSource), PlatformError> {
    match selected {
        Some(selected) => Ok((selected.executable.clone(), selected.source)),
        None => Ok((default()?, default_source)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn executable(root: &Path, name: &str) -> PathBuf {
        let path = root.join(name);
        std::fs::write(&path, b"fixture").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        path.canonicalize().unwrap()
    }

    #[test]
    fn explicit_choice_wins_and_default_discovery_is_lazy() {
        let root = crate::temporary_directory("cli-selection");
        let cli = executable(&root, "codex");
        let shim = executable(&root, "shim");
        let choice =
            resolve_codex_cli_override(Some(&cli), Some(OsStr::new("invalid")), None, Some(&shim))
                .unwrap()
                .unwrap();
        let (path, source) = select_codex_cli(Some(&choice), CodexCliSource::Packaged, || {
            panic!("an explicit CLI must not consult the default")
        })
        .unwrap();
        assert_eq!(path, cli);
        assert_eq!(source, CodexCliSource::CommandLine);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn inherited_choice_is_canonicalized_and_empty_values_use_default() {
        let root = crate::temporary_directory("cli-environment");
        let cli = executable(&root, "codex with spaces");
        let choice = resolve_codex_cli_override(None, Some(cli.as_os_str()), None, None)
            .unwrap()
            .unwrap();
        assert_eq!(choice.executable, cli);
        assert_eq!(choice.source, CodexCliSource::Environment);
        #[cfg(unix)]
        {
            let alias = root.join("current-codex");
            std::os::unix::fs::symlink(&cli, &alias).unwrap();
            let choice = resolve_codex_cli_override(None, Some(alias.as_os_str()), None, None)
                .unwrap()
                .unwrap();
            assert_eq!(choice.executable, cli);
        }
        for value in [None, Some(OsStr::new("")), Some(OsStr::new("  "))] {
            assert!(
                resolve_codex_cli_override(None, value, None, None)
                    .unwrap()
                    .is_none()
            );
        }
        let (path, source) =
            select_codex_cli(
                None,
                CodexCliSource::DesktopManagedCache,
                || Ok(cli.clone()),
            )
            .unwrap();
        assert_eq!(path, cli);
        assert_eq!(source, CodexCliSource::DesktopManagedCache);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn invalid_explicit_choices_fail_without_fallback() {
        let root = crate::temporary_directory("cli-invalid");
        let cli = executable(&root, "codex");
        for path in [
            PathBuf::from("relative"),
            root.join("missing"),
            root.clone(),
        ] {
            assert!(
                resolve_codex_cli_override(Some(&path), Some(cli.as_os_str()), None, None).is_err()
            );
        }
        assert!(
            resolve_codex_cli_override(None, Some(OsStr::new("relative")), None, None).is_err()
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o644)).unwrap();
            assert!(resolve_codex_cli_override(Some(&cli), None, None, None).is_err());
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_shim_itself_and_aliases() {
        let root = crate::temporary_directory("cli-recursion");
        let shim = executable(&root, "shim");
        assert!(resolve_codex_cli_override(Some(&shim), None, None, Some(&shim)).is_err());
        #[cfg(unix)]
        {
            let alias = root.join("alias");
            std::os::unix::fs::symlink(&shim, &alias).unwrap();
            assert!(
                resolve_codex_cli_override(None, Some(alias.as_os_str()), None, Some(&shim))
                    .is_err()
            );
            let hard_link = root.join("hard-link");
            std::fs::hard_link(&shim, &hard_link).unwrap();
            assert!(resolve_codex_cli_override(Some(&hard_link), None, None, Some(&shim)).is_err());
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn managed_reentry_preserves_native_target_without_accepting_explicit_recursion() {
        let root = crate::temporary_directory("cli-managed-reentry");
        let shim = executable(&root, "shim");
        let cli = executable(&root, "codex");
        let selected = resolve_codex_cli_override(
            None,
            Some(shim.as_os_str()),
            Some(cli.as_os_str()),
            Some(&shim),
        )
        .unwrap()
        .unwrap();
        assert_eq!(selected.executable, cli);
        assert_eq!(selected.source, CodexCliSource::Environment);
        assert!(
            resolve_codex_cli_override(
                Some(&shim),
                Some(shim.as_os_str()),
                Some(cli.as_os_str()),
                Some(&shim)
            )
            .is_err()
        );
        assert!(
            resolve_codex_cli_override(
                None,
                Some(shim.as_os_str()),
                Some(shim.as_os_str()),
                Some(&shim)
            )
            .is_err()
        );
        assert!(
            resolve_codex_cli_override(
                None,
                Some(shim.as_os_str()),
                Some(OsStr::new("missing")),
                Some(&shim)
            )
            .is_err()
        );
        let unrelated_stock = root.join("absent");
        let selected = resolve_codex_cli_override(
            None,
            Some(cli.as_os_str()),
            Some(unrelated_stock.as_os_str()),
            Some(&shim),
        )
        .unwrap()
        .unwrap();
        assert_eq!(selected.executable, cli);
        assert!(
            resolve_codex_cli_override(None, None, Some(cli.as_os_str()), Some(&shim))
                .unwrap()
                .is_none()
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
