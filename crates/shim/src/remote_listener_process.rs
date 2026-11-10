use std::process::{Child, Command};

use crate::ShimResult;

enum Process {
    Background(Child),
    #[cfg(target_os = "macos")]
    Desktop(codexhost_platform::ProcessSnapshot),
}

/// Own startup until the listener is ready; failed starts must not leave a daemon.
pub(super) struct RemoteListenerProcess {
    process: Process,
    ready: bool,
}

impl RemoteListenerProcess {
    pub fn spawn(command: &mut Command) -> ShimResult<Self> {
        let session = std::env::var("CODEXHOST_REMOTE_EXECUTION_SESSION")
            .unwrap_or_else(|_| "ssh".to_owned());
        let process =
            match session.as_str() {
                "ssh" => Process::Background(command.spawn()?),
                #[cfg(target_os = "macos")]
                "desktop" => {
                    // launchd supplies the security context; the SSH caller still owns
                    // the complete environment, working directory and runtime selection.
                    let inherited = std::env::vars_os().collect::<Vec<_>>();
                    let overrides = command
                        .get_envs()
                        .map(|(key, value)| (key.to_owned(), value.map(ToOwned::to_owned)))
                        .collect::<Vec<_>>();
                    command
                        .env_clear()
                        .envs(inherited)
                        .current_dir(std::env::current_dir()?);
                    for (key, value) in overrides {
                        if let Some(value) = value {
                            command.env(key, value);
                        } else {
                            command.env_remove(key);
                        }
                    }
                    Process::Desktop(codexhost_platform::spawn_in_desktop_session(command)?)
                }
                _ => return Err(format!(
                    "unsupported remote execution session '{session}'; desktop mode requires macOS"
                )
                .into()),
            };
        Ok(Self {
            process,
            ready: false,
        })
    }

    pub fn try_wait(&mut self) -> ShimResult<Option<String>> {
        match &mut self.process {
            Process::Background(child) => Ok(child.try_wait()?.map(|status| status.to_string())),
            #[cfg(target_os = "macos")]
            Process::Desktop(expected) => match codexhost_platform::process_snapshot(expected.id) {
                Ok(current) if current.started_at_micros == expected.started_at_micros => Ok(None),
                Ok(_) | Err(codexhost_platform::PlatformError::NotFound(_)) => {
                    Ok(Some("desktop listener exited".to_owned()))
                }
                Err(error) => Err(error.into()),
            },
        }
    }

    pub fn detach(&mut self) {
        self.ready = true;
    }
}

impl Drop for RemoteListenerProcess {
    fn drop(&mut self) {
        if self.ready {
            return;
        }
        match &mut self.process {
            Process::Background(child) => {
                if matches!(child.try_wait(), Ok(None)) {
                    super::stop_detached_listener(child);
                }
            }
            #[cfg(target_os = "macos")]
            Process::Desktop(expected) => {
                let _ = codexhost_platform::terminate_process_instance(expected, false);
                // Outlast the supervisor's two-second descendant termination grace.
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
                while std::time::Instant::now() < deadline {
                    if codexhost_platform::process_snapshot(expected.id).is_err() {
                        return;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(20));
                }
                let _ = codexhost_platform::terminate_process_instance(expected, true);
            }
        }
    }
}
