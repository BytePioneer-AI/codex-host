use std::env;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};

const HOST_NODE_PATH_ENV: &str = "CODEXHOST_HOST_NODE_PATH";
const HOST_RUNTIME_PATH_ENV: &str = "CODEXHOST_HOST_RUNTIME_PATH";
const DESKTOP_SHELL_PATH_ENV: &str = "CODEXHOST_DESKTOP_SHELL_PATH";

#[derive(Debug, PartialEq, Eq)]
pub struct InstalledResources {
    pub shim: PathBuf,
    pub node: PathBuf,
    pub host_runtime: PathBuf,
    pub web_runtime: PathBuf,
    pub desktop_controller: PathBuf,
    pub renderer_extension: PathBuf,
    pub console_server: PathBuf,
    pub desktop_shell: Option<PathBuf>,
}

impl InstalledResources {
    pub fn from_current_executable() -> Result<Self, String> {
        let executable = env::current_exe()
            .map_err(|error| format!("cannot locate the codexhost executable: {error}"))?;
        Self::from_executable(&executable)
    }

    pub fn from_executable(executable: &Path) -> Result<Self, String> {
        Self::from_executable_with_shell_override(
            executable,
            env::var_os(DESKTOP_SHELL_PATH_ENV).map(PathBuf::from),
        )
    }

    fn from_executable_with_shell_override(
        executable: &Path,
        shell_override: Option<PathBuf>,
    ) -> Result<Self, String> {
        if !executable.is_absolute() {
            return Err(format!(
                "codexhost executable path must be absolute: {}",
                executable.display()
            ));
        }

        let node_override = env::var_os(HOST_NODE_PATH_ENV);
        let host_runtime_override = env::var_os(HOST_RUNTIME_PATH_ENV);
        let mut resources = match Self::from_source_checkout(
            executable,
            node_override.as_deref(),
            host_runtime_override.as_deref(),
        ) {
            Some(resources) => resources,
            None => Self::from_installed_layout(executable)?,
        };
        if let Some(path) = shell_override.filter(|path| path.is_absolute() && path.is_file()) {
            resources.desktop_shell = Some(path);
        }
        Ok(resources)
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
        let macos_bundle = executable_directory.file_name() == Some(OsStr::new("MacOS"))
            && installation_root.file_name() == Some(OsStr::new("Contents"));
        let (resource_root, bin) = if macos_bundle {
            (
                installation_root.join("Resources"),
                executable_directory.to_path_buf(),
            )
        } else {
            (
                installation_root.to_path_buf(),
                installation_root.join("bin"),
            )
        };
        let executable_suffix = env::consts::EXE_SUFFIX;
        let shell_name = format!("codexhost-shell{executable_suffix}");
        let desktop_shell = [
            macos_bundle
                .then(|| installation_root.join("Helpers/CodexHost.app/Contents/MacOS/CodexHost")),
            Some(resource_root.join("libexec/CodexHost.app/Contents/MacOS/CodexHost")),
            Some(resource_root.join("libexec").join(&shell_name)),
            Some(bin.join(shell_name)),
        ]
        .into_iter()
        .flatten()
        .find(|path| path.is_file());

        Ok(Self {
            shim: resource_root
                .join("libexec")
                .join(format!("codexhost-shim{executable_suffix}")),
            node: resource_root
                .join("runtime")
                .join(format!("node{executable_suffix}")),
            host_runtime: resource_root.join("app/host-runtime.mjs"),
            web_runtime: resource_root.join("app/web-server.mjs"),
            desktop_controller: resource_root.join("app/desktop-controller.mjs"),
            renderer_extension: resource_root.join("app/renderer-extension.js"),
            console_server: resource_root.join("app/console-server.mjs"),
            desktop_shell,
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

        let shell_name = format!("codexhost-shell{executable_suffix}");
        let profile = build_directory.file_name()?;
        let desktop_shell = [
            build_directory.join(&shell_name),
            repository_root
                .join("apps/desktop-shell/src-tauri/target")
                .join(profile)
                .join(&shell_name),
        ]
        .into_iter()
        .find(|path| path.is_file());
        let packed_web_runtime =
            repository_root.join("packages/web-server/dist/codexhost-web/app/server.mjs");
        let web_runtime = if packed_web_runtime.is_file() {
            packed_web_runtime
        } else {
            repository_root.join("packages/web-server/dist/main.js")
        };
        Some(Self {
            shim: build_directory.join(format!("codexhost-shim{executable_suffix}")),
            node,
            host_runtime,
            web_runtime,
            desktop_controller: repository_root
                .join("packages/desktop-control/dist/release-main.js"),
            renderer_extension: repository_root
                .join("packages/renderer-extension/dist/production.js"),
            console_server: repository_root.join("packages/console-server/dist/main.js"),
            desktop_shell,
        })
    }
}

pub fn is_source_checkout_build(executable: &Path) -> bool {
    source_checkout_layout(executable).is_some()
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
            InstalledResources::from_installed_layout(&executable).expect("release layout"),
            InstalledResources {
                shim: root
                    .join("libexec")
                    .join(format!("codexhost-shim{}", env::consts::EXE_SUFFIX)),
                node: root
                    .join("runtime")
                    .join(format!("node{}", env::consts::EXE_SUFFIX)),
                host_runtime: root.join("app/host-runtime.mjs"),
                web_runtime: root.join("app/web-server.mjs"),
                desktop_controller: root.join("app/desktop-controller.mjs"),
                renderer_extension: root.join("app/renderer-extension.js"),
                console_server: root.join("app/console-server.mjs"),
                desktop_shell: None,
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
                web_runtime: root.join("packages/web-server/dist/main.js"),
                desktop_controller: root.join("packages/desktop-control/dist/release-main.js"),
                renderer_extension: root.join("packages/renderer-extension/dist/production.js"),
                console_server: root.join("packages/console-server/dist/main.js"),
                desktop_shell: None,
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
    fn finds_shell_in_installed_and_source_layouts_and_prefers_a_valid_override() {
        use std::fs;

        let root = env::temp_dir().join(format!("codexhost-shell-layout-{}", std::process::id()));
        let shell = format!("codexhost-shell{}", env::consts::EXE_SUFFIX);
        for (launcher_dir, shell_rel) in [
            ("install/bin", format!("install/bin/{shell}")),
            ("install/bin", format!("install/libexec/{shell}")),
            (
                "install/bin",
                "install/libexec/CodexHost.app/Contents/MacOS/CodexHost".to_string(),
            ),
            (
                "codexhost.app/Contents/MacOS",
                format!("codexhost.app/Contents/MacOS/{shell}"),
            ),
            (
                "codexhost.app/Contents/MacOS",
                format!("codexhost.app/Contents/Resources/libexec/{shell}"),
            ),
            (
                "codexhost.app/Contents/MacOS",
                "codexhost.app/Contents/Helpers/CodexHost.app/Contents/MacOS/CodexHost".to_string(),
            ),
            ("target/debug", format!("target/debug/{shell}")),
            ("target/release", format!("target/release/{shell}")),
        ] {
            let launcher = root.join(launcher_dir).join("codexhost");
            let candidate = root.join(&shell_rel);
            fs::create_dir_all(candidate.parent().unwrap()).unwrap();
            fs::write(&candidate, "fixture").unwrap();
            let locate = |override_path| {
                InstalledResources::from_executable_with_shell_override(&launcher, override_path)
                    .unwrap()
                    .desktop_shell
            };
            assert_eq!(locate(None), Some(candidate.clone()));
            for invalid in [PathBuf::from(&shell), root.clone(), root.join("missing")] {
                assert_eq!(locate(Some(invalid)), Some(candidate.clone()));
            }
            let custom = root.join("custom-shell");
            fs::write(&custom, "fixture").unwrap();
            assert_eq!(locate(Some(custom.clone())), Some(custom));
            fs::remove_file(candidate).unwrap();
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn finds_shell_in_the_tauri_workspace_after_checking_the_launcher_build_directory() {
        use std::fs;

        let root = env::temp_dir().join(format!("codexhost-shell-tauri-{}", std::process::id()));
        let shell = format!("codexhost-shell{}", env::consts::EXE_SUFFIX);
        for profile in ["debug", "release"] {
            let build = root.join("target").join(profile);
            let launcher = build.join("codexhost");
            let sibling = build.join(&shell);
            let tauri_shell = root
                .join("apps/desktop-shell/src-tauri/target")
                .join(profile)
                .join(&shell);
            fs::create_dir_all(tauri_shell.parent().unwrap()).unwrap();
            fs::write(&tauri_shell, "fixture").unwrap();
            let locate = || {
                InstalledResources::from_source_checkout(&launcher, None, None)
                    .unwrap()
                    .desktop_shell
            };
            assert_eq!(locate(), Some(tauri_shell));
            fs::create_dir_all(build).unwrap();
            fs::write(&sibling, "fixture").unwrap();
            assert_eq!(locate(), Some(sibling));
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn source_checkout_prefers_packed_web_runtime_when_present() {
        use std::fs;

        let root = env::temp_dir().join(format!(
            "codexhost-packed-web-layout-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        let executable = root
            .join("target/debug")
            .join(format!("codexhost{}", env::consts::EXE_SUFFIX));
        let fallback = root.join("packages/web-server/dist/main.js");
        let packed = root.join("packages/web-server/dist/codexhost-web/app/server.mjs");

        assert_eq!(
            InstalledResources::from_source_checkout(&executable, None, None)
                .unwrap()
                .web_runtime,
            fallback
        );

        fs::create_dir_all(packed.parent().unwrap()).unwrap();
        fs::write(&packed, "fixture").unwrap();
        assert_eq!(
            InstalledResources::from_source_checkout(&executable, None, None)
                .unwrap()
                .web_runtime,
            packed
        );

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_a_relative_executable_path() {
        let error = InstalledResources::from_executable(Path::new("bin/codexhost"))
            .expect_err("relative executable must fail");
        assert!(error.contains("must be absolute"));
    }
}
