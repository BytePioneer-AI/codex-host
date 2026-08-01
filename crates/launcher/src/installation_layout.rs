use std::env;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};

#[derive(Debug, PartialEq, Eq)]
pub struct InstalledResources {
    pub shim: PathBuf,
    pub node: PathBuf,
    pub host_runtime: PathBuf,
    pub desktop_controller: PathBuf,
    pub renderer_extension: PathBuf,
}

impl InstalledResources {
    pub fn from_current_executable() -> Result<Self, String> {
        let executable = env::current_exe()
            .map_err(|error| format!("cannot locate the codexhost executable: {error}"))?;
        Self::from_executable(&executable)
    }

    fn from_executable(executable: &Path) -> Result<Self, String> {
        if !executable.is_absolute() {
            return Err(format!(
                "codexhost executable path must be absolute: {}",
                executable.display()
            ));
        }
        let executable_directory = executable.parent().ok_or_else(|| {
            format!(
                "codexhost executable has no installation directory: {}",
                executable.display()
            )
        })?;
        let installation_root = executable_directory.parent().ok_or_else(|| {
            format!(
                "codexhost executable must be installed below an installation root: {}",
                executable.display()
            )
        })?;
        let resource_root = if executable_directory.file_name() == Some(OsStr::new("MacOS"))
            && installation_root.file_name() == Some(OsStr::new("Contents"))
        {
            installation_root.join("Resources")
        } else {
            installation_root.to_path_buf()
        };
        let executable_suffix = env::consts::EXE_SUFFIX;

        Ok(Self {
            shim: resource_root
                .join("libexec")
                .join(format!("codexhost-shim{executable_suffix}")),
            node: resource_root
                .join("runtime")
                .join(format!("node{executable_suffix}")),
            host_runtime: resource_root.join("app/host-runtime.mjs"),
            desktop_controller: resource_root.join("app/desktop-controller.mjs"),
            renderer_extension: resource_root.join("app/renderer-extension.js"),
        })
    }
}

#[cfg(test)]
mod tests {
    use std::env;
    use std::path::Path;

    use super::InstalledResources;

    #[test]
    fn resolves_resources_from_a_release_bin_directory() {
        let root = env::temp_dir().join("codexhost release");
        let executable = root
            .join("bin")
            .join(format!("codexhost{}", env::consts::EXE_SUFFIX));

        assert_eq!(
            InstalledResources::from_executable(&executable).expect("release layout"),
            InstalledResources {
                shim: root
                    .join("libexec")
                    .join(format!("codexhost-shim{}", env::consts::EXE_SUFFIX)),
                node: root
                    .join("runtime")
                    .join(format!("node{}", env::consts::EXE_SUFFIX)),
                host_runtime: root.join("app/host-runtime.mjs"),
                desktop_controller: root.join("app/desktop-controller.mjs"),
                renderer_extension: root.join("app/renderer-extension.js"),
            }
        );
    }

    #[test]
    fn resolves_resources_from_a_macos_bundle_contents_directory() {
        let contents = env::temp_dir().join("codexhost.app/Contents");
        let executable = contents
            .join("MacOS")
            .join(format!("codexhost{}", env::consts::EXE_SUFFIX));

        assert_eq!(
            InstalledResources::from_executable(&executable)
                .expect("macOS application layout")
                .host_runtime,
            contents.join("Resources/app/host-runtime.mjs")
        );
    }

    #[test]
    fn rejects_a_relative_executable_path() {
        let error = InstalledResources::from_executable(Path::new("bin/codexhost"))
            .expect_err("relative executable must fail");
        assert!(error.contains("must be absolute"));
    }
}
