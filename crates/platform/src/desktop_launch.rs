use std::ffi::OsString;
use std::path::Path;
use std::process::{Child, Command, Stdio};
#[cfg(target_os = "macos")]
use std::thread;
#[cfg(target_os = "macos")]
use std::time::{Duration, Instant};

#[cfg(target_os = "macos")]
use super::process::{
    ObservedProcessTree, ProcessSnapshot, desktop_process_tree, process_snapshots,
};
use super::{
    CODEX_CLI_PATH_ENV, DesktopInstallation, DesktopLaunchMode, PlatformError,
    STOCK_CODEX_PATH_ENV, canonical_existing_file,
};

fn desktop_launch_command(
    installation: &DesktopInstallation,
    shim_path: &Path,
    mode: DesktopLaunchMode,
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
            command
        }
        DesktopLaunchMode::DirectExecutable => {
            let mut command = Command::new(&installation.desktop_executable);
            command.envs(environment);
            command
        }
    };

    #[cfg(not(target_os = "macos"))]
    let mut command = {
        if mode != DesktopLaunchMode::DirectExecutable {
            return Err(PlatformError::Unsupported(
                "LaunchServices is available on macOS only",
            ));
        }
        let mut command = Command::new(&installation.desktop_executable);
        command.envs(environment);
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
    additional_environment: &[(OsString, OsString)],
) -> Result<Child, PlatformError> {
    desktop_launch_command(installation, shim_path, mode, additional_environment)?
        .spawn()
        .map_err(PlatformError::Io)
}

#[cfg(target_os = "macos")]
pub struct DesktopSession {
    launch_process: Child,
    tree: ObservedProcessTree,
    armed: bool,
}

#[cfg(target_os = "macos")]
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

#[cfg(target_os = "macos")]
impl Drop for DesktopSession {
    fn drop(&mut self) {
        if self.armed {
            let _ = self.force_terminate();
        }
    }
}

#[cfg(target_os = "macos")]
pub fn launch_desktop_session(
    installation: &DesktopInstallation,
    shim_path: &Path,
    mode: DesktopLaunchMode,
    additional_environment: &[(OsString, OsString)],
    start_timeout: Duration,
) -> Result<DesktopSession, PlatformError> {
    if !desktop_process_tree(installation)?.is_empty() {
        return Err(PlatformError::Invalid(
            "Codex Desktop is already running; refusing to reuse or terminate it".into(),
        ));
    }
    let mut launch_process =
        desktop_launch_command(installation, shim_path, mode, additional_environment)?.spawn()?;
    let started = Instant::now();
    loop {
        let roots = process_snapshots()?
            .into_iter()
            .filter(|process| process.executable == installation.desktop_executable)
            .collect::<Vec<_>>();
        match roots.as_slice() {
            [root] => {
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
                let _ = launch_process.kill();
                let _ = launch_process.wait();
                return Err(PlatformError::NotFound(
                    "Desktop launch did not create an identifiable App process before timeout"
                        .into(),
                ));
            }
            _ => {
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
    use std::io::{BufRead, BufReader};
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};
    use std::time::Duration;

    use super::DesktopSession;
    use crate::process::{ObservedProcessTree, macos_process_snapshot};
    use crate::process_exists;

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
