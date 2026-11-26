use std::io;

use super::PlatformError;

/// Detach the current process from its controlling terminal so it can keep
/// supervising the Desktop after the invoking command returns.
///
/// On Unix the process becomes a new session leader without a controlling
/// terminal and redirects its standard streams to `/dev/null`, so terminal
/// close (SIGHUP) and Ctrl+C (SIGINT to the foreground process group) can no
/// longer reach it. On Windows the process ignores console control events
/// (Ctrl+C, break, and console close). The Launcher must call this only after
/// startup is complete, so Ctrl+C during startup still cancels the launch.
#[cfg(any(target_os = "macos", target_os = "linux"))]
pub fn detach_from_terminal() -> Result<(), PlatformError> {
    use nix::errno::Errno;
    use nix::unistd::{dup2_stderr, dup2_stdin, dup2_stdout, getpid, getsid, setsid};

    // A caller may already be its own process-group leader (PGID == PID)
    // without a controlling terminal. `setsid` refuses to
    // create a new session for a group leader with EPERM, but such a process is
    // already detached: terminal close (SIGHUP) and Ctrl+C cannot reach it, and
    // the stdio redirection below still applies. Tolerate that case so a
    // detached launch keeps supervising instead of tearing the Desktop down.
    let pid = getpid();
    let already_detached = getsid(None).map(|session| session == pid).unwrap_or(false);
    if !already_detached {
        match setsid() {
            Ok(_) => {}
            Err(Errno::EPERM) => {}
            Err(error) => {
                return Err(PlatformError::Io(io::Error::other(format!(
                    "setsid failed: {error}"
                ))));
            }
        }
    }
    let null = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open("/dev/null")?;
    dup2_stdin(&null).map_err(|error| {
        PlatformError::Io(io::Error::other(format!("redirect stdin failed: {error}")))
    })?;
    dup2_stdout(&null).map_err(|error| {
        PlatformError::Io(io::Error::other(format!("redirect stdout failed: {error}")))
    })?;
    dup2_stderr(&null).map_err(|error| {
        PlatformError::Io(io::Error::other(format!("redirect stderr failed: {error}")))
    })?;
    Ok(())
}

/// Start a child as the leader of a new session without a controlling terminal.
///
/// Like `process_group(0)`, the child becomes its own process-group leader
/// (PGID == PID), so group-based ownership and cleanup are unchanged. A new
/// process group alone is still a background job of the invoking terminal:
/// an interactive shell spawned inside it (for example to resolve the login
/// environment) opens `/dev/tty` and stops its whole group with SIGTTIN or
/// SIGTTOU. Without a controlling terminal, job control cannot suspend it.
#[cfg(any(target_os = "macos", target_os = "linux"))]
#[allow(unsafe_code)]
pub(crate) fn start_in_new_session(command: &mut std::process::Command) {
    use std::os::unix::process::CommandExt;

    // SAFETY: the hook runs in the child between fork and exec and only calls
    // setsid(2), which is async-signal-safe and does not allocate. A freshly
    // forked child is never a process-group leader, so setsid cannot fail
    // with EPERM here; any error aborts the spawn instead of leaving the child
    // attached to the terminal.
    unsafe {
        command.pre_exec(|| nix::unistd::setsid().map(|_| ()).map_err(io::Error::from));
    }
}

#[cfg(target_os = "windows")]
pub fn detach_from_terminal() -> Result<(), PlatformError> {
    use windows::Win32::System::Console::SetConsoleCtrlHandler;
    use windows::core::BOOL;

    unsafe extern "system" fn suppress_console_events(_event: u32) -> BOOL {
        true.into()
    }

    unsafe {
        SetConsoleCtrlHandler(Some(suppress_console_events), true).map_err(|error| {
            PlatformError::Io(io::Error::other(format!(
                "SetConsoleCtrlHandler failed: {error}"
            )))
        })?;
    }
    Ok(())
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
pub fn detach_from_terminal() -> Result<(), PlatformError> {
    Err(PlatformError::Unsupported(
        "background detachment currently supports Windows, macOS, and Linux only",
    ))
}

/// A shared service outlives the calling Desktop/Web process and its native job.
#[cfg(any(target_os = "macos", target_os = "linux"))]
pub fn configure_detached_service_command(
    command: &mut std::process::Command,
) -> Result<(), PlatformError> {
    start_in_new_session(command);
    Ok(())
}

/// Fallback when the caller's Windows job does not allow breakaway: the child
/// stays inside the caller's job instead of failing to start.
#[cfg(any(target_os = "macos", target_os = "linux"))]
pub fn configure_detached_service_command_compat(
    command: &mut std::process::Command,
) -> Result<(), PlatformError> {
    configure_detached_service_command(command)
}

#[cfg(target_os = "windows")]
pub fn configure_detached_service_command(
    command: &mut std::process::Command,
) -> Result<(), PlatformError> {
    configure_detached_service_command_impl(command, true)
}

#[cfg(target_os = "windows")]
pub fn configure_detached_service_command_compat(
    command: &mut std::process::Command,
) -> Result<(), PlatformError> {
    configure_detached_service_command_impl(command, false)
}

/// Spawn a detached service process from a command already configured by
/// [`configure_detached_service_command`]. On Windows a caller running inside
/// a job without `JOB_OBJECT_LIMIT_BREAKAWAY_OK` rejects
/// `CREATE_BREAKAWAY_FROM_JOB` with `ERROR_ACCESS_DENIED` (os error 5); that
/// error retries once with the compat configuration so the child stays inside
/// the caller's job instead of failing to start.
pub fn spawn_detached_service(
    command: &mut std::process::Command,
) -> std::io::Result<std::process::Child> {
    configure_detached_service_command(command)
        .map_err(|error| std::io::Error::other(error.to_string()))?;
    match command.spawn() {
        Err(error) if is_job_breakaway_denied(&error) => {
            configure_detached_service_command_compat(command)
                .map_err(|error| std::io::Error::other(error.to_string()))?;
            command.spawn()
        }
        result => result,
    }
}

// `ERROR_ACCESS_DENIED` only signals a rejected breakaway on Windows; on other
// platforms errno 5 is `EIO`, so the retry path stays Windows-only.
#[cfg(target_os = "windows")]
fn is_job_breakaway_denied(error: &std::io::Error) -> bool {
    error.raw_os_error() == Some(windows::Win32::Foundation::ERROR_ACCESS_DENIED.0 as i32)
}

#[cfg(not(target_os = "windows"))]
fn is_job_breakaway_denied(_error: &std::io::Error) -> bool {
    false
}

#[cfg(target_os = "windows")]
fn configure_detached_service_command_impl(
    command: &mut std::process::Command,
    breakaway_from_job: bool,
) -> Result<(), PlatformError> {
    use std::os::windows::process::CommandExt;
    use windows::Win32::Foundation::{HANDLE_FLAG_INHERIT, HANDLE_FLAGS, SetHandleInformation};
    use windows::Win32::System::Console::{
        GetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE,
    };
    use windows::Win32::System::Threading::{
        CREATE_BREAKAWAY_FROM_JOB, CREATE_NEW_PROCESS_GROUP, DETACHED_PROCESS,
    };
    // Null child stdio alone is insufficient: CreateProcess can also inherit the
    // caller's original stdio handles, keeping Node execFile capture pipes open
    // for the entire service lifetime. This native launch caller relinquishes
    // inheritance, not its own ability to read/write those handles. Command
    // prepares separate inheritable handles for explicitly configured child stdio.
    for standard in [STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE] {
        if let Ok(handle) = unsafe { GetStdHandle(standard) }
            && !handle.is_invalid()
        {
            unsafe { SetHandleInformation(handle, HANDLE_FLAG_INHERIT.0, HANDLE_FLAGS(0)) }
                .map_err(|error| PlatformError::Io(io::Error::other(error.to_string())))?;
        }
    }
    let mut flags = CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS;
    if breakaway_from_job {
        flags |= CREATE_BREAKAWAY_FROM_JOB;
    }
    command.creation_flags(flags.0);
    Ok(())
}

#[cfg(test)]
#[path = "background_service_tests.rs"]
mod service_tests;

#[cfg(all(test, any(target_os = "macos", target_os = "linux")))]
mod tests {
    use std::io;
    use std::process::Command;

    use super::detach_from_terminal;
    use crate::PlatformError;

    #[test]
    fn detach_creates_a_detached_session_and_discards_stdout() {
        const TEST_NAME: &str =
            "background::tests::detach_creates_a_detached_session_and_discards_stdout";
        if std::env::var("CODEXHOST_DETACH_HELPER").as_deref() == Ok("1") {
            let result = (|| -> Result<(), PlatformError> {
                detach_from_terminal()?;
                let pid = i32::try_from(std::process::id()).expect("PID fits i32");
                let session = nix::unistd::getsid(None).expect("read session id").as_raw();
                if pid != session {
                    return Err(PlatformError::Invalid(
                        "process is not its own session leader".into(),
                    ));
                }
                println!("must-not-appear-on-stdout");
                Ok(())
            })()
            .is_ok();
            std::process::exit(if result { 0 } else { 1 });
        }

        let output = Command::new(std::env::current_exe().expect("test executable"))
            .arg("--exact")
            .arg(TEST_NAME)
            .env("CODEXHOST_DETACH_HELPER", "1")
            .output()
            .expect("spawn detach helper");
        assert!(
            output.status.success(),
            "helper failed: {:?}",
            output.status
        );
        assert!(
            !String::from_utf8_lossy(&output.stdout).contains("must-not-appear-on-stdout"),
            "stdout was not redirected to /dev/null after detach"
        );
    }

    #[test]
    fn detach_tolerates_an_existing_process_group_leader() {
        // LaunchServices launches an application bundle as its own process-group
        // leader (PGID == PID) without a controlling terminal. `setsid` rejects a
        // group leader with EPERM; detach must tolerate that and still redirect
        // standard streams so a double-click launch keeps supervising.
        const TEST_NAME: &str =
            "background::tests::detach_tolerates_an_existing_process_group_leader";
        if std::env::var("CODEXHOST_DETACH_GROUP_LEADER_HELPER").as_deref() == Ok("1") {
            let result = (|| -> Result<(), PlatformError> {
                nix::unistd::setpgid(nix::unistd::Pid::from_raw(0), nix::unistd::Pid::from_raw(0))
                    .map_err(|error| {
                        PlatformError::Io(io::Error::other(format!("setpgid failed: {error}")))
                    })?;
                detach_from_terminal()?;
                println!("must-not-appear-on-stdout");
                Ok(())
            })()
            .is_ok();
            std::process::exit(if result { 0 } else { 1 });
        }

        let output = Command::new(std::env::current_exe().expect("test executable"))
            .arg("--exact")
            .arg(TEST_NAME)
            .env("CODEXHOST_DETACH_GROUP_LEADER_HELPER", "1")
            .output()
            .expect("spawn group leader helper");
        assert!(
            output.status.success(),
            "helper failed: {:?}",
            output.status
        );
        assert!(
            !String::from_utf8_lossy(&output.stdout).contains("must-not-appear-on-stdout"),
            "stdout was not redirected to /dev/null for a group leader"
        );
    }
}
