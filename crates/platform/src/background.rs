use std::io;

use super::PlatformError;

/// Detach the current process from its controlling terminal so it can keep
/// supervising the Desktop after the invoking command returns.
///
/// On macOS the process becomes a new session leader without a controlling
/// terminal and redirects its standard streams to `/dev/null`, so terminal
/// close (SIGHUP) and Ctrl+C (SIGINT to the foreground process group) can no
/// longer reach it. On Windows the process ignores console control events
/// (Ctrl+C, break, and console close). The Launcher must call this only after
/// startup is complete, so Ctrl+C during startup still cancels the launch.
#[cfg(target_os = "macos")]
pub fn detach_from_terminal() -> Result<(), PlatformError> {
    use nix::unistd::{dup2_stderr, dup2_stdin, dup2_stdout, setsid};

    setsid()
        .map_err(|error| PlatformError::Io(io::Error::other(format!("setsid failed: {error}"))))?;
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

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn detach_from_terminal() -> Result<(), PlatformError> {
    Ok(())
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
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
}
