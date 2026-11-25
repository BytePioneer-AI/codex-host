use std::env;
use std::ffi::OsString;
use std::io::{self, BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::thread;
use std::time::{Duration, Instant};

use serde::Deserialize;

const MAX_CAPTURED_STDERR_BYTES: usize = 16 * 1024;
const STDERR_DRAIN_GRACE: Duration = Duration::from_millis(250);

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Options {
    pub onboarding: bool,
    pub route: Option<String>,
    pub data_dir: PathBuf,
    /// True when the data directory came from `--data-dir` or an absolute
    /// `CODEXHOST_DATA_DIR`, rather than being derived from the home directory.
    pub explicit_data_dir: bool,
}

impl Options {
    pub fn parse(
        args: impl IntoIterator<Item = OsString>,
        data_env: Option<OsString>,
        home: Option<OsString>,
    ) -> Result<Self, String> {
        let mut onboarding = false;
        let mut route = None;
        let mut data_dir = None;
        let mut args = args.into_iter();
        while let Some(arg) = args.next() {
            match arg.to_str() {
                Some("--onboarding") if !onboarding => onboarding = true,
                Some("--route") if route.is_none() => {
                    route = Some(
                        args.next()
                            .and_then(|value| value.into_string().ok())
                            .filter(|value| crate::navigation::valid_host_route(value))
                            .ok_or("--route requires a root-relative route")?,
                    );
                }
                Some("--data-dir") if data_dir.is_none() => {
                    let path = args.next().map(PathBuf::from);
                    data_dir = Some(
                        path.filter(|path| path.is_absolute())
                            .ok_or("--data-dir requires an absolute path")?,
                    );
                }
                _ => {
                    return Err(
                        "Usage: codexhost-shell [--onboarding] [--data-dir <absolute path>] [--route <relative route>]".into(),
                    );
                }
            }
        }
        if onboarding && route.is_some() {
            return Err("--route cannot be combined with --onboarding".into());
        }
        let explicit_data_dir = data_dir.is_some()
            || data_env
                .as_deref()
                .is_some_and(|value| Path::new(value).is_absolute());
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
            route,
            data_dir,
            explicit_data_dir,
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

fn is_same_executable(candidate: &Path, shell: &Path) -> bool {
    if candidate == shell {
        return true;
    }
    if let (Ok(left), Ok(right)) = (
        std::fs::canonicalize(candidate),
        std::fs::canonicalize(shell),
    ) {
        return left == right;
    }
    cfg!(any(target_os = "macos", windows))
        && candidate.parent() == shell.parent()
        && candidate
            .file_name()
            .zip(shell.file_name())
            .is_some_and(|(left, right)| left.eq_ignore_ascii_case(right))
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
        .chain(directory.ancestors().skip(1).take(4).flat_map(|parent| {
            [
                parent.join("bin").join(name),
                parent.join("MacOS").join(name),
            ]
        }))
        .find(|path| path.is_absolute() && path.is_file() && !is_same_executable(path, shell))
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum Surface {
    NativeShell,
    CodexDesktop,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LaunchPreferences {
    default_desktop_surface: Option<Surface>,
    onboarding_completed: bool,
    #[serde(default)]
    pub remember_default: bool,
    pub codex_desktop_installed: bool,
    desktop_shell_available: bool,
}

impl LaunchPreferences {
    pub fn remembered_surface(&self) -> Option<Surface> {
        self.default_desktop_surface.filter(|surface| {
            self.remember_default
                && match surface {
                    Surface::NativeShell => self.desktop_shell_available,
                    Surface::CodexDesktop => self.codex_desktop_installed,
                }
        })
    }
}

pub(crate) struct Launcher {
    executable: Option<PathBuf>,
    pub data_dir: PathBuf,
    /// Whether `data_dir` was explicitly configured; when false the launcher must
    /// not inject `CODEXHOST_DATA_DIR` so the shim uses the implicit default
    /// directory, matching a plain `codexhost launch`.
    explicit_data_dir: bool,
    command_lock: Mutex<()>,
    stopping: AtomicBool,
}

impl Launcher {
    pub fn new(shell: &Path, data_dir: PathBuf, explicit_data_dir: bool) -> Self {
        Self {
            executable: find_launcher(
                shell,
                env::var_os("CODEXHOST_LAUNCHER_EXECUTABLE").map(PathBuf::from),
            ),
            data_dir,
            explicit_data_dir,
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
        command.args(args);
        if self.explicit_data_dir {
            command.env("CODEXHOST_DATA_DIR", &self.data_dir);
        }
        command.stdin(Stdio::null()).stderr(Stdio::null());
        Ok(command)
    }

    fn redact_query_tokens(line: &str) -> String {
        let mut out = String::with_capacity(line.len());
        let mut rest = line;
        while let Some(pos) = rest.find("token=") {
            out.push_str(&rest[..pos + 6]);
            let after = &rest[pos + 6..];
            let end = after
                .find(|c: char| c.is_whitespace() || matches!(c, '&' | '#' | '"' | '\'' | ')'))
                .unwrap_or(after.len());
            out.push_str("[redacted]");
            rest = &after[end..];
        }
        out.push_str(rest);
        out
    }

    fn is_secondary_console_error(line: &str) -> bool {
        matches!(
            line,
            "codexhost launcher: codexhost console could not be started"
                | "codexhost launcher: codexhost console returned no address"
        )
    }

    fn summarize_stderr(stderr: &[u8]) -> Option<String> {
        let text = String::from_utf8_lossy(stderr);
        let candidates = text.lines().map(str::trim).filter(|line| {
            !line.is_empty()
                && !line.starts_with("(node:")
                && !line.starts_with("(Use `node --trace-warnings")
                && !line.starts_with("codexhost console:")
                && !line.starts_with("codexhost web:")
        });
        let mut last = None;
        let mut last_primary = None;
        for line in candidates {
            last = Some(line);
            if !Self::is_secondary_console_error(line) {
                last_primary = Some(line);
            }
        }
        let line = last_primary.or(last)?;
        let cleaned = line
            .strip_prefix("codexhost launcher:")
            .or_else(|| line.strip_prefix("codexhost:"))
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(line);
        let redacted = Self::redact_query_tokens(cleaned);
        let mut bounded: String = redacted.chars().take(240).collect();
        if redacted.chars().count() > 240 {
            bounded.push('…');
        }
        Some(bounded)
    }

    fn check_exit_with_stderr(
        args: &[&str],
        status: ExitStatus,
        stderr: &[u8],
    ) -> Result<(), String> {
        if status.success() {
            Ok(())
        } else if let Some(detail) = Self::summarize_stderr(stderr) {
            Err(detail)
        } else {
            Err(format!(
                "`codexhost {}` failed ({status}). See CodexHost diagnostics for details.",
                args.join(" "),
            ))
        }
    }

    fn execute(&self, args: &[&str], read_stdout: bool) -> Result<Vec<u8>, String> {
        let mut command = self.command(args)?;
        command
            .stdout(if read_stdout {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stderr(Stdio::piped());
        codexhost_platform::configure_background_command(&mut command);
        let output = command
            .output()
            .map_err(|error| format!("Cannot run `codexhost {}`: {error}", args.join(" ")))?;
        Self::check_exit_with_stderr(args, output.status, &output.stderr)?;
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

    pub fn launch_preferences(&self) -> Result<LaunchPreferences, String> {
        let output = self.execute(&["launch-prefs", "get", "--json"], true)?;
        serde_json::from_slice(&output)
            .map_err(|error| format!("Cannot read CodexHost launch preferences: {error}"))
    }

    pub fn open_codex(&self) -> Result<(), String> {
        if !self.launch_preferences()?.codex_desktop_installed {
            return Err("Codex Desktop is not installed / 未安装官方 Codex Desktop".into());
        }
        self.launch_codex_desktop()
    }

    pub fn launch_codex_desktop(&self) -> Result<(), String> {
        let _guard = self.command_lock.lock().unwrap();
        let args = ["launch"];
        let mut command = self.command(&args)?;
        command.stdout(Stdio::piped()).stderr(Stdio::piped());
        codexhost_platform::configure_detached_service_command(&mut command)
            .map_err(|error| format!("Cannot detach `codexhost launch`: {error}"))?;
        let mut child = command
            .spawn()
            .map_err(|error| format!("Cannot run `codexhost launch`: {error}"))?;
        let stdout = child.stdout.take().expect("piped launcher stdout");
        let mut stderr = child.stderr.take().expect("piped launcher stderr");
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
        let capture_stderr = Arc::new(AtomicBool::new(true));
        let stderr_buffer = Arc::new(Mutex::new(Vec::new()));
        let (stderr_done, stderr_finished) = mpsc::channel();
        {
            let capture_stderr = Arc::clone(&capture_stderr);
            let stderr_buffer = Arc::clone(&stderr_buffer);
            thread::spawn(move || {
                let mut chunk = [0_u8; 4096];
                while let Ok(read) = stderr.read(&mut chunk) {
                    if read == 0 {
                        break;
                    }
                    if !capture_stderr.load(Ordering::Acquire) {
                        // Drain detached supervisor stderr so Windows pipes never block.
                        let _ = io::copy(&mut stderr, &mut io::sink());
                        break;
                    }
                    let mut buffer = stderr_buffer.lock().unwrap();
                    let overflow = (buffer.len() + read).saturating_sub(MAX_CAPTURED_STDERR_BYTES);
                    if overflow > 0 {
                        buffer.drain(..overflow);
                    }
                    buffer.extend_from_slice(&chunk[..read]);
                }
                let _ = stderr_done.send(());
            });
        }

        // Match the Launcher's Windows startup budget (AppX activation,
        // Controller startup, 90s Host chain wait, and at most one AppX retry).
        let deadline = Instant::now() + Duration::from_secs(150);
        let result = loop {
            if signal.try_recv().is_ok() {
                capture_stderr.store(false, Ordering::Release);
                break Ok(());
            }
            match child.try_wait() {
                // Attaching to an existing Desktop can exit successfully without a ready line.
                Ok(Some(status)) => {
                    if !status.success() {
                        let _ = stderr_finished.recv_timeout(STDERR_DRAIN_GRACE);
                    }
                    capture_stderr.store(false, Ordering::Release);
                    let captured = stderr_buffer.lock().unwrap().clone();
                    return Self::check_exit_with_stderr(&args, status, &captured);
                }
                Ok(None) => (),
                Err(error) => {
                    capture_stderr.store(false, Ordering::Release);
                    break Err(format!("Cannot wait for `codexhost launch`: {error}"));
                }
            }
            if Instant::now() >= deadline {
                capture_stderr.store(false, Ordering::Release);
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

    pub fn set_surface(&self, surface: Surface, remember_default: bool) -> Result<(), String> {
        let _guard = self.command_lock.lock().unwrap();
        self.write_launch_preferences(surface, true, remember_default)
    }

    pub fn ask_every_time(&self) -> Result<(), String> {
        let _guard = self.command_lock.lock().unwrap();
        let prefs = self.launch_preferences()?;
        self.write_launch_preferences(
            prefs
                .default_desktop_surface
                .unwrap_or(Surface::NativeShell),
            prefs.onboarding_completed,
            false,
        )
    }

    fn write_launch_preferences(
        &self,
        surface: Surface,
        onboarding_completed: bool,
        remember_default: bool,
    ) -> Result<(), String> {
        let surface = match surface {
            Surface::NativeShell => "native-shell",
            Surface::CodexDesktop => "codex-desktop",
        };
        self.execute(
            &[
                "launch-prefs",
                "set",
                "--surface",
                surface,
                "--onboarding-completed",
                if onboarding_completed {
                    "true"
                } else {
                    "false"
                },
                "--remember-default",
                if remember_default { "true" } else { "false" },
            ],
            false,
        )
        .map(|_| ())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn injects_data_directory_only_when_explicit() {
        let root = tempfile::tempdir().unwrap();
        let launcher = Launcher {
            executable: Some(root.path().join("codexhost")),
            data_dir: root.path().to_owned(),
            explicit_data_dir: false,
            command_lock: Mutex::new(()),
            stopping: AtomicBool::new(false),
        };
        let command = launcher.command(&["console"]).unwrap();
        assert!(
            command
                .get_envs()
                .all(|(key, _)| key != std::ffi::OsStr::new("CODEXHOST_DATA_DIR"))
        );
        let launcher = Launcher {
            explicit_data_dir: true,
            ..launcher
        };
        let command = launcher.command(&["console"]).unwrap();
        assert!(
            command
                .get_envs()
                .any(|(key, _)| key == std::ffi::OsStr::new("CODEXHOST_DATA_DIR"))
        );
    }

    #[test]
    fn legacy_launch_choice_is_not_remembered() {
        let preferences: LaunchPreferences = serde_json::from_value(serde_json::json!({
            "defaultDesktopSurface": "native-shell",
            "onboardingCompleted": true,
            "codexDesktopInstalled": true,
            "desktopShellAvailable": true,
        }))
        .unwrap();
        assert!(!preferences.remember_default);
        assert_eq!(preferences.remembered_surface(), None);
        assert_eq!(
            preferences.default_desktop_surface,
            Some(Surface::NativeShell)
        );
    }

    #[test]
    fn remembered_available_choices_do_not_require_completed_onboarding() {
        let mut prefs: LaunchPreferences = serde_json::from_value(serde_json::json!({
            "defaultDesktopSurface": "codex-desktop",
            "onboardingCompleted": false,
            "rememberDefault": true,
            "codexDesktopInstalled": true,
            "desktopShellAvailable": true,
        }))
        .unwrap();
        assert_eq!(prefs.remembered_surface(), Some(Surface::CodexDesktop));

        prefs.codex_desktop_installed = false;
        assert_eq!(prefs.remembered_surface(), None);
        prefs.default_desktop_surface = Some(Surface::NativeShell);
        assert_eq!(prefs.remembered_surface(), Some(Surface::NativeShell));

        prefs.desktop_shell_available = false;
        assert_eq!(prefs.remembered_surface(), None);
        prefs.desktop_shell_available = true;
        prefs.remember_default = false;
        assert_eq!(prefs.remembered_surface(), None);
    }

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
                route: None,
                data_dir: cli,
                explicit_data_dir: true,
            }
        );
        assert_eq!(parse(vec![], Some(&env)).unwrap().data_dir, env);
        let default = parse(vec![], Some(Path::new("relative"))).unwrap();
        assert_eq!(default.data_dir, home.join(".codexhost"));
        assert!(!default.explicit_data_dir);
        assert!(!parse(vec![], None).unwrap().explicit_data_dir);
        assert!(parse(vec![], Some(&env)).unwrap().explicit_data_dir);
        assert_eq!(
            parse(
                vec!["--route".into(), "/?session=thread-1".into()],
                Some(&env),
            )
            .unwrap()
            .route,
            Some("/?session=thread-1".into())
        );
        for args in [
            vec!["--data-dir"],
            vec!["--data-dir", "relative"],
            vec!["--onboarding", "--onboarding"],
            vec!["--onboarding", "--route", "/?session=thread-1"],
            vec!["--route", "/settings"],
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
    launch-prefs)
        printf '%s\n' '{"defaultDesktopSurface":null,"onboardingCompleted":false,"rememberDefault":false,"codexDesktopInstalled":true,"desktopShellAvailable":true}'
        ;;
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
            explicit_data_dir: true,
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
            ("install/bin/codexhost-shell", "install/bin"),
            ("install/libexec/codexhost-shell", "install/bin"),
            (
                "install/libexec/CodexHost.app/Contents/MacOS/CodexHost",
                "install/bin",
            ),
            (
                "bundle.app/Contents/Resources/libexec/codexhost-shell",
                "bundle.app/Contents/MacOS",
            ),
            (
                "bundle.app/Contents/Helpers/CodexHost.app/Contents/MacOS/CodexHost",
                "bundle.app/Contents/MacOS",
            ),
        ] {
            let directory = root.path().join(launcher);
            std::fs::create_dir_all(&directory).unwrap();
            let launcher = directory.join(name);
            std::fs::write(&launcher, "fixture").unwrap();
            let shell = root.path().join(shell);
            std::fs::create_dir_all(shell.parent().unwrap()).unwrap();
            std::fs::write(&shell, "shell-fixture").unwrap();
            assert_eq!(
                find_launcher(&shell, Some(root.path().join("missing"))),
                Some(launcher)
            );
            std::fs::remove_file(&shell).unwrap();
        }
    }

    #[cfg(unix)]
    #[test]
    fn launch_codex_desktop_surfaces_stderr_on_failure() {
        use std::fs;
        use std::os::unix::fs::PermissionsExt;

        let root = tempfile::tempdir().unwrap();
        let executable = root.path().join("codexhost");
        fs::write(
            &executable,
            r#"#!/bin/sh
echo "codexhost launcher: cannot activate Codex Desktop AppX package: Access is denied." >&2
echo "" >&2
echo "codexhost console: http://127.0.0.1:49435/?token=secret" >&2
echo "codexhost web: http://127.0.0.1:49433/?token=secret" >&2
exit 1
"#,
        )
        .unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
        let launcher = Launcher {
            executable: Some(executable),
            data_dir: root.path().to_owned(),
            explicit_data_dir: true,
            command_lock: Mutex::new(()),
            stopping: AtomicBool::new(false),
        };
        assert_eq!(
            launcher.launch_codex_desktop().unwrap_err(),
            "cannot activate Codex Desktop AppX package: Access is denied."
        );
    }

    #[test]
    fn summarizes_launcher_stderr_without_node_warnings_or_tokens() {
        let stderr = b"(node:123) [UNDICI-EHPA] Warning: EnvHttpProxyAgent is experimental\n(Use `node --trace-warnings ...` to show where the warning was created)\ncodexhost launcher: Web port 4400 is in use; see http://127.0.0.1:4400/?token=secret123&x=1\n";
        assert_eq!(
            Launcher::summarize_stderr(stderr).as_deref(),
            Some("Web port 4400 is in use; see http://127.0.0.1:4400/?token=[redacted]&x=1")
        );
        let with_post_failure_console = b"codexhost launcher: cannot install the temporary AppX environment\ncodexhost launcher: codexhost console could not be started\ncodexhost console: http://127.0.0.1:49435/?token=secret\ncodexhost web: http://127.0.0.1:49433/?token=secret\n";
        assert_eq!(
            Launcher::summarize_stderr(with_post_failure_console).as_deref(),
            Some("cannot install the temporary AppX environment")
        );
        assert_eq!(
            Launcher::summarize_stderr(
                b"codexhost launcher: codexhost console could not be started\n"
            )
            .as_deref(),
            Some("codexhost console could not be started")
        );
        assert_eq!(
            Launcher::summarize_stderr(
                b"(node:1) Warning\n(Use `node --trace-warnings ...`)\n  \n"
            ),
            None
        );
    }
}
