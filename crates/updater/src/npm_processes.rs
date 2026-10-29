use crate::request::NpmInstallation;
use crate::windows_installation::same_path;
use std::error::Error;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

fn entries(npm: &NpmInstallation) -> Result<Vec<PathBuf>, Box<dyn Error>> {
    let root = npm
        .package_root
        .as_ref()
        .ok_or("npm process scope has no platform root")?;
    let prefix = npm
        .prefix
        .as_ref()
        .ok_or("npm process scope has no prefix")?;
    [
        npm.npm_launcher_path.clone(),
        root.join("app/host-runtime.mjs"),
        root.join("app/desktop-controller.mjs"),
        root.join("app/console-server.mjs"),
    ]
    .into_iter()
    .map(|path| {
        crate::windows_installation::owned_file(prefix, &path)?;
        Ok(path.canonicalize()?)
    })
    .collect()
}

fn script_path(arguments: &[OsString]) -> Option<&Path> {
    let mut args = arguments.iter().skip(1);
    let script = loop {
        let argument = args.next()?;
        if argument == "--disable-warning=UNDICI-EHPA" {
            continue;
        }
        if argument == "--" {
            break args.next();
        }
        if argument.to_string_lossy().starts_with('-') {
            return None;
        }
        break Some(argument);
    };
    let path = Path::new(script?);
    path.is_absolute().then_some(path)
}

pub(crate) fn script_belongs(arguments: &[OsString], entries: &[PathBuf]) -> bool {
    let Some(path) = script_path(arguments) else {
        return false;
    };
    let Ok(path) = path.canonicalize() else {
        return false;
    };
    entries.iter().any(|entry| same_path(&path, entry))
}

#[cfg(target_os = "windows")]
fn observed_instance_belongs(
    observed: &codexhost_platform::ProcessArguments,
    current: &codexhost_platform::ProcessSnapshot,
    node: &Path,
    entries: &[PathBuf],
) -> bool {
    observed.id == current.id
        && observed.started_at_micros == current.started_at_micros
        && current
            .executable
            .canonicalize()
            .is_ok_and(|image| same_path(&image, node))
        && script_belongs(&observed.arguments, entries)
}

#[cfg(target_os = "windows")]
pub(crate) fn validate_wait_owner(
    npm: &NpmInstallation,
    owner: &codexhost_platform::ProcessSnapshot,
) -> Result<(), Box<dyn Error>> {
    let node = npm.node_path.canonicalize()?;
    let entries = entries(npm)?;
    let observed = codexhost_platform::process_arguments_for_executable(&node)?;
    if !same_path(&owner.executable.canonicalize()?, &node) {
        return Ok(());
    }
    if !observed
        .iter()
        .any(|observed| observed_instance_belongs(observed, owner, &node, &entries))
    {
        return Err("cannot verify the shared Node update owner's installation entrypoint".into());
    }
    Ok(())
}

/// Called only after handoff and the original owner has exited. Shared Node's
/// image is only a prefilter: script ownership and kernel birth identity must match.
#[cfg(target_os = "windows")]
fn shutdown_shared_nodes(npm: &NpmInstallation) -> Result<(), Box<dyn Error>> {
    use codexhost_platform::{
        process_arguments_for_executable, process_snapshot, terminate_process_instance,
    };
    use std::thread;
    use std::time::{Duration, Instant};
    let node = npm.node_path.canonicalize()?;
    let entries = entries(npm)?;
    for _ in 0..3 {
        let mut targets = Vec::new();
        for observed in process_arguments_for_executable(&node)? {
            let current = match process_snapshot(observed.id) {
                Ok(current) => current,
                Err(_) if !codexhost_platform::process_exists(observed.id) => continue,
                Err(error) => return Err(error.into()),
            };
            if observed_instance_belongs(&observed, &current, &node, &entries) {
                targets.push(current);
            }
        }
        if targets.is_empty() {
            return Ok(());
        }
        for target in &targets {
            terminate_process_instance(target, true)?;
        }
        let started = Instant::now();
        loop {
            let mut pending = false;
            for target in &targets {
                match process_snapshot(target.id) {
                    Ok(current)
                        if current.started_at_micros == target.started_at_micros
                            && same_path(&current.executable, &target.executable) =>
                    {
                        pending = true
                    }
                    Ok(_) => {}
                    Err(_) if !codexhost_platform::process_exists(target.id) => {}
                    Err(error) => return Err(error.into()),
                }
            }
            if !pending {
                break;
            }
            if started.elapsed() >= Duration::from_secs(3) {
                return Err("owned npm runtime did not exit before timeout".into());
            }
            thread::sleep(Duration::from_millis(20));
        }
    }
    Err("npm installation keeps restarting owned runtime processes".into())
}

// Recovery observes both npm layouts without requiring partially replaced files
// to exist. Existing ancestors must still be ordinary directories in this prefix.
fn recovery_entries(npm: &NpmInstallation, arch: &str) -> Result<Vec<PathBuf>, Box<dyn Error>> {
    let prefix = npm.prefix.as_ref().ok_or("missing original prefix")?;
    if !prefix.is_absolute() || !same_path(prefix, &prefix.canonicalize()?) {
        return Err("npm recovery prefix identity changed".into());
    }
    if !matches!(arch, "x64" | "arm64") {
        return Err("unsupported npm recovery architecture".into());
    }
    let cli = Path::new("node_modules/@codexhost/cli");
    let platform = format!("@codexhost/cli-win32-{arch}");
    let mut paths = vec![cli.join("bin/codexhost.js")];
    for root in [
        Path::new("node_modules").join(&platform),
        cli.join("node_modules").join(&platform),
    ] {
        for entry in [
            "host-runtime.mjs",
            "desktop-controller.mjs",
            "console-server.mjs",
        ] {
            paths.push(root.join("app").join(entry));
        }
    }
    paths
        .into_iter()
        .map(|relative| {
            let file = prefix.join(&relative);
            let mut current = prefix.to_path_buf();
            for part in std::iter::once(None).chain(relative.components().map(Some)) {
                if let Some(part) = part {
                    current.push(part);
                }
                let info = match std::fs::symlink_metadata(&current) {
                    Ok(info) => info,
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
                    Err(error) => return Err(error.into()),
                };
                let linked = info.file_type().is_symlink();
                #[cfg(target_os = "windows")]
                let linked = {
                    use std::os::windows::fs::MetadataExt;
                    linked || info.file_attributes() & 0x400 != 0
                };
                if linked
                    || (current != file && !info.is_dir())
                    || (current == file && !info.is_file())
                {
                    return Err(
                        "npm recovery script path is redirected or has the wrong file type".into(),
                    );
                }
            }
            Ok(file)
        })
        .collect()
}

fn recovery_script_belongs(
    arguments: &[OsString],
    entries: &[PathBuf],
) -> Result<bool, Box<dyn Error>> {
    let Some(mut path) = script_path(arguments) else {
        return Ok(false);
    };
    let mut missing = Vec::new();
    // Node can remain alive after its entry script is unlinked. Resolve its
    // existing ancestor, retaining the missing suffix instead of ignoring it.
    loop {
        match path.canonicalize() {
            Ok(mut resolved) => {
                for part in missing.iter().rev() {
                    resolved.push(part);
                }
                return Ok(entries.iter().any(|entry| same_path(&resolved, entry)));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                missing.push(
                    path.file_name()
                        .ok_or("ambiguous Node script path")?
                        .to_os_string(),
                );
                path = path
                    .parent()
                    .ok_or("Node script has no existing ancestor")?;
            }
            Err(error) => return Err(error.into()),
        }
    }
}

#[cfg(target_os = "windows")]
pub(crate) fn ensure_quiescent(npm: &NpmInstallation) -> Result<(), Box<dyn Error>> {
    let prefix = npm.prefix.as_ref().ok_or("missing original prefix")?;
    codexhost_platform::WindowsLaunchJob::ensure_no_images_under(prefix)?;
    let scripts = recovery_entries(npm, crate::windows_installation::architecture())?;
    for process in codexhost_platform::process_arguments_for_executable(&npm.node_path)? {
        if recovery_script_belongs(&process.arguments, &scripts)? {
            return Err(format!(
                "installation script still held by PID {}; instance preserved",
                process.id
            )
            .into());
        }
    }
    Ok(())
}

#[cfg(target_os = "windows")]
pub(crate) fn shutdown(npm: &NpmInstallation) -> Result<(), Box<dyn Error>> {
    use codexhost_platform::{process_arguments_for_executable, process_snapshot};
    use std::time::{Duration, Instant};
    shutdown_shared_nodes(npm)?;
    let root = npm
        .package_root
        .as_ref()
        .ok_or("npm shutdown has no platform root")?;
    let launcher = root.join("bin/codexhost.exe").canonicalize()?;
    let observed = process_arguments_for_executable(&launcher)?;
    let started = Instant::now();
    loop {
        let mut pending = false;
        for observed in &observed {
            match process_snapshot(observed.id) {
                Ok(current)
                    if current.started_at_micros == observed.started_at_micros
                        && same_path(&current.executable.canonicalize()?, &launcher) =>
                {
                    pending = true
                }
                Ok(_) => {}
                Err(_) if !codexhost_platform::process_exists(observed.id) => {}
                Err(error) => return Err(error.into()),
            }
        }
        if !pending {
            break;
        }
        if started.elapsed() >= Duration::from_secs(3) {
            return Err("owned Launcher did not finish Desktop cleanup before timeout".into());
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let prefix = npm.prefix.as_ref().ok_or("npm shutdown has no prefix")?;
    let mut executables = Vec::new();
    for relative in [
        "libexec/codexhost-shim.exe",
        "libexec/codexhost-updater.exe",
        "libexec/codexhost-node-repl.exe",
    ] {
        let path = root.join(relative);
        match std::fs::symlink_metadata(&path) {
            Ok(_) => {
                crate::windows_installation::owned_file(prefix, &path)?;
                executables.push(path);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    codexhost_platform::shutdown_processes_for_executables(&executables)?;
    Ok(())
}

#[cfg(test)]
#[path = "npm_recovery_process_tests.rs"]
mod recovery_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    #[test]
    fn only_the_actual_script_is_an_installation_entrypoint() {
        let root =
            std::env::temp_dir().join(format!("codexhost-node-scope-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let entry = root.join("console-server.mjs");
        let other = root.join("unrelated.mjs");
        fs::write(&entry, "fixture").unwrap();
        fs::write(&other, "fixture").unwrap();
        let entries = vec![entry.canonicalize().unwrap()];
        let args = |items: &[&std::ffi::OsStr]| {
            items
                .iter()
                .map(|item| OsString::from(*item))
                .collect::<Vec<_>>()
        };
        assert!(script_belongs(
            &args(&[
                "node.exe".as_ref(),
                "--disable-warning=UNDICI-EHPA".as_ref(),
                entry.as_os_str(),
                "serve".as_ref()
            ]),
            &entries
        ));
        assert!(!script_belongs(
            &args(&["node.exe".as_ref(), other.as_os_str(), entry.as_os_str()]),
            &entries
        ));
        assert!(!script_belongs(
            &args(&["node.exe".as_ref(), "--require".as_ref(), entry.as_os_str()]),
            &entries
        ));
        assert!(!script_belongs(
            &args(&["node.exe".as_ref(), "--eval".as_ref(), entry.as_os_str()]),
            &entries
        ));
        fs::remove_dir_all(root).unwrap();
    }
    #[cfg(target_os = "windows")]
    #[test]
    fn windows_shared_node_shutdown_preserves_other_installations_and_unrelated_scripts() {
        use std::process::{Child, Command, Stdio};
        struct Fixture {
            root: PathBuf,
            children: Vec<Child>,
        }
        impl Drop for Fixture {
            fn drop(&mut self) {
                for child in &mut self.children {
                    let _ = child.kill();
                    let _ = child.wait();
                }
                let _ = fs::remove_dir_all(&self.root);
            }
        }
        let mut fixture = Fixture {
            root: std::env::temp_dir()
                .join(format!("codexhost-shared-node-{}", std::process::id())),
            children: Vec::new(),
        };
        let prefix = fixture.root.join("中文 current prefix");
        let platform = prefix.join("node_modules/platform");
        let cli = prefix.join("node_modules/cli/bin/codexhost.js");
        let target = platform.join("app/console-server.mjs");
        let foreign = fixture.root.join("other-install/app/console-server.mjs");
        let unrelated = fixture.root.join("unrelated.mjs");
        for file in [
            &cli,
            &target,
            &foreign,
            &unrelated,
            &platform.join("app/host-runtime.mjs"),
            &platform.join("app/desktop-controller.mjs"),
            &platform.join("bin/codexhost.exe"),
        ] {
            fs::create_dir_all(file.parent().unwrap()).unwrap();
            fs::write(file, "setInterval(() => {}, 1000);").unwrap();
        }
        for file in [&target, &foreign, &unrelated] {
            let mut command = Command::new("node");
            command.arg(file);
            if file == &unrelated {
                command.arg(&target);
            }
            fixture.children.push(
                command
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn()
                    .unwrap(),
            );
        }
        std::thread::sleep(std::time::Duration::from_millis(150));
        let owner = codexhost_platform::process_snapshot(fixture.children[0].id()).unwrap();
        let npm = NpmInstallation {
            node_path: owner.executable.clone(),
            npm_cli_path: fixture.root.join("unused-npm"),
            npm_launcher_path: cli,
            prefix: Some(prefix),
            package_root: Some(platform),
            installed_version: Some("1.2.3".into()),
            prepared: None,
            recovery: None,
        };
        validate_wait_owner(&npm, &owner).unwrap();
        assert!(
            validate_wait_owner(
                &npm,
                &codexhost_platform::process_snapshot(fixture.children[1].id()).unwrap()
            )
            .is_err()
        );
        let reused = codexhost_platform::ProcessArguments {
            id: owner.id,
            started_at_micros: owner.started_at_micros + 1,
            arguments: vec![
                owner.executable.as_os_str().to_owned(),
                target.as_os_str().to_owned(),
            ],
        };
        assert!(!observed_instance_belongs(
            &reused,
            &owner,
            &owner.executable.canonicalize().unwrap(),
            &entries(&npm).unwrap()
        ));
        shutdown(&npm).unwrap();
        assert!(fixture.children[0].try_wait().unwrap().is_some());
        assert!(fixture.children[1].try_wait().unwrap().is_none());
        assert!(fixture.children[2].try_wait().unwrap().is_none());
        shutdown(&npm).unwrap();
    }

    #[test]
    fn derives_only_fixed_core_entries_from_the_verified_platform_root() {
        let npm = NpmInstallation {
            node_path: "/node".into(),
            npm_cli_path: "/npm".into(),
            npm_launcher_path: "/missing-cli".into(),
            prefix: None,
            package_root: None,
            installed_version: None,
            prepared: None,
            recovery: None,
        };
        assert!(entries(&npm).is_err());
    }
}
