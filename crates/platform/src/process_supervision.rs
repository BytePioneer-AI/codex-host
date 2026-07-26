use std::io;
use std::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, ExitStatus};

use super::PlatformError;
#[cfg(target_os = "macos")]
use super::process::{ObservedProcessTree, macos_process_snapshot};
#[cfg(target_os = "windows")]
use super::windows_process;

#[cfg(target_os = "windows")]
pub struct ChildProcessGuard {
    job: windows_process::ChildJob,
}

#[cfg(target_os = "macos")]
pub struct ChildProcessGuard {
    tree: std::sync::Mutex<ObservedProcessTree>,
    armed: bool,
}

#[cfg(target_os = "macos")]
impl ChildProcessGuard {
    fn with_tree<T>(
        &self,
        operation: impl FnOnce(&mut ObservedProcessTree) -> Result<T, PlatformError>,
    ) -> Result<T, PlatformError> {
        let mut tree = self.tree.lock().map_err(|_| {
            PlatformError::Invalid("supervised process identity lock was poisoned".into())
        })?;
        operation(&mut tree)
    }

    fn has_live_members(&self) -> Result<bool, PlatformError> {
        self.with_tree(|tree| Ok(!tree.observe()?.is_empty()))
    }

    fn process_group_id(&self) -> Result<u32, PlatformError> {
        self.with_tree(|tree| Ok(tree.root.process_group_id))
    }

    fn signal(&self, signal: nix::sys::signal::Signal) -> Result<(), PlatformError> {
        use nix::errno::Errno;
        use nix::sys::signal::{kill, killpg};
        use nix::unistd::Pid;

        self.with_tree(|tree| {
            let root_group = tree.root.process_group_id;
            let owned = tree.observe()?;
            if owned.is_empty() {
                return Ok(());
            }
            let process_group = i32::try_from(root_group).map_err(|_| {
                PlatformError::Invalid(format!("process group {root_group} exceeds i32::MAX"))
            })?;
            if owned
                .iter()
                .any(|process| process.process_group_id == root_group)
                && let Err(error) = killpg(Pid::from_raw(process_group), signal)
                && error != Errno::ESRCH
            {
                return Err(PlatformError::Io(io::Error::from_raw_os_error(
                    error as i32,
                )));
            }
            let escaped = owned
                .into_iter()
                .filter(|process| process.process_group_id != root_group)
                .collect::<Vec<_>>();
            for process in escaped {
                let process_id = i32::try_from(process.id).map_err(|_| {
                    PlatformError::Invalid(format!("PID {} exceeds i32::MAX", process.id))
                })?;
                if let Err(error) = kill(Pid::from_raw(process_id), signal)
                    && error != Errno::ESRCH
                {
                    return Err(PlatformError::Io(io::Error::from_raw_os_error(
                        error as i32,
                    )));
                }
            }
            Ok(())
        })
    }
}

#[cfg(target_os = "macos")]
impl Drop for ChildProcessGuard {
    fn drop(&mut self) {
        if self.armed {
            let _ = self.signal(nix::sys::signal::Signal::SIGKILL);
        }
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub struct ChildProcessGuard;

pub struct SupervisedChild {
    child: Child,
    guard: Option<ChildProcessGuard>,
}

impl SupervisedChild {
    #[must_use]
    pub fn id(&self) -> u32 {
        self.child.id()
    }

    pub fn take_stdin(&mut self) -> Option<ChildStdin> {
        self.child.stdin.take()
    }

    pub fn take_stdout(&mut self) -> Option<ChildStdout> {
        self.child.stdout.take()
    }

    pub fn take_stderr(&mut self) -> Option<ChildStderr> {
        self.child.stderr.take()
    }

    pub fn wait(&mut self) -> io::Result<ExitStatus> {
        self.child.wait()
    }

    pub fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        self.child.try_wait()
    }

    pub fn terminate(&mut self) -> Result<(), PlatformError> {
        #[cfg(target_os = "windows")]
        if let Some(guard) = &self.guard {
            return guard.job.terminate(1).map_err(PlatformError::Io);
        }
        #[cfg(target_os = "macos")]
        if let Some(guard) = &self.guard {
            return guard.signal(nix::sys::signal::Signal::SIGTERM);
        }
        self.child.kill().map_err(PlatformError::Io)
    }

    pub fn force_terminate(&mut self) -> Result<(), PlatformError> {
        #[cfg(target_os = "windows")]
        if let Some(guard) = &self.guard {
            return guard.job.terminate(1).map_err(PlatformError::Io);
        }
        #[cfg(target_os = "macos")]
        if let Some(guard) = &self.guard {
            return guard.signal(nix::sys::signal::Signal::SIGKILL);
        }
        self.child.kill().map_err(PlatformError::Io)
    }

    #[cfg(target_os = "macos")]
    pub fn forward_signal(&self, signal: i32) -> Result<(), PlatformError> {
        let signal = nix::sys::signal::Signal::try_from(signal)
            .map_err(|_| PlatformError::Invalid(format!("unsupported Unix signal {signal}")))?;
        self.guard
            .as_ref()
            .ok_or_else(|| PlatformError::Invalid("supervised child has no process group".into()))?
            .signal(signal)
    }

    pub fn disarm_cleanup(&mut self) {
        #[cfg(target_os = "macos")]
        if let Some(guard) = &mut self.guard {
            guard.armed = false;
        }
    }

    #[cfg(target_os = "macos")]
    pub fn has_live_processes(&self) -> Result<bool, PlatformError> {
        self.guard
            .as_ref()
            .map_or(Ok(false), ChildProcessGuard::has_live_members)
    }

    #[cfg(target_os = "macos")]
    #[must_use]
    pub fn process_group_id(&self) -> u32 {
        self.guard
            .as_ref()
            .and_then(|guard| guard.process_group_id().ok())
            .unwrap_or_else(|| self.id())
    }
}

#[cfg(target_os = "windows")]
pub fn spawn_supervised(command: &mut Command) -> Result<SupervisedChild, PlatformError> {
    let mut child = command.spawn()?;
    let guard = match windows_process::guard_child(&child) {
        Ok(job) => Some(ChildProcessGuard { job }),
        Err(_) if child.try_wait()?.is_some() => None,
        Err(error) => return Err(PlatformError::Io(error)),
    };
    Ok(SupervisedChild { child, guard })
}

#[cfg(target_os = "macos")]
pub fn spawn_supervised(command: &mut Command) -> Result<SupervisedChild, PlatformError> {
    use std::os::unix::process::CommandExt;

    command.process_group(0);
    let mut child = command.spawn()?;
    let root = match macos_process_snapshot(child.id()) {
        Ok(root) => root,
        Err(_) if child.try_wait()?.is_some() => {
            return Ok(SupervisedChild { child, guard: None });
        }
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
    };
    if root.process_group_id != root.id {
        let _ = child.kill();
        let _ = child.wait();
        return Err(PlatformError::Invalid(format!(
            "spawned PID {} did not become process-group leader",
            root.id
        )));
    }
    Ok(SupervisedChild {
        child,
        guard: Some(ChildProcessGuard {
            tree: std::sync::Mutex::new(ObservedProcessTree::new(root)),
            armed: true,
        }),
    })
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub fn spawn_supervised(_command: &mut Command) -> Result<SupervisedChild, PlatformError> {
    Err(PlatformError::Unsupported(
        "supervised child processes currently support Windows and macOS only",
    ))
}
