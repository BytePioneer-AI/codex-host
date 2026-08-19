use std::ffi::OsString;
#[cfg(any(target_os = "macos", target_os = "linux"))]
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Child, Command, Stdio};
#[cfg(any(target_os = "macos", target_os = "linux"))]
use std::thread;
#[cfg(any(target_os = "macos", target_os = "linux"))]
use std::time::{Duration, Instant};

#[cfg(target_os = "macos")]
use super::process::desktop_root_snapshots_for_installation;
#[cfg(any(target_os = "macos", target_os = "linux"))]
use super::process::{ObservedProcessTree, ProcessSnapshot, desktop_process_tree};
#[cfg(target_os = "linux")]
use super::process::{
    descendant_snapshots, desktop_root_snapshots, process_snapshot, process_snapshots,
    same_process_instance, signal_processes_exact,
};
use super::{
    CODEX_CLI_PATH_ENV, DesktopInstallation, DesktopLaunchMode, PlatformError,
    STOCK_CODEX_PATH_ENV, canonical_existing_file,
};

const CODEXHOST_RELEASES_LATEST_URL: &str =
    "https://github.com/BytePioneer-AI/codex-host/releases/latest";

fn remove_codexhost_environment(command: &mut Command, names: impl IntoIterator<Item = OsString>) {
    for name in names {
        if name == CODEX_CLI_PATH_ENV || name.to_string_lossy().starts_with("CODEXHOST_") {
            command.env_remove(name);
        }
    }
}

fn stock_desktop_command(installation: &DesktopInstallation) -> Result<Command, PlatformError> {
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = Command::new("/usr/bin/open");
        command.arg("-n").arg(&installation.install_root);
        command
    };

    #[cfg(any(target_os = "windows", target_os = "linux"))]
    let mut command = Command::new(&installation.desktop_launcher);

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    return Err(PlatformError::Unsupported(
        "stock Desktop launch currently supports Windows, macOS, and Linux only",
    ));

    remove_codexhost_environment(&mut command, std::env::vars_os().map(|(name, _)| name));
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    Ok(command)
}

pub fn launch_stock_desktop(installation: &DesktopInstallation) -> Result<Child, PlatformError> {
    stock_desktop_command(installation)?
        .spawn()
        .map_err(PlatformError::Io)
}

#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
fn latest_release_command() -> Command {
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = Command::new("/usr/bin/open");
        command.arg(CODEXHOST_RELEASES_LATEST_URL);
        command
    };

    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = Command::new("explorer.exe");
        command.arg(CODEXHOST_RELEASES_LATEST_URL);
        command
    };

    #[cfg(target_os = "linux")]
    let mut command = {
        let mut command = Command::new("xdg-open");
        command.arg(CODEXHOST_RELEASES_LATEST_URL);
        command
    };

    configure_external_command(&mut command);
    command
}

pub fn open_latest_codexhost_release() -> Result<(), PlatformError> {
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    return Err(PlatformError::Unsupported(
        "opening the codexhost Releases page is supported on Windows, macOS, and Linux only",
    ));

    #[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
    latest_release_command().spawn()?.wait()?;
    Ok(())
}

#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
fn configure_external_command(command: &mut Command) {
    remove_codexhost_environment(command, std::env::vars_os().map(|(name, _)| name));
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    super::configure_background_command(command);
}

fn desktop_launch_command(
    installation: &DesktopInstallation,
    shim_path: &Path,
    mode: DesktopLaunchMode,
    additional_arguments: &[OsString],
    additional_environment: &[(OsString, OsString)],
) -> Result<Command, PlatformError> {
    let shim_path = canonical_existing_file(shim_path)?;
    let mut environment = vec![
        (
            OsString::from(CODEX_CLI_PATH_ENV),
            shim_path.as_os_str().to_owned(),
        ),
        (
            OsString::from(STOCK_CODEX_PATH_ENV),
            installation.executable_codex_cli.as_os_str().to_owned(),
        ),
    ];
    environment.extend_from_slice(additional_environment);

    #[cfg(target_os = "macos")]
    let mut command = match mode {
        DesktopLaunchMode::LaunchServices => {
            let mut command = Command::new("/usr/bin/open");
            command.arg("-n").arg("-W");
            for (key, value) in &environment {
                let key = key.to_str().ok_or_else(|| {
                    PlatformError::Invalid("LaunchServices environment key is not UTF-8".into())
                })?;
                let value = value.to_str().ok_or_else(|| {
                    PlatformError::Invalid(format!(
                        "LaunchServices environment value for {key} is not UTF-8"
                    ))
                })?;
                command.arg("--env").arg(format!("{key}={value}"));
            }
            command.arg(&installation.install_root);
            if !additional_arguments.is_empty() {
                command.arg("--args").args(additional_arguments);
            }
            command
        }
        DesktopLaunchMode::DirectExecutable => {
            let mut command = Command::new(&installation.desktop_executable);
            command
                .args(additional_arguments)
                .envs(environment)
                .process_group(0);
            command
        }
    };

    #[cfg(any(target_os = "windows", target_os = "linux"))]
    let mut command = {
        if mode != DesktopLaunchMode::DirectExecutable {
            return Err(PlatformError::Unsupported(
                "LaunchServices is available on macOS only",
            ));
        }
        let mut command = Command::new(&installation.desktop_executable);
        command.args(additional_arguments).envs(environment);
        #[cfg(target_os = "linux")]
        command.process_group(0);
        command
    };

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    return Err(PlatformError::Unsupported(
        "managed Desktop launch currently supports Windows, macOS, and Linux only",
    ));

    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    Ok(command)
}

pub fn launch_desktop(
    installation: &DesktopInstallation,
    shim_path: &Path,
    mode: DesktopLaunchMode,
    additional_arguments: &[OsString],
    additional_environment: &[(OsString, OsString)],
) -> Result<Child, PlatformError> {
    desktop_launch_command(
        installation,
        shim_path,
        mode,
        additional_arguments,
        additional_environment,
    )?
    .spawn()
    .map_err(PlatformError::Io)
}

#[cfg(target_os = "linux")]
fn remember_processes(known: &mut Vec<ProcessSnapshot>, processes: &[ProcessSnapshot]) {
    for process in processes {
        if let Some(existing) = known.iter_mut().find(|existing| existing.id == process.id) {
            *existing = process.clone();
        } else {
            known.push(process.clone());
        }
    }
}

#[cfg(target_os = "linux")]
fn cleanup_failed_desktop_launch(
    launch_process: &mut Child,
    observed_members: &[ProcessSnapshot],
) -> Result<(), PlatformError> {
    signal_processes_exact(observed_members, nix::sys::signal::Signal::SIGKILL)?;
    let _ = launch_process.wait();
    Ok(())
}

#[cfg(target_os = "linux")]
fn cleanup_failed_desktop_launch_preserving_conflict(
    launch_process: &mut Child,
    observed_members: &[ProcessSnapshot],
    conflict: PlatformError,
) -> PlatformError {
    match cleanup_failed_desktop_launch(launch_process, observed_members) {
        Ok(()) => conflict,
        Err(cleanup_error) => PlatformError::Invalid(format!(
            "{conflict}; additionally failed to clean up this launch: {cleanup_error}"
        )),
    }
}

#[cfg(target_os = "linux")]
fn is_managed_desktop_root(
    launcher_instance: &ProcessSnapshot,
    launcher_process_group_id: u32,
    observed_descendants: &[ProcessSnapshot],
    root: &ProcessSnapshot,
) -> bool {
    root.process_group_id == launcher_process_group_id
        && root.started_at_micros >= launcher_instance.started_at_micros
        // An exec preserves PID/start time but replaces the executable, while
        // a forking wrapper produces a descendant. Exact instance identity is
        // essential: a same-PID process after reuse is never owned.
        && (same_process_instance(root, launcher_instance)
            || observed_descendants
                .iter()
                .any(|descendant| same_process_instance(root, descendant)))
}

/// Select the Desktop root that can be attributed to this exact Launcher
/// instance. `roots` are only the matching Desktop executable roots; a root
/// from another process group or another launcher lineage is a conflict, never
/// a candidate for managed cleanup.
#[cfg(target_os = "linux")]
fn select_managed_desktop_root(
    launcher_instance: &ProcessSnapshot,
    launcher_process_group_id: u32,
    observed_descendants: &[ProcessSnapshot],
    roots: &[ProcessSnapshot],
) -> Result<Option<ProcessSnapshot>, PlatformError> {
    let managed = roots
        .iter()
        .filter(|root| {
            is_managed_desktop_root(
                launcher_instance,
                launcher_process_group_id,
                observed_descendants,
                root,
            )
        })
        .cloned()
        .collect::<Vec<_>>();
    if managed.len() > 1 {
        return Err(PlatformError::Invalid(format!(
            "managed Desktop launch created multiple root processes: {}",
            managed
                .iter()
                .map(|process| process.id.to_string())
                .collect::<Vec<_>>()
                .join(", ")
        )));
    }
    if roots.len() > managed.len() {
        return Err(PlatformError::UnmanagedDesktopConflict);
    }
    Ok(managed.into_iter().next())
}

#[cfg(target_os = "macos")]
fn cleanup_failed_desktop_launch(launch_process: &mut Child, mode: DesktopLaunchMode) {
    if mode == DesktopLaunchMode::DirectExecutable {
        use nix::sys::signal::{Signal, killpg};
        use nix::unistd::Pid;

        if let Ok(process_group) = i32::try_from(launch_process.id()) {
            let _ = killpg(Pid::from_raw(process_group), Signal::SIGKILL);
        }
    }
    let _ = launch_process.kill();
    let _ = launch_process.wait();
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
pub struct DesktopSession {
    launch_process: Child,
    tree: ObservedProcessTree,
    armed: bool,
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
impl DesktopSession {
    #[must_use]
    pub fn root_snapshot(&self) -> &ProcessSnapshot {
        &self.tree.root
    }

    pub fn observe(&mut self) -> Result<Vec<ProcessSnapshot>, PlatformError> {
        let _ = self.launch_process.try_wait()?;
        self.tree.observe()
    }

    pub fn is_running(&mut self) -> Result<bool, PlatformError> {
        self.tree.root_is_live()
    }

    pub fn terminate(&mut self) -> Result<(), PlatformError> {
        self.tree.signal_exact(nix::sys::signal::Signal::SIGTERM)
    }

    pub fn force_terminate(&mut self) -> Result<(), PlatformError> {
        self.tree.signal_exact(nix::sys::signal::Signal::SIGKILL)
    }

    pub fn cleanup_escaped(&mut self, grace: Duration) -> Result<Vec<u32>, PlatformError> {
        let escaped = self.tree.escaped()?;
        if escaped.is_empty() {
            return Ok(Vec::new());
        }
        let process_ids = escaped.iter().map(|process| process.id).collect::<Vec<_>>();
        self.tree
            .signal_processes(&escaped, nix::sys::signal::Signal::SIGTERM)?;
        let started = Instant::now();
        let still_live = loop {
            let still_live = self
                .tree
                .escaped()?
                .into_iter()
                .filter(|process| process_ids.contains(&process.id))
                .collect::<Vec<_>>();
            if still_live.is_empty() {
                return Ok(process_ids);
            }
            if started.elapsed() >= grace {
                break still_live;
            }
            thread::sleep(Duration::from_millis(20));
        };
        self.tree
            .signal_processes(&still_live, nix::sys::signal::Signal::SIGKILL)?;
        let forced_at = Instant::now();
        loop {
            let still_live = self
                .tree
                .escaped()?
                .into_iter()
                .filter(|process| process_ids.contains(&process.id))
                .collect::<Vec<_>>();
            if still_live.is_empty() {
                return Ok(process_ids);
            }
            if forced_at.elapsed() >= grace {
                return Err(PlatformError::Invalid(format!(
                    "escaped Desktop descendants remained after forced termination: {}",
                    still_live
                        .iter()
                        .map(|process| process.id.to_string())
                        .collect::<Vec<_>>()
                        .join(",")
                )));
            }
            thread::sleep(Duration::from_millis(20));
        }
    }

    pub fn wait_for_exit(&mut self, timeout: Duration) -> Result<bool, PlatformError> {
        let started = Instant::now();
        loop {
            if self.observe()?.is_empty() {
                self.armed = false;
                return Ok(true);
            }
            if started.elapsed() >= timeout {
                return Ok(false);
            }
            thread::sleep(Duration::from_millis(50));
        }
    }

    pub fn shutdown(&mut self, grace: Duration) -> Result<(), PlatformError> {
        self.terminate()?;
        if !self.wait_for_exit(grace)? {
            self.force_terminate()?;
            if !self.wait_for_exit(grace)? {
                return Err(PlatformError::Invalid(
                    "Desktop process tree did not exit after forced termination".into(),
                ));
            }
        }
        Ok(())
    }

    pub fn disarm_cleanup(&mut self) {
        self.armed = false;
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
impl Drop for DesktopSession {
    fn drop(&mut self) {
        if self.armed {
            let _ = self.force_terminate();
        }
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
pub fn launch_desktop_session(
    installation: &DesktopInstallation,
    shim_path: &Path,
    mode: DesktopLaunchMode,
    additional_arguments: &[OsString],
    additional_environment: &[(OsString, OsString)],
    start_timeout: Duration,
) -> Result<DesktopSession, PlatformError> {
    if !desktop_process_tree(installation)?.is_empty() {
        return Err(PlatformError::Invalid(
            "Codex Desktop is already running; refusing to reuse or terminate it".into(),
        ));
    }
    #[cfg(target_os = "linux")]
    {
        let mut launch_process = desktop_launch_command(
            installation,
            shim_path,
            mode,
            additional_arguments,
            additional_environment,
        )?
        .spawn()?;
        let launcher_instance = match process_snapshot(launch_process.id()) {
            Ok(launcher) => launcher,
            Err(error) => {
                let _ = launch_process.kill();
                let _ = launch_process.wait();
                return Err(error);
            }
        };
        let launcher_process_group_id = launcher_instance.process_group_id;
        if mode != DesktopLaunchMode::DirectExecutable {
            let _ = cleanup_failed_desktop_launch(
                &mut launch_process,
                std::slice::from_ref(&launcher_instance),
            );
            return Err(PlatformError::Unsupported(
                "managed Linux Desktop launch requires direct-executable mode",
            ));
        }
        if launcher_process_group_id != launcher_instance.id {
            let _ = cleanup_failed_desktop_launch(
                &mut launch_process,
                std::slice::from_ref(&launcher_instance),
            );
            return Err(PlatformError::Invalid(format!(
                "Desktop launcher PID {} did not become process-group leader",
                launcher_instance.id
            )));
        }

        let spawner_executable = process_snapshot(std::process::id())?.executable;
        // The child may still expose this process before exec, or may already
        // be the Desktop executable. Managed Linux launch no longer goes
        // through the official wrapper or its interpreter.
        if launcher_instance.executable != installation.desktop_executable
            && launcher_instance.executable != spawner_executable
        {
            let _ = cleanup_failed_desktop_launch(
                &mut launch_process,
                std::slice::from_ref(&launcher_instance),
            );
            return Err(PlatformError::Invalid(format!(
                "Desktop launcher PID {} did not retain a Desktop executable identity",
                launcher_instance.id
            )));
        }

        let started = Instant::now();
        let mut observed_members = vec![launcher_instance.clone()];
        let mut observed_descendants = Vec::new();
        loop {
            let snapshots = match process_snapshots() {
                Ok(snapshots) => snapshots,
                Err(error) => {
                    return Err(cleanup_failed_desktop_launch_preserving_conflict(
                        &mut launch_process,
                        &observed_members,
                        error,
                    ));
                }
            };
            let launcher_live = snapshots
                .iter()
                .find(|process| process.id == launcher_instance.id);
            if let Some(current) = launcher_live {
                if !same_process_instance(&launcher_instance, current) {
                    return Err(cleanup_failed_desktop_launch_preserving_conflict(
                        &mut launch_process,
                        &observed_members,
                        PlatformError::Invalid(format!(
                            "Desktop launcher PID {} was reused before ownership was established",
                            launcher_instance.id
                        )),
                    ));
                }
                remember_processes(&mut observed_members, std::slice::from_ref(current));
                remember_processes(
                    &mut observed_descendants,
                    &descendant_snapshots(&[launcher_instance.id], &snapshots),
                );
            } else if observed_descendants.is_empty() {
                return Err(cleanup_failed_desktop_launch_preserving_conflict(
                    &mut launch_process,
                    &observed_members,
                    PlatformError::NotFound(format!(
                        "Desktop launcher PID {} exited before creating an identifiable App process",
                        launcher_instance.id
                    )),
                ));
            }

            let roots = desktop_root_snapshots(&installation.desktop_executable, &snapshots);
            // Retain only snapshots linked to this exact launcher lineage for
            // early-failure cleanup. The private PGID constrains managed roots,
            // but on its own is not proof that an observed process belongs to
            // this launch.
            remember_processes(&mut observed_members, &observed_descendants);
            let managed_root = select_managed_desktop_root(
                &launcher_instance,
                launcher_process_group_id,
                &observed_descendants,
                &roots,
            );
            match managed_root {
                Ok(Some(root)) => {
                    return Ok(DesktopSession {
                        launch_process,
                        tree: ObservedProcessTree::new_with_owned_processes(
                            root,
                            Some(launcher_process_group_id),
                            Some(launcher_instance.started_at_micros),
                            observed_members,
                        ),
                        armed: true,
                    });
                }
                Ok(None) if started.elapsed() < start_timeout => {
                    thread::sleep(Duration::from_millis(50));
                }
                Ok(None) => {
                    return Err(cleanup_failed_desktop_launch_preserving_conflict(
                        &mut launch_process,
                        &observed_members,
                        PlatformError::NotFound(
                            "Desktop launch did not create an identifiable App process before timeout"
                                .into(),
                        ),
                    ));
                }
                Err(error) => {
                    return Err(cleanup_failed_desktop_launch_preserving_conflict(
                        &mut launch_process,
                        &observed_members,
                        error,
                    ));
                }
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        let mut launch_process = desktop_launch_command(
            installation,
            shim_path,
            mode,
            additional_arguments,
            additional_environment,
        )?
        .spawn()?;
        let started = Instant::now();
        loop {
            let roots = desktop_root_snapshots_for_installation(installation)?;
            match roots.as_slice() {
                [root] => {
                    if mode == DesktopLaunchMode::DirectExecutable
                        && root.process_group_id != root.id
                    {
                        cleanup_failed_desktop_launch(&mut launch_process, mode);
                        return Err(PlatformError::Invalid(format!(
                            "Desktop root PID {} did not become process-group leader",
                            root.id
                        )));
                    }
                    return Ok(DesktopSession {
                        launch_process,
                        tree: ObservedProcessTree::new(root.clone()),
                        armed: true,
                    });
                }
                [] if started.elapsed() < start_timeout => {
                    if let Some(status) = launch_process.try_wait()?
                        && !status.success()
                    {
                        return Err(PlatformError::Invalid(format!(
                            "Desktop launch process exited before creating the App instance: {status}"
                        )));
                    }
                    thread::sleep(Duration::from_millis(50));
                }
                [] => {
                    cleanup_failed_desktop_launch(&mut launch_process, mode);
                    return Err(PlatformError::NotFound(
                        "Desktop launch did not create an identifiable App process before timeout"
                            .into(),
                    ));
                }
                _ => {
                    cleanup_failed_desktop_launch(&mut launch_process, mode);
                    return Err(PlatformError::Invalid(format!(
                        "Desktop launch created multiple root processes: {}",
                        roots
                            .iter()
                            .map(|process| process.id.to_string())
                            .collect::<Vec<_>>()
                            .join(", ")
                    )));
                }
            }
        }
    }
}

#[cfg(all(test, any(target_os = "macos", target_os = "linux")))]
mod tests {
    use std::ffi::OsString;
    use std::fs;
    use std::io::{BufRead, BufReader};
    #[cfg(target_os = "linux")]
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::process::CommandExt;
    #[cfg(target_os = "linux")]
    use std::path::Path;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    #[cfg(target_os = "macos")]
    use super::desktop_launch_command;
    use super::{
        CODEXHOST_RELEASES_LATEST_URL, DesktopSession, latest_release_command,
        remove_codexhost_environment,
    };
    #[cfg(target_os = "linux")]
    use super::{
        desktop_launch_command, is_managed_desktop_root, launch_desktop_session,
        select_managed_desktop_root, stock_desktop_command,
    };
    use crate::process::{ObservedProcessTree, ProcessSnapshot, unix_process_snapshot};
    use crate::process_exists;
    use crate::temporary_directory;
    #[cfg(target_os = "macos")]
    use crate::{DesktopIdentity, DesktopInstallation, DesktopLaunchMode};
    #[cfg(target_os = "linux")]
    use crate::{DesktopIdentity, DesktopInstallation, DesktopLaunchMode, PlatformError};

    #[cfg(target_os = "linux")]
    fn linux_installation() -> DesktopInstallation {
        DesktopInstallation {
            identity: DesktopIdentity::LinuxPackage {
                package_name: "chatgpt".into(),
                brand: "chatgpt".into(),
                flavor: "prod".into(),
            },
            version: "26.803.81509".into(),
            build: "26.803.81509".into(),
            asar_integrity: format!("sha256:{}", "0".repeat(64)),
            install_root: "/usr/lib/chatgpt".into(),
            desktop_launcher: "/usr/bin/chatgpt".into(),
            desktop_executable: "/usr/lib/chatgpt/ChatGPT".into(),
            packaged_codex_cli: "/usr/lib/chatgpt/resources/codex".into(),
            executable_codex_cli: "/usr/lib/chatgpt/resources/codex".into(),
        }
    }

    fn spawned_sleep_snapshot(process_id: u32) -> ProcessSnapshot {
        let expected_executable = std::fs::canonicalize("/bin/sleep").expect("canonical sleep");
        let started = Instant::now();
        loop {
            let snapshot = unix_process_snapshot(process_id).expect("snapshot spawned sleep");
            if snapshot.executable == expected_executable {
                return snapshot;
            }
            assert!(
                started.elapsed() < Duration::from_secs(2),
                "spawned sleep did not exec before supervision"
            );
            std::thread::sleep(Duration::from_millis(1));
        }
    }

    #[cfg(target_os = "linux")]
    fn snapshot(
        id: u32,
        parent_id: u32,
        process_group_id: u32,
        executable: &str,
        started_at_micros: u64,
    ) -> ProcessSnapshot {
        ProcessSnapshot {
            id,
            parent_id,
            process_group_id,
            executable: executable.into(),
            started_at_micros,
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_managed_launches_the_desktop_executable_without_the_official_launcher() {
        let installation = linux_installation();
        let stock = stock_desktop_command(&installation).expect("stock Desktop command");
        assert_eq!(stock.get_program(), installation.desktop_launcher);
        let managed = desktop_launch_command(
            &installation,
            Path::new("/usr/bin/true"),
            DesktopLaunchMode::DirectExecutable,
            &[],
            &[],
        )
        .expect("managed Desktop command");
        assert_eq!(managed.get_program(), installation.desktop_executable);
        assert_ne!(
            installation.desktop_launcher,
            installation.desktop_executable
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn managed_launch_supervises_the_desktop_executable_directly() {
        let directory = temporary_directory("codexhost-direct-desktop");
        let desktop = directory.join("ChatGPT");
        fs::copy("/bin/sleep", &desktop).expect("copy fake Desktop");
        fs::set_permissions(&desktop, fs::Permissions::from_mode(0o755))
            .expect("make fake Desktop executable");
        let desktop = desktop.canonicalize().expect("canonical fake Desktop");
        let launcher = directory.join("codex-launcher");
        fs::write(&launcher, b"#!/bin/sh\nexit 1\n").expect("write unused official launcher");
        fs::set_permissions(&launcher, fs::Permissions::from_mode(0o755))
            .expect("make unused launcher executable");
        let mut installation = linux_installation();
        installation.install_root = directory.clone();
        installation.desktop_launcher = launcher;
        installation.desktop_executable = desktop.clone();
        installation.packaged_codex_cli = "/bin/true".into();
        installation.executable_codex_cli = "/bin/true".into();

        let mut session = launch_desktop_session(
            &installation,
            Path::new("/bin/true"),
            DesktopLaunchMode::DirectExecutable,
            &[OsString::from("30")],
            &[],
            Duration::from_secs(2),
        )
        .expect("launch Desktop executable directly");
        assert_eq!(session.root_snapshot().executable, desktop);
        session
            .shutdown(Duration::from_secs(2))
            .expect("stop fake Desktop");
        fs::remove_dir_all(directory).expect("remove direct Desktop fixture");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn launch_ownership_rejects_an_independent_root_after_precheck() {
        let launcher = snapshot(10, 1, 10, "/usr/lib/chatgpt/codex-launcher", 100);
        let independent = snapshot(20, 1, 20, "/usr/lib/chatgpt/ChatGPT", 101);
        assert!(!is_managed_desktop_root(&launcher, 10, &[], &independent));
        assert!(matches!(
            select_managed_desktop_root(&launcher, 10, &[], &[independent]),
            Err(PlatformError::UnmanagedDesktopConflict)
        ));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn launch_ownership_rejects_a_managed_and_independent_root_together() {
        let launcher = snapshot(10, 1, 10, "/usr/lib/chatgpt/codex-launcher", 100);
        let managed = snapshot(11, 10, 10, "/usr/lib/chatgpt/ChatGPT", 101);
        let independent = snapshot(20, 1, 20, "/usr/lib/chatgpt/ChatGPT", 102);
        assert!(matches!(
            select_managed_desktop_root(
                &launcher,
                10,
                &[managed],
                &[
                    snapshot(11, 10, 10, "/usr/lib/chatgpt/ChatGPT", 101,),
                    independent
                ]
            ),
            Err(PlatformError::UnmanagedDesktopConflict)
        ));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn launch_ownership_accepts_the_wrapper_exec_path() {
        let launcher = snapshot(10, 1, 10, "/usr/lib/chatgpt/codex-launcher", 100);
        let execed = snapshot(10, 1, 10, "/usr/lib/chatgpt/ChatGPT", 100);
        assert!(is_managed_desktop_root(&launcher, 10, &[], &execed));
        assert_eq!(
            select_managed_desktop_root(&launcher, 10, &[], std::slice::from_ref(&execed))
                .expect("selection"),
            Some(execed)
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn launch_ownership_accepts_only_an_exact_launcher_descendant_in_its_group() {
        let launcher = snapshot(10, 1, 10, "/usr/lib/chatgpt/codex-launcher", 100);
        let managed = snapshot(11, 10, 10, "/usr/lib/chatgpt/ChatGPT", 101);
        let wrong_group = snapshot(12, 10, 12, "/usr/lib/chatgpt/ChatGPT", 102);
        let unrelated = snapshot(13, 1, 10, "/usr/lib/chatgpt/ChatGPT", 103);
        assert!(is_managed_desktop_root(
            &launcher,
            10,
            std::slice::from_ref(&managed),
            &managed,
        ));
        assert!(!is_managed_desktop_root(
            &launcher,
            10,
            &[managed.clone(), wrong_group.clone()],
            &wrong_group,
        ));
        assert!(!is_managed_desktop_root(
            &launcher,
            10,
            &[managed],
            &unrelated
        ));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn launcher_identity_reuse_cannot_be_used_for_cleanup() {
        let launcher = snapshot(10, 1, 10, "/usr/lib/chatgpt/codex-launcher", 100);
        let reused = snapshot(10, 1, 10, "/usr/lib/chatgpt/ChatGPT", 101);
        assert!(!is_managed_desktop_root(&launcher, 10, &[], &reused));
        assert!(matches!(
            select_managed_desktop_root(&launcher, 10, &[], &[reused]),
            Err(PlatformError::UnmanagedDesktopConflict)
        ));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn cleanup_failure_does_not_hide_an_unmanaged_desktop_conflict() {
        let launcher = snapshot(10, 1, 10, "/usr/lib/chatgpt/codex-launcher", 100);
        let result = super::cleanup_failed_desktop_launch_preserving_conflict(
            &mut Command::new("/bin/true")
                .spawn()
                .expect("spawn cleanup fixture"),
            std::slice::from_ref(&launcher),
            PlatformError::UnmanagedDesktopConflict,
        );
        assert!(match result {
            PlatformError::UnmanagedDesktopConflict => true,
            PlatformError::Invalid(message) => message.contains("outside codexhost"),
            _ => false,
        });
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn observed_session_cleanup_does_not_signal_an_unrelated_group() {
        let mut own_command = Command::new("/bin/sleep");
        own_command
            .arg("30")
            .process_group(0)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let mut own = own_command.spawn().expect("spawn owned fixture");
        let own_snapshot = spawned_sleep_snapshot(own.id());

        let mut independent_command = Command::new("/bin/sleep");
        independent_command
            .arg("30")
            .process_group(0)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let mut independent = independent_command
            .spawn()
            .expect("spawn independent fixture");
        let independent_snapshot = spawned_sleep_snapshot(independent.id());

        super::cleanup_failed_desktop_launch(&mut own, std::slice::from_ref(&own_snapshot))
            .expect("clean owned fixture");
        let started = Instant::now();
        while own.try_wait().expect("wait owned fixture").is_none() {
            assert!(started.elapsed() < Duration::from_secs(2));
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(process_exists(independent_snapshot.id));
        independent.kill().expect("stop independent fixture");
        let _ = independent.wait().expect("reap independent fixture");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn launch_services_forwards_only_the_ephemeral_inspector_argument() {
        let directory = temporary_directory("codexhost-desktop-launch-args");
        let shim = directory.join("codexhost-shim");
        fs::write(&shim, b"shim").expect("write fake Shim");
        let installation = DesktopInstallation {
            #[cfg(target_os = "macos")]
            identity: DesktopIdentity::MacOsBundle {
                bundle_identifier: "com.openai.codex".into(),
            },
            #[cfg(target_os = "linux")]
            identity: DesktopIdentity::LinuxPackage {
                package_name: "chatgpt".into(),
                brand: "chatgpt".into(),
                flavor: "prod".into(),
            },
            version: "1.0.0".into(),
            build: "100".into(),
            asar_integrity: format!("sha256:{}", "0".repeat(64)),
            install_root: "/Applications/ChatGPT.app".into(),
            desktop_launcher: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT".into(),
            desktop_executable: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT".into(),
            packaged_codex_cli: "/Applications/ChatGPT.app/Contents/Resources/codex".into(),
            executable_codex_cli: "/Applications/ChatGPT.app/Contents/Resources/codex".into(),
        };
        let command = desktop_launch_command(
            &installation,
            &shim,
            DesktopLaunchMode::LaunchServices,
            &[OsString::from("--inspect=127.0.0.1:43123")],
            &[],
        )
        .expect("LaunchServices command");
        let arguments = command
            .get_args()
            .map(|argument| argument.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert!(
            arguments
                .windows(2)
                .any(|pair| pair == ["--args", "--inspect=127.0.0.1:43123"])
        );
        assert!(
            !arguments
                .iter()
                .any(|argument| argument.contains("remote-debugging"))
        );
        fs::remove_dir_all(directory).expect("remove launch fixture");
    }

    #[test]
    fn latest_release_uses_only_the_fixed_github_url() {
        let command = latest_release_command();
        #[cfg(target_os = "macos")]
        assert_eq!(command.get_program(), "/usr/bin/open");
        #[cfg(target_os = "linux")]
        assert_eq!(command.get_program(), "xdg-open");
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            [CODEXHOST_RELEASES_LATEST_URL]
        );
    }

    #[test]
    fn stock_launch_removes_all_codexhost_environment() {
        let mut command = Command::new("/usr/bin/true");
        remove_codexhost_environment(
            &mut command,
            [
                OsString::from("CODEX_CLI_PATH"),
                OsString::from("CODEXHOST_HOST_RUNTIME_PATH"),
                OsString::from("UNRELATED"),
            ],
        );
        let environment = command.get_envs().collect::<Vec<_>>();
        assert!(environment.contains(&(std::ffi::OsStr::new("CODEX_CLI_PATH"), None)));
        assert!(
            environment.contains(&(std::ffi::OsStr::new("CODEXHOST_HOST_RUNTIME_PATH"), None,))
        );
        assert!(!environment.iter().any(|(name, _)| *name == "UNRELATED"));
    }

    #[test]
    fn outer_session_does_not_own_a_launcher_child() {
        let mut desktop_command = Command::new("/bin/sleep");
        desktop_command
            .arg("60")
            .process_group(0)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let desktop = desktop_command.spawn().expect("spawn fake Desktop root");
        let desktop_snapshot = spawned_sleep_snapshot(desktop.id());
        let mut session = DesktopSession {
            launch_process: desktop,
            tree: ObservedProcessTree::new(desktop_snapshot),
            armed: true,
        };

        let mut updater_command = Command::new("/bin/sleep");
        updater_command
            .arg("60")
            .process_group(0)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let mut updater = updater_command.spawn().expect("spawn Launcher child");
        assert!(
            session
                .observe()
                .expect("observe Desktop tree")
                .iter()
                .all(|process| process.id != updater.id())
        );

        session
            .shutdown(Duration::from_secs(2))
            .expect("stop Desktop tree");
        assert!(process_exists(updater.id()));
        updater.kill().expect("stop Launcher child");
        let _ = updater.wait().expect("reap Launcher child");
    }

    #[test]
    fn outer_session_cleans_a_cli_after_the_fake_shim_is_killed() {
        let mut command = Command::new("/bin/sh");
        command
            .args(["-c", "sleep 60 & echo $!; wait"])
            .process_group(0)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let mut root = command.spawn().expect("spawn fake supervised root");
        let mut output = BufReader::new(root.stdout.take().expect("fake root stdout"));
        let mut child_line = String::new();
        output
            .read_line(&mut child_line)
            .expect("read fake child PID");
        let child_id = child_line.trim().parse::<u32>().expect("fake child PID");
        let root_snapshot = unix_process_snapshot(root.id()).expect("snapshot ready fake root");
        let mut session = DesktopSession {
            launch_process: root,
            tree: ObservedProcessTree::new(root_snapshot),
            armed: true,
        };
        let observed = session.observe().expect("observe fake process tree");
        assert!(observed.iter().any(|process| process.id == child_id));

        session.launch_process.kill().expect("kill fake root");
        let _ = session.launch_process.wait().expect("reap fake root");
        let cleaned = session
            .cleanup_escaped(Duration::from_secs(2))
            .expect("clean fake escaped child");
        assert!(cleaned.contains(&child_id));
        assert!(!process_exists(child_id));
        session.disarm_cleanup();
    }
}
