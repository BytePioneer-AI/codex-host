use std::ffi::OsString;

/// Returns the child-process `PATH` on macOS, resolving the user's login shell
/// `PATH` once per process when the current process inherited only launchd's
/// minimal GUI `PATH`.
///
/// On non-macOS platforms, returns `None` so callers keep standard inheritance.
/// On macOS, a non-minimal `PATH` (such as a terminal launch) is returned
/// directly without spawning a shell.
#[cfg(target_os = "macos")]
pub fn user_shell_path() -> Option<OsString> {
    macos::user_shell_path()
}

#[cfg(not(target_os = "macos"))]
pub fn user_shell_path() -> Option<OsString> {
    None
}

#[cfg(target_os = "macos")]
mod macos {
    use std::collections::HashSet;
    use std::env;
    use std::ffi::{OsStr, OsString};
    use std::fs;
    use std::io::{self, Read};
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::PermissionsExt;
    use std::path::{Component, Path, PathBuf};
    use std::process::{Child, Command, Stdio};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, OnceLock};
    use std::thread;
    use std::time::{Duration, Instant};

    use nix::sys::signal::{Signal, killpg};
    use nix::unistd::Pid;

    const MINIMAL_LAUNCHD_PATHS: [&str; 4] = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
    const SUPPORTED_SHELLS: [&str; 3] = ["zsh", "bash", "fish"];
    const DEFAULT_SHELL: &str = "/bin/zsh";
    const PATH_MARKER: &[u8] = b"\0CODEXHOST_LOGIN_PATH_V1\0";
    const POSIX_PATH_COMMAND: &str = "printf '\\0CODEXHOST_LOGIN_PATH_V1\\0%s\\0' \"$PATH\"";
    const FISH_PATH_COMMAND: &str =
        "printf '\\0CODEXHOST_LOGIN_PATH_V1\\0%s\\0' (string join ':' $PATH)";
    const INTERACTIVE_PROBE_TIMEOUT: Duration = Duration::from_millis(2_500);
    const LOGIN_PROBE_TIMEOUT: Duration = Duration::from_millis(500);
    const MAX_PROBE_STDOUT_BYTES: usize = 256 * 1024;
    const POLL_INTERVAL: Duration = Duration::from_millis(10);

    pub(super) fn user_shell_path() -> Option<OsString> {
        let current = env::var_os("PATH");
        if !is_minimal_macos_launchd_path(current.as_deref()) {
            return current;
        }
        static RESOLVED: OnceLock<Option<OsString>> = OnceLock::new();
        RESOLVED
            .get_or_init(|| {
                resolve_user_shell_path(
                    current.as_deref(),
                    env::var_os("HOME").as_deref(),
                    env::var_os("SHELL").as_deref(),
                    INTERACTIVE_PROBE_TIMEOUT,
                    LOGIN_PROBE_TIMEOUT,
                )
            })
            .clone()
    }

    fn normalize_posix_path(path: &Path) -> Option<PathBuf> {
        if !path.is_absolute() {
            return None;
        }
        let mut normalized = PathBuf::new();
        for component in path.components() {
            match component {
                Component::RootDir => normalized.push(component.as_os_str()),
                Component::CurDir => {}
                Component::ParentDir => {
                    normalized.pop();
                }
                Component::Normal(segment) => normalized.push(segment),
                Component::Prefix(_) => return None,
            }
        }
        Some(normalized)
    }

    pub(super) fn is_minimal_macos_launchd_path(path: Option<&OsStr>) -> bool {
        let Some(value) = path else {
            return true;
        };
        for entry in env::split_paths(value) {
            if entry.as_os_str().is_empty() {
                continue;
            }
            let Some(normalized) = normalize_posix_path(&entry) else {
                return false;
            };
            if !normalized
                .to_str()
                .is_some_and(|text| MINIMAL_LAUNCHD_PATHS.contains(&text))
            {
                return false;
            }
        }
        true
    }

    fn is_cua_node_bin(normalized: &Path) -> bool {
        let segments = normalized
            .components()
            .filter_map(|component| match component {
                Component::Normal(segment) => segment.to_str(),
                _ => None,
            })
            .collect::<Vec<_>>();
        let Some(tail) = segments
            .len()
            .checked_sub(4)
            .map(|start| &segments[start..])
        else {
            return false;
        };
        tail[0].eq_ignore_ascii_case("Contents")
            && tail[1].eq_ignore_ascii_case("Resources")
            && tail[2].eq_ignore_ascii_case("cua_node")
            && tail[3].eq_ignore_ascii_case("bin")
    }

    fn is_executable_file(path: &Path) -> bool {
        fs::metadata(path).is_ok_and(|metadata| {
            metadata.is_file() && (metadata.permissions().mode() & 0o111 != 0)
        })
    }

    pub(super) fn resolve_shell(shell_env: Option<&OsStr>) -> PathBuf {
        if let Some(raw) = shell_env {
            let trimmed = raw
                .to_str()
                .map(|text| OsStr::new(text.trim()))
                .unwrap_or(raw);
            let candidate = Path::new(trimmed);
            let supported = candidate
                .file_name()
                .and_then(OsStr::to_str)
                .is_some_and(|name| SUPPORTED_SHELLS.contains(&name));
            if candidate.is_absolute() && supported && is_executable_file(candidate) {
                return candidate.to_path_buf();
            }
        }
        PathBuf::from(DEFAULT_SHELL)
    }

    pub(super) fn shell_probe_arguments(shell: &Path, interactive: bool) -> [&'static str; 2] {
        let flag = if interactive { "-ilc" } else { "-lc" };
        let command = if shell.file_name().and_then(OsStr::to_str) == Some("fish") {
            FISH_PATH_COMMAND
        } else {
            POSIX_PATH_COMMAND
        };
        [flag, command]
    }

    pub(super) fn parse_probe_stdout(stdout: &[u8]) -> Option<OsString> {
        let start = stdout
            .windows(PATH_MARKER.len())
            .rposition(|window| window == PATH_MARKER)?;
        let value = &stdout[start + PATH_MARKER.len()..];
        let end = value.iter().position(|&byte| byte == 0)?;
        Some(OsStr::from_bytes(&value[..end]).to_os_string())
    }

    fn read_bounded_stdout(
        mut reader: impl Read,
        limit: usize,
        overflowed: Arc<AtomicBool>,
    ) -> Option<Vec<u8>> {
        let mut output = Vec::new();
        let mut chunk = [0_u8; 4096];
        loop {
            match reader.read(&mut chunk) {
                Ok(0) => return Some(output),
                Ok(count) => {
                    if output.len().saturating_add(count) > limit {
                        overflowed.store(true, Ordering::Relaxed);
                        return None;
                    }
                    output.extend_from_slice(&chunk[..count]);
                }
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(_) => return None,
            }
        }
    }

    fn kill_process_group(child: &mut Child) {
        if let Ok(pid) = i32::try_from(child.id()) {
            let _ = killpg(Pid::from_raw(pid), Signal::SIGKILL);
        }
        let _ = child.kill();
    }

    pub(super) fn probe_shell_once(
        shell: &Path,
        home: &OsStr,
        current_path: Option<&OsStr>,
        interactive: bool,
        timeout: Duration,
    ) -> Option<OsString> {
        let mut command = Command::new(shell);
        command
            .args(shell_probe_arguments(shell, interactive))
            .env("HOME", home)
            .env("SHELL", shell)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        if let Some(path) = current_path {
            command.env("PATH", path);
        }
        crate::background::start_in_new_session(&mut command);

        let mut child = command.spawn().ok()?;
        let stdout = child.stdout.take()?;
        let overflowed = Arc::new(AtomicBool::new(false));
        let reader_overflow = Arc::clone(&overflowed);
        let reader = thread::spawn(move || {
            read_bounded_stdout(stdout, MAX_PROBE_STDOUT_BYTES, reader_overflow)
        });

        let deadline = Instant::now() + timeout;
        loop {
            if overflowed.load(Ordering::Relaxed) {
                kill_process_group(&mut child);
                let _ = child.wait();
                let _ = reader.join();
                return None;
            }
            match child.try_wait() {
                Ok(Some(status)) => {
                    let bytes = reader.join().ok().flatten()?;
                    return status
                        .success()
                        .then(|| parse_probe_stdout(&bytes))
                        .flatten();
                }
                Ok(None) => {
                    let now = Instant::now();
                    if now >= deadline {
                        kill_process_group(&mut child);
                        let _ = child.wait();
                        let _ = reader.join();
                        return None;
                    }
                    thread::sleep(POLL_INTERVAL.min(deadline.saturating_duration_since(now)));
                }
                Err(_) => {
                    kill_process_group(&mut child);
                    let _ = child.wait();
                    let _ = reader.join();
                    return None;
                }
            }
        }
    }

    pub(super) fn merge_macos_login_shell_path(
        host_path: Option<&OsStr>,
        shell_path: &OsStr,
    ) -> Option<OsString> {
        let mut seen = HashSet::new();
        let mut normal = Vec::new();
        let mut cua_node = Vec::new();

        let mut collect = |source: Option<&OsStr>| {
            let Some(value) = source else {
                return;
            };
            for entry in env::split_paths(value) {
                if entry.as_os_str().is_empty() {
                    continue;
                }
                let Some(normalized) = normalize_posix_path(&entry) else {
                    continue;
                };
                if !seen.insert(normalized.clone()) {
                    continue;
                }
                if is_cua_node_bin(&normalized) {
                    cua_node.push(entry);
                } else {
                    normal.push(entry);
                }
            }
        };

        if is_minimal_macos_launchd_path(host_path) {
            collect(Some(shell_path));
            collect(host_path);
        } else {
            collect(host_path);
            collect(Some(shell_path));
        }
        normal.extend(cua_node);
        if normal.is_empty() {
            return host_path.map(OsStr::to_os_string);
        }
        env::join_paths(normal)
            .ok()
            .or_else(|| host_path.map(OsStr::to_os_string))
    }

    pub(super) fn resolve_user_shell_path(
        current_path: Option<&OsStr>,
        home: Option<&OsStr>,
        shell_env: Option<&OsStr>,
        interactive_timeout: Duration,
        login_timeout: Duration,
    ) -> Option<OsString> {
        if !is_minimal_macos_launchd_path(current_path) {
            return current_path.map(OsStr::to_os_string);
        }
        let Some(home) = home.filter(|value| !value.is_empty() && Path::new(value).is_absolute())
        else {
            return current_path.map(OsStr::to_os_string);
        };
        let shell = resolve_shell(shell_env);
        let probed = probe_shell_once(&shell, home, current_path, true, interactive_timeout)
            .or_else(|| probe_shell_once(&shell, home, current_path, false, login_timeout));
        match probed {
            Some(shell_path) => merge_macos_login_shell_path(current_path, &shell_path),
            None => current_path.map(OsStr::to_os_string),
        }
    }

    #[cfg(test)]
    mod tests {
        use std::ffi::{OsStr, OsString};
        use std::fs;
        use std::os::unix::fs::PermissionsExt;
        use std::path::{Path, PathBuf};
        use std::time::{Duration, Instant};

        use super::{
            DEFAULT_SHELL, FISH_PATH_COMMAND, POSIX_PATH_COMMAND, is_minimal_macos_launchd_path,
            merge_macos_login_shell_path, parse_probe_stdout, probe_shell_once, resolve_shell,
            resolve_user_shell_path, shell_probe_arguments,
        };
        use crate::temporary_directory;

        fn write_fake_shell(directory: &Path, name: &str, script: &str) -> PathBuf {
            let path = directory.join(name);
            fs::write(&path, format!("#!/bin/sh\n{script}\n")).expect("write fake shell");
            let mut permissions = fs::metadata(&path).expect("metadata").permissions();
            permissions.set_mode(0o755);
            fs::set_permissions(&path, permissions).expect("chmod fake shell");
            path
        }

        #[test]
        fn detects_minimal_launchd_paths_and_skips_terminal_paths() {
            assert!(is_minimal_macos_launchd_path(None));
            assert!(is_minimal_macos_launchd_path(Some(OsStr::new(""))));
            assert!(is_minimal_macos_launchd_path(Some(OsStr::new(
                "/usr/bin:/bin:/usr/sbin:/sbin"
            ))));
            assert!(is_minimal_macos_launchd_path(Some(OsStr::new(
                "/usr/bin/:/bin::/sbin"
            ))));
            assert!(!is_minimal_macos_launchd_path(Some(OsStr::new(
                "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
            ))));
            assert!(!is_minimal_macos_launchd_path(Some(OsStr::new(
                "/Users/example/.local/bin:/usr/bin:/bin"
            ))));
        }

        #[test]
        fn merges_minimal_path_with_login_shell_primary_order_and_sinks_cua_node() {
            let merged = merge_macos_login_shell_path(
                Some(OsStr::new("/usr/bin:/bin:/usr/sbin:/sbin")),
                OsStr::new(
                    ":relative/bin:/Applications/Codex.app/Contents/Resources/cua_node/bin:/opt/homebrew/bin:/Users/example/.local/bin:/usr/bin/:/opt/homebrew/bin",
                ),
            )
            .expect("merged path");
            assert_eq!(
                merged,
                OsString::from(
                    "/opt/homebrew/bin:/Users/example/.local/bin:/usr/bin/:/bin:/usr/sbin:/sbin:/Applications/Codex.app/Contents/Resources/cua_node/bin"
                )
            );
        }

        #[test]
        fn merges_non_minimal_path_preserving_host_order_while_sinking_cua_node() {
            let merged = merge_macos_login_shell_path(
                Some(OsStr::new(
                    "/Applications/Codex.app/Contents/Resources/cua_node/bin:/custom/bin:/usr/bin",
                )),
                OsStr::new("/opt/homebrew/bin:/usr/bin"),
            )
            .expect("merged path");
            assert_eq!(
                merged,
                OsString::from(
                    "/custom/bin:/usr/bin:/opt/homebrew/bin:/Applications/Codex.app/Contents/Resources/cua_node/bin"
                )
            );
        }

        #[test]
        fn validates_shell_whitelist_and_falls_back_to_default_zsh() {
            let root = temporary_directory("codexhost-shell-whitelist");
            let valid_zsh = write_fake_shell(&root, "zsh", "exit 0");
            let unsupported = write_fake_shell(&root, "tcsh", "exit 0");
            let non_executable = root.join("bash");
            fs::write(&non_executable, "#!/bin/sh\nexit 0\n").expect("write non-executable");

            assert_eq!(resolve_shell(Some(valid_zsh.as_os_str())), valid_zsh);
            assert_eq!(
                resolve_shell(Some(unsupported.as_os_str())),
                PathBuf::from(DEFAULT_SHELL)
            );
            assert_eq!(
                resolve_shell(Some(non_executable.as_os_str())),
                PathBuf::from(DEFAULT_SHELL)
            );
            assert_eq!(
                resolve_shell(Some(OsStr::new("zsh"))),
                PathBuf::from(DEFAULT_SHELL)
            );
            assert_eq!(resolve_shell(None), PathBuf::from(DEFAULT_SHELL));

            fs::remove_dir_all(root).expect("cleanup");
        }

        #[test]
        fn formats_probe_arguments_for_posix_and_fish_shells() {
            assert_eq!(
                shell_probe_arguments(Path::new("/bin/zsh"), true),
                ["-ilc", POSIX_PATH_COMMAND]
            );
            assert_eq!(
                shell_probe_arguments(Path::new("/bin/bash"), false),
                ["-lc", POSIX_PATH_COMMAND]
            );
            assert_eq!(
                shell_probe_arguments(Path::new("/opt/homebrew/bin/fish"), true),
                ["-ilc", FISH_PATH_COMMAND]
            );
        }

        #[test]
        fn extracts_path_after_last_nul_sentinel_ignoring_banner_noise() {
            let output = b"welcome banner\n\0CODEXHOST_LOGIN_PATH_V1\0/stale/bin\0noise\0CODEXHOST_LOGIN_PATH_V1\0/opt/homebrew/bin:/usr/bin\0trailing";
            assert_eq!(
                parse_probe_stdout(output),
                Some(OsString::from("/opt/homebrew/bin:/usr/bin"))
            );
            assert_eq!(
                parse_probe_stdout(b"\0CODEXHOST_LOGIN_PATH_V1\0/unterminated"),
                None
            );
            assert_eq!(parse_probe_stdout(b"plain output"), None);
        }

        #[test]
        fn probes_noisy_shell_and_falls_back_from_hanging_interactive_to_login_shell() {
            let root = temporary_directory("codexhost-shell-fallback");
            let pid_file = root.join("child.pid");
            let shell = write_fake_shell(
                &root,
                "zsh",
                &format!(
                    r#"
if [ "$1" = "-ilc" ]; then
  /bin/sleep 30 &
  echo $! > "{pid_file}"
  wait
  exit 0
fi
printf 'noisy profile banner\n'
printf '\0CODEXHOST_LOGIN_PATH_V1\0/opt/homebrew/bin:/Users/example/.local/bin:/usr/bin\0'
"#,
                    pid_file = pid_file.display()
                ),
            );

            let started = Instant::now();
            let resolved = resolve_user_shell_path(
                Some(OsStr::new("/usr/bin:/bin:/usr/sbin:/sbin")),
                Some(root.as_os_str()),
                Some(shell.as_os_str()),
                Duration::from_millis(200),
                Duration::from_secs(2),
            );
            assert!(
                started.elapsed() < Duration::from_secs(5),
                "fallback must complete promptly after interactive timeout"
            );
            assert_eq!(
                resolved,
                Some(OsString::from(
                    "/opt/homebrew/bin:/Users/example/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
                ))
            );

            if let Ok(raw_pid) = fs::read_to_string(&pid_file)
                && let Ok(pid) = raw_pid.trim().parse::<u32>()
            {
                let deadline = Instant::now() + Duration::from_secs(2);
                while crate::process_exists(pid) && Instant::now() < deadline {
                    std::thread::sleep(Duration::from_millis(20));
                }
                assert!(
                    !crate::process_exists(pid),
                    "timed-out interactive probe descendant must be killed with process group"
                );
            }

            fs::remove_dir_all(root).expect("cleanup");
        }

        #[test]
        fn degrades_to_original_path_when_both_probes_fail_or_overflow() {
            let root = temporary_directory("codexhost-shell-overflow");
            let noisy = write_fake_shell(
                &root,
                "zsh",
                "dd if=/dev/zero bs=4096 count=80 2>/dev/null | tr '\\0' 'a'",
            );

            assert_eq!(
                probe_shell_once(
                    &noisy,
                    root.as_os_str(),
                    Some(OsStr::new("/usr/bin:/bin")),
                    true,
                    Duration::from_secs(2),
                ),
                None
            );
            assert_eq!(
                resolve_user_shell_path(
                    Some(OsStr::new("/usr/bin:/bin:/usr/sbin:/sbin")),
                    Some(root.as_os_str()),
                    Some(noisy.as_os_str()),
                    Duration::from_millis(500),
                    Duration::from_millis(500),
                ),
                Some(OsString::from("/usr/bin:/bin:/usr/sbin:/sbin"))
            );

            fs::remove_dir_all(root).expect("cleanup");
        }
    }
}
