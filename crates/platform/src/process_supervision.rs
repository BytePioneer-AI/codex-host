use std::io;
#[cfg(any(target_os = "macos", target_os = "linux"))]
use std::io::Read;
#[cfg(any(target_os = "macos", target_os = "linux"))]
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, ExitStatus};
#[cfg(any(target_os = "macos", target_os = "linux"))]
use std::time::{Duration, Instant};

use super::PlatformError;
#[cfg(any(target_os = "macos", target_os = "linux"))]
use super::process::{ObservedProcessTree, ProcessSnapshot, unix_process_snapshot};
#[cfg(target_os = "windows")]
use super::windows_process;

#[cfg(target_os = "windows")]
pub struct ChildProcessGuard {
    job: windows_process::ChildJob,
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
pub struct ChildProcessGuard {
    tree: std::sync::Mutex<ObservedProcessTree>,
    armed: bool,
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
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
        self.with_tree(|tree| Ok(tree.process_group_id()))
    }

    fn signal(&self, signal: nix::sys::signal::Signal) -> Result<(), PlatformError> {
        #[cfg(target_os = "macos")]
        use nix::errno::Errno;
        #[cfg(target_os = "macos")]
        use nix::sys::signal::killpg;
        #[cfg(target_os = "macos")]
        use nix::unistd::Pid;

        self.with_tree(|tree| {
            let root_group = tree.process_group_id();
            let owned = tree.observe()?;
            if owned.is_empty() {
                return Ok(());
            }
            #[cfg(target_os = "macos")]
            let process_group = i32::try_from(root_group).map_err(|_| {
                PlatformError::Invalid(format!("process group {root_group} exceeds i32::MAX"))
            })?;
            let group_members = owned
                .iter()
                .filter(|process| process.process_group_id == root_group)
                .cloned()
                .collect::<Vec<_>>();
            if !group_members.is_empty() {
                #[cfg(target_os = "linux")]
                tree.signal_processes(&group_members, signal)?;
                #[cfg(target_os = "macos")]
                if let Err(error) = killpg(Pid::from_raw(process_group), signal)
                    && error != Errno::ESRCH
                {
                    return Err(PlatformError::Io(io::Error::from_raw_os_error(
                        error as i32,
                    )));
                }
            }
            let escaped = owned
                .into_iter()
                .filter(|process| process.process_group_id != root_group)
                .collect::<Vec<_>>();
            tree.signal_processes(&escaped, signal)?;
            Ok(())
        })
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
impl Drop for ChildProcessGuard {
    fn drop(&mut self) {
        if self.armed {
            let _ = self.signal(nix::sys::signal::Signal::SIGKILL);
        }
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
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
        #[cfg(any(target_os = "macos", target_os = "linux"))]
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
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        if let Some(guard) = &self.guard {
            return guard.signal(nix::sys::signal::Signal::SIGKILL);
        }
        self.child.kill().map_err(PlatformError::Io)
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    pub fn forward_signal(&self, signal: i32) -> Result<(), PlatformError> {
        let signal = nix::sys::signal::Signal::try_from(signal)
            .map_err(|_| PlatformError::Invalid(format!("unsupported Unix signal {signal}")))?;
        self.guard
            .as_ref()
            .ok_or_else(|| PlatformError::Invalid("supervised child has no process group".into()))?
            .signal(signal)
    }

    pub fn disarm_cleanup(&mut self) {
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        if let Some(guard) = &mut self.guard {
            guard.armed = false;
        }
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    pub fn has_live_processes(&self) -> Result<bool, PlatformError> {
        self.guard
            .as_ref()
            .map_or(Ok(false), ChildProcessGuard::has_live_members)
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
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

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn spawned_root_snapshot(
    child: &mut Child,
    expected_executable: Option<&Path>,
) -> Result<Option<ProcessSnapshot>, PlatformError> {
    const EXEC_IDENTITY_TIMEOUT: Duration = Duration::from_secs(1);
    let started = Instant::now();
    let mut process_instance = None;
    loop {
        match unix_process_snapshot(child.id()) {
            Ok(snapshot) => {
                if let Some((process_id, started_at_micros)) = process_instance {
                    if snapshot.id != process_id || snapshot.started_at_micros != started_at_micros
                    {
                        return Err(PlatformError::Invalid(format!(
                            "spawned PID {} was reused before supervision",
                            child.id()
                        )));
                    }
                } else {
                    process_instance = Some((snapshot.id, snapshot.started_at_micros));
                }
                let Some(expected_executable) = expected_executable else {
                    return Ok(Some(snapshot));
                };
                if snapshot.executable == expected_executable {
                    return Ok(Some(snapshot));
                }
                if started.elapsed() >= EXEC_IDENTITY_TIMEOUT {
                    return Err(PlatformError::Invalid(format!(
                        "spawned PID {} did not exec expected executable {} (observed {})",
                        child.id(),
                        expected_executable.display(),
                        snapshot.executable.display()
                    )));
                }
            }
            Err(error) => {
                if child.try_wait()?.is_some() {
                    return Ok(None);
                }
                if started.elapsed() >= EXEC_IDENTITY_TIMEOUT {
                    return Err(error);
                }
            }
        }
        if child.try_wait()?.is_some() {
            return Ok(None);
        }
        std::thread::sleep(Duration::from_millis(1));
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn expected_executable(command: &Command) -> Option<PathBuf> {
    let executable = std::fs::canonicalize(command.get_program()).ok()?;
    let mut file = std::fs::File::open(&executable).ok()?;
    let mut prefix = [0_u8; 2];

    // A Unix shebang script is launched through its interpreter. The process
    // identity therefore becomes the interpreter (for example `node`), not
    // the script path passed to Command::new (for example `codex.js`).
    if file.read_exact(&mut prefix).is_ok() && prefix == *b"#!" {
        None
    } else {
        Some(executable)
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
pub fn spawn_supervised(command: &mut Command) -> Result<SupervisedChild, PlatformError> {
    use std::os::unix::process::CommandExt;

    let expected_executable = expected_executable(command);
    command.process_group(0);
    let mut child = command.spawn()?;
    let root = match spawned_root_snapshot(&mut child, expected_executable.as_deref()) {
        Ok(Some(root)) => root,
        Ok(None) => return Ok(SupervisedChild { child, guard: None }),
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
            tree: std::sync::Mutex::new(ObservedProcessTree::new_following_root_exec(root)),
            armed: true,
        }),
    })
}

#[cfg(all(test, any(target_os = "macos", target_os = "linux")))]
mod tests {
    use super::{spawn_supervised, unix_process_snapshot};
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::process::Command;
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

    #[test]
    fn tracks_a_shebang_root_across_an_exec_transition() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock is before the Unix epoch")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "codexhost-process-supervision-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir(&directory).expect("create temporary directory");
        let script = directory.join("codex.js");
        let exec_ready = directory.join("exec-ready");
        fs::write(
            &script,
            "#!/bin/sh\nwhile [ ! -e \"$CODEXHOST_EXEC_READY\" ]; do /bin/sleep 0.01; done\nexec /bin/sleep 30\n",
        )
        .expect("write shebang script");
        let mut permissions = fs::metadata(&script)
            .expect("stat shebang script")
            .permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(&script, permissions).expect("make shebang script executable");

        let mut command = Command::new(&script);
        command.env("CODEXHOST_EXEC_READY", &exec_ready);
        let mut child =
            spawn_supervised(&mut command).expect("supervise an interpreter-backed executable");
        fs::write(&exec_ready, b"ready").expect("release the shebang exec transition");
        let expected_executable = fs::canonicalize("/bin/sleep").expect("resolve /bin/sleep");
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let snapshot = unix_process_snapshot(child.id()).expect("observe shebang root process");
            if snapshot.executable == expected_executable {
                break;
            }
            if Instant::now() >= deadline {
                let _ = child.force_terminate();
                let _ = child.wait();
                let _ = fs::remove_dir_all(&directory);
                panic!(
                    "shebang root did not exec {} (observed {})",
                    expected_executable.display(),
                    snapshot.executable.display()
                );
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        child
            .force_terminate()
            .expect("terminate supervised script");
        child.wait().expect("wait for supervised script");
        fs::remove_dir_all(directory).expect("remove temporary directory");
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
pub fn spawn_supervised(_command: &mut Command) -> Result<SupervisedChild, PlatformError> {
    Err(PlatformError::Unsupported(
        "supervised child processes currently support Windows, macOS, and Linux only",
    ))
}
