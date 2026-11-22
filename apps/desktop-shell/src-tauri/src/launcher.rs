use std::env;
use std::ffi::OsString;
use std::io::{self, BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, mpsc};
use std::thread;
use std::time::{Duration, Instant};

use serde::Deserialize;

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Options {
    pub onboarding: bool,
    pub data_dir: PathBuf,
}

impl Options {
    pub fn parse(
        args: impl IntoIterator<Item = OsString>,
        data_env: Option<OsString>,
        home: Option<OsString>,
    ) -> Result<Self, String> {
        let mut onboarding = false;
        let mut data_dir = None;
        let mut args = args.into_iter();
        while let Some(arg) = args.next() {
            match arg.to_str() {
                Some("--onboarding") if !onboarding => onboarding = true,
                Some("--data-dir") if data_dir.is_none() => {
                    let path = args.next().map(PathBuf::from);
                    data_dir = Some(
                        path.filter(|path| path.is_absolute())
                            .ok_or("--data-dir requires an absolute path")?,
                    );
                }
                _ => {
                    return Err(
                        "Usage: codexhost-shell [--onboarding] [--data-dir <absolute path>]".into(),
                    );
                }
            }
        }
        let data_dir = data_dir
            .or_else(|| {
                data_env
                    .map(PathBuf::from)
                    .filter(|path| path.is_absolute())
            })
            .or_else(|| {
                home.map(PathBuf::from)
                    .filter(|path| path.is_absolute())
                    .map(|path| path.join(".codexhost"))
            })
            .ok_or("Cannot locate the CodexHost data directory")?;
        Ok(Self {
            onboarding,
            data_dir,
        })
    }

    pub fn from_env() -> Result<Self, String> {
        Self::parse(
            env::args_os().skip(1),
            env::var_os("CODEXHOST_DATA_DIR"),
            env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }),
        )
    }
}

fn find_launcher(shell: &Path, override_path: Option<PathBuf>) -> Option<PathBuf> {
    let name = if cfg!(windows) {
        "codexhost.exe"
    } else {
        "codexhost"
    };
    let directory = shell.parent()?;
    std::iter::once(override_path)
        .flatten()
        .chain(std::iter::once(directory.join(name)))
        .chain(directory.ancestors().skip(1).take(2).flat_map(|parent| {
            [
                parent.join("bin").join(name),
                parent.join("MacOS").join(name),
            ]
        }))
        .find(|path| path.is_absolute() && path.is_file())
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum Surface {
    NativeShell,
    CodexDesktop,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LaunchPreferences {
    codex_desktop_installed: bool,
}

pub(crate) struct Launcher {
    executable: Option<PathBuf>,
    pub data_dir: PathBuf,
    command_lock: Mutex<()>,
    stopping: AtomicBool,
}

impl Launcher {
    pub fn new(shell: &Path, data_dir: PathBuf) -> Self {
        Self {
            executable: find_launcher(
                shell,
                env::var_os("CODEXHOST_LAUNCHER_EXECUTABLE").map(PathBuf::from),
            ),
            data_dir,
            command_lock: Mutex::new(()),
            stopping: AtomicBool::new(false),
        }
    }

    pub fn is_stopping(&self) -> bool {
        self.stopping.load(Ordering::Acquire)
    }

    pub fn begin_stop(&self) -> bool {
        !self.stopping.swap(true, Ordering::AcqRel)
    }

    fn command(&self, args: &[&str]) -> Result<Command, String> {
        if self.is_stopping() && args != ["stop"] {
            return Err("CodexHost is shutting down".into());
        }
        let executable = self.executable.as_ref().ok_or(
            "CodexHost launcher not found. Reinstall CodexHost or set CODEXHOST_LAUNCHER_EXECUTABLE.",
        )?;
        let mut command = Command::new(executable);
        command
            .args(args)
            .env("CODEXHOST_DATA_DIR", &self.data_dir)
            .stdin(Stdio::null())
            .stderr(Stdio::null());
        Ok(command)
    }

    fn check_exit(args: &[&str], status: ExitStatus) -> Result<(), String> {
        if status.success() {
            Ok(())
        } else {
            Err(format!(
                "`codexhost {}` failed ({status}). See CodexHost diagnostics for details.",
                args.join(" "),
            ))
        }
    }

    fn execute(&self, args: &[&str], read_stdout: bool) -> Result<Vec<u8>, String> {
        let mut command = self.command(args)?;
        command.stdout(if read_stdout {
            Stdio::piped()
        } else {
            Stdio::null()
        });
        codexhost_platform::configure_background_command(&mut command);
        let output = command
            .output()
            .map_err(|error| format!("Cannot run `codexhost {}`: {error}", args.join(" ")))?;
        Self::check_exit(args, output.status)?;
        Ok(output.stdout)
    }

    pub fn run(&self, args: &[&str]) -> Result<(), String> {
        let _guard = self.command_lock.lock().unwrap();
        self.execute(args, false).map(|_| ())
    }

    pub fn update(&self) -> Result<String, String> {
        let _guard = self.command_lock.lock().unwrap();
        self.execute(&["update"], true)
            .map(|output| String::from_utf8_lossy(&output).trim().to_owned())
    }

    pub fn codex_installed(&self) -> Result<bool, String> {
        let output = self.execute(&["launch-prefs", "get", "--json"], true)?;
        serde_json::from_slice::<LaunchPreferences>(&output)
            .map(|prefs| prefs.codex_desktop_installed)
            .map_err(|error| format!("Cannot read CodexHost launch preferences: {error}"))
    }

    pub fn open_codex(&self) -> Result<(), String> {
        if !self.codex_installed()? {
            return Err("Codex Desktop is not installed / 未安装官方 Codex Desktop".into());
        }
        self.launch_codex_desktop()
    }

    pub fn launch_codex_desktop(&self) -> Result<(), String> {
        let _guard = self.command_lock.lock().unwrap();
        let args = ["launch"];
        let mut command = self.command(&args)?;
        command.stdout(Stdio::piped());
        codexhost_platform::configure_detached_service_command(&mut command)
            .map_err(|error| format!("Cannot detach `codexhost launch`: {error}"))?;
        let mut child = command
            .spawn()
            .map_err(|error| format!("Cannot run `codexhost launch`: {error}"))?;
        let stdout = child.stdout.take().expect("piped launcher stdout");
        let (ready, signal) = mpsc::channel();
        thread::spawn(move || {
            let mut stdout = BufReader::new(stdout);
            let mut line = Vec::new();
            while matches!(stdout.read_until(b'\n', &mut line), Ok(n) if n > 0) {
                if matches!(line.as_slice(), b"ready\n" | b"ready\r\n") {
                    let _ = ready.send(());
                    // Keep the pipe open until the Launcher redirects its stdout.
                    let _ = io::copy(&mut stdout, &mut io::sink());
                    return;
                }
                line.clear();
            }
        });

        let deadline = Instant::now() + Duration::from_secs(60);
        let result = loop {
            if signal.try_recv().is_ok() {
                break Ok(());
            }
            match child.try_wait() {
                // Attaching to an existing Desktop can exit successfully without a ready line.
                Ok(Some(status)) => return Self::check_exit(&args, status),
                Ok(None) => (),
                Err(error) => break Err(format!("Cannot wait for `codexhost launch`: {error}")),
            }
            if Instant::now() >= deadline {
                break Err("Timed out waiting for Codex Desktop readiness. Startup may still be in progress; see CodexHost diagnostics.".into());
            }
            thread::sleep(Duration::from_millis(25));
        };
        // The Launcher owns Desktop supervision and cleanup, even after a timeout.
        thread::spawn(move || {
            let _ = child.wait();
        });
        result
    }

    pub fn set_surface(&self, surface: Surface) -> Result<(), String> {
        let surface = match surface {
            Surface::NativeShell => "native-shell",
            Surface::CodexDesktop => "codex-desktop",
        };
        self.run(&[
            "launch-prefs",
            "set",
            "--surface",
            surface,
            "--onboarding-completed",
            "true",
        ])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_startup_options_and_keeps_data_directory_precedence() {
        let root = tempfile::tempdir().unwrap();
        let cli = root.path().join("CLI data");
        let env = root.path().join("env");
        let home = root.path().join("home");
        let parse = |args: Vec<OsString>, data: Option<&Path>| {
            Options::parse(
                args,
                data.map(|path| path.as_os_str().to_owned()),
                Some(home.clone().into()),
            )
        };
        assert_eq!(
            parse(
                vec![
                    "--onboarding".into(),
                    "--data-dir".into(),
                    cli.clone().into()
                ],
                Some(&env)
            )
            .unwrap(),
            Options {
                onboarding: true,
                data_dir: cli
            }
        );
        assert_eq!(parse(vec![], Some(&env)).unwrap().data_dir, env);
        assert_eq!(
            parse(vec![], Some(Path::new("relative"))).unwrap().data_dir,
            home.join(".codexhost")
        );
        for args in [
            vec!["--data-dir"],
            vec!["--data-dir", "relative"],
            vec!["--onboarding", "--onboarding"],
            vec!["unexpected"],
        ] {
            assert!(parse(args.into_iter().map(OsString::from).collect(), None).is_err());
        }
    }

    #[cfg(unix)]
    #[test]
    fn desktop_readiness_releases_launcher_while_supervisor_is_running() {
        use std::fs;
        use std::os::unix::fs::PermissionsExt;

        let root = tempfile::tempdir().unwrap();
        let executable = root.path().join("codexhost");
        fs::write(
            &executable,
            r#"#!/bin/sh
case "$1" in
    launch-prefs) printf '%s\n' '{"codexDesktopInstalled":true}' ;;
    launch)
        printf 'ready\n'
        sleep 5
        : > "$CODEXHOST_DATA_DIR/supervisor-exited"
        ;;
    console) test ! -e "$CODEXHOST_DATA_DIR/supervisor-exited" ;;
    *) exit 1 ;;
esac
"#,
        )
        .unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
        let launcher = Launcher {
            executable: Some(executable),
            data_dir: root.path().to_owned(),
            command_lock: Mutex::new(()),
            stopping: AtomicBool::new(false),
        };
        launcher.open_codex().unwrap();
        launcher
            .run(&["console"])
            .expect("the next command must run before the Desktop supervisor exits");
    }

    #[test]
    fn finds_launcher_in_payload_and_mac_app_layouts() {
        let root = tempfile::tempdir().unwrap();
        let name = if cfg!(windows) {
            "codexhost.exe"
        } else {
            "codexhost"
        };
        for (shell, launcher) in [
            ("install/bin", "install/bin"),
            ("install/libexec", "install/bin"),
            (
                "bundle.app/Contents/Resources/libexec",
                "bundle.app/Contents/MacOS",
            ),
        ] {
            let directory = root.path().join(launcher);
            std::fs::create_dir_all(&directory).unwrap();
            let launcher = directory.join(name);
            std::fs::write(&launcher, "fixture").unwrap();
            let shell = root.path().join(shell).join("codexhost-shell");
            assert_eq!(
                find_launcher(&shell, Some(root.path().join("missing"))),
                Some(launcher)
            );
        }
    }
}
