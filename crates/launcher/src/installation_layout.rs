use std::env;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};

const HOST_NODE_PATH_ENV: &str = "CODEXHOST_HOST_NODE_PATH";
const HOST_RUNTIME_PATH_ENV: &str = "CODEXHOST_HOST_RUNTIME_PATH";

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

    pub fn from_executable(executable: &Path) -> Result<Self, String> {
        if !executable.is_absolute() {
            return Err(format!(
                "codexhost executable path must be absolute: {}",
                executable.display()
            ));
        }

        let node_override = env::var_os(HOST_NODE_PATH_ENV);
        let host_runtime_override = env::var_os(HOST_RUNTIME_PATH_ENV);
        if let Some(resources) = Self::from_source_checkout(
            executable,
            node_override.as_deref(),
            host_runtime_override.as_deref(),
        ) {
            return Ok(resources);
        }

        Self::from_installed_layout(executable)
    }

    fn from_installed_layout(executable: &Path) -> Result<Self, String> {
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

    fn from_source_checkout(
        executable: &Path,
        node_override: Option<&OsStr>,
        host_runtime_override: Option<&OsStr>,
    ) -> Option<Self> {
        let (repository_root, build_directory) = source_checkout_layout(executable)?;
        let executable_suffix = env::consts::EXE_SUFFIX;
        let node = node_override
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(format!("node{executable_suffix}")));
        let host_runtime = host_runtime_override
            .map(PathBuf::from)
            .unwrap_or_else(|| repository_root.join("packages/host-runtime/dist/main.js"));

        Some(Self {
            shim: build_directory.join(format!("codexhost-shim{executable_suffix}")),
            node,
            host_runtime,
            desktop_controller: repository_root
                .join("packages/desktop-control/dist/release-main.js"),
            renderer_extension: repository_root
                .join("packages/renderer-extension/dist/production.js"),
        })
    }
}

fn source_checkout_layout(executable: &Path) -> Option<(PathBuf, PathBuf)> {
    let build_directory = executable.parent()?;
    let profile = build_directory.file_name()?;
    if profile != OsStr::new("debug") && profile != OsStr::new("release") {
        return None;
    }
    let target_directory = build_directory.parent()?;
    if target_directory.file_name() != Some(OsStr::new("target")) {
        return None;
    }
    let repository_root = target_directory.parent()?;
    Some((repository_root.to_path_buf(), build_directory.to_path_buf()))
}

#[cfg(test)]
mod tests {
    use std::env;
    use std::path::{Path, PathBuf};

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
    fn resolves_resources_from_a_source_checkout() {
        let root = env::temp_dir().join("codexhost source checkout");
        let executable = root
            .join("target/debug")
            .join(format!("codexhost{}", env::consts::EXE_SUFFIX));

        assert_eq!(
            InstalledResources::from_source_checkout(&executable, None, None)
                .expect("source checkout"),
            InstalledResources {
                shim: root
                    .join("target/debug")
                    .join(format!("codexhost-shim{}", env::consts::EXE_SUFFIX)),
                node: PathBuf::from(format!("node{}", env::consts::EXE_SUFFIX)),
                host_runtime: root.join("packages/host-runtime/dist/main.js"),
                desktop_controller: root.join("packages/desktop-control/dist/release-main.js"),
                renderer_extension: root.join("packages/renderer-extension/dist/production.js"),
            }
        );
    }

    #[test]
    fn source_checkout_prefers_runtime_overrides() {
        let root = env::temp_dir().join("codexhost source overrides");
        let executable = root
            .join("target/release")
            .join(format!("codexhost{}", env::consts::EXE_SUFFIX));
        let node = root.join("custom/node");
        let host_runtime = root.join("custom/host-runtime.mjs");

        let resources = InstalledResources::from_source_checkout(
            &executable,
            Some(node.as_os_str()),
            Some(host_runtime.as_os_str()),
        )
        .expect("source checkout");

        assert_eq!(resources.node, node);
        assert_eq!(resources.host_runtime, host_runtime);
    }

    #[test]
    fn rejects_a_relative_executable_path() {
        let error = InstalledResources::from_executable(Path::new("bin/codexhost"))
            .expect_err("relative executable must fail");
        assert!(error.contains("must be absolute"));
    }
}
