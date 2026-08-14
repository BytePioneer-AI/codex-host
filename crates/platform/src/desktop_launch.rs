use std::ffi::OsString;
#[cfg(any(target_os = "macos", target_os = "linux"))]
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Child, Command, Stdio};
#[cfg(any(target_os = "macos", target_os = "linux"))]
use std::thread;
#[cfg(any(target_os = "macos", target_os = "linux"))]
use std::time::{Duration, Instant};

#[cfg(any(target_os = "macos", target_os = "linux"))]
use super::process::{
    ObservedProcessTree, ProcessSnapshot, desktop_process_tree, process_snapshots,
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

    #[cfg(not(target_os = "macos"))]
    let mut command = Command::new(&installation.desktop_executable);

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

    #[cfg(target_os = "linux")]
    let mut command = {
        let mut command = Command::new("xdg-open");
        command.arg(CODEXHOST_RELEASES_LATEST_URL);
        command
    };

    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = Command::new("explorer.exe");
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

    #[cfg(target_os = "linux")]
    let mut command = {
        if mode != DesktopLaunchMode::DirectExecutable {
            return Err(PlatformError::Unsupported(
                "LaunchServices is available on macOS only",
            ));
        }
        // The Desktop root must lead its own process group so the supervised
        // tree can be signalled without reaching the Launcher's own group.
        let mut command = Command::new(&installation.desktop_executable);
        command
            .args(additional_arguments)
            .envs(environment)
            .process_group(0);
        command
    };

    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    let mut command = {
        if mode != DesktopLaunchMode::DirectExecutable {
            return Err(PlatformError::Unsupported(
                "LaunchServices is available on macOS only",
            ));
        }
        let mut command = Command::new(&installation.desktop_executable);
        command.args(additional_arguments).envs(environment);
        command
    };

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

#[cfg(any(target_os = "macos", target_os = "linux"))]
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
        let roots = process_snapshots()?
            .into_iter()
            .filter(|process| process.executable == installation.desktop_executable)
            .collect::<Vec<_>>();
        match roots.as_slice() {
            [root] => {
                if mode == DesktopLaunchMode::DirectExecutable && root.process_group_id != root.id {
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

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use std::ffi::OsString;
    use std::fs;
    use std::io::{BufRead, BufReader};
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};
    use std::time::Duration;

    use super::{
        CODEXHOST_RELEASES_LATEST_URL, DesktopSession, desktop_launch_command,
        latest_release_command, remove_codexhost_environment,
    };
    use crate::process::{ObservedProcessTree, macos_process_snapshot};
    use crate::{
        DesktopIdentity, DesktopInstallation, DesktopLaunchMode, process_exists,
        temporary_directory,
    };

    #[test]
    fn launch_services_forwards_only_the_ephemeral_inspector_argument() {
        let directory = temporary_directory("codexhost-desktop-launch-args");
        let shim = directory.join("codexhost-shim");
        fs::write(&shim, b"shim").expect("write fake Shim");
        let installation = DesktopInstallation {
            identity: DesktopIdentity::MacOsBundle {
                bundle_identifier: "com.openai.codex".into(),
            },
            version: "1.0.0".into(),
            build: "100".into(),
            asar_integrity: format!("sha256:{}", "0".repeat(64)),
            install_root: "/Applications/ChatGPT.app".into(),
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
        assert_eq!(command.get_program(), "/usr/bin/open");
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
        let desktop_snapshot = macos_process_snapshot(desktop.id()).expect("snapshot Desktop root");
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
        let root_snapshot = macos_process_snapshot(root.id()).expect("snapshot ready fake root");
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
