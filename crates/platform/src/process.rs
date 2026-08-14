use std::path::{Path, PathBuf};
#[cfg(any(target_os = "macos", target_os = "linux"))]
use std::thread;
#[cfg(any(target_os = "macos", target_os = "linux"))]
use std::time::{Duration, Instant};

use super::PlatformError;
#[cfg(any(target_os = "macos", target_os = "linux"))]
use super::{DesktopInstallation, discover_codex_desktop};
#[cfg(target_os = "windows")]
use super::{node_entrypoint_path, windows_process};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessSnapshot {
    pub id: u32,
    pub parent_id: u32,
    pub process_group_id: u32,
    pub executable: PathBuf,
    pub started_at_micros: u64,
}

#[cfg(target_os = "macos")]
pub(crate) fn macos_process_snapshot(process_id: u32) -> Result<ProcessSnapshot, PlatformError> {
    use libproc::libproc::bsd_info::BSDInfo;
    use libproc::libproc::proc_pid::{pidinfo, pidpath};

    let native_id = i32::try_from(process_id)
        .map_err(|_| PlatformError::Invalid(format!("PID {process_id} exceeds i32::MAX")))?;
    let info = pidinfo::<BSDInfo>(native_id, 0).map_err(|error| {
        PlatformError::NotFound(format!("cannot inspect PID {process_id}: {error}"))
    })?;
    let executable = PathBuf::from(pidpath(native_id).map_err(|error| {
        PlatformError::NotFound(format!(
            "cannot resolve PID {process_id} executable: {error}"
        ))
    })?);
    Ok(ProcessSnapshot {
        id: info.pbi_pid,
        parent_id: info.pbi_ppid,
        process_group_id: info.pbi_pgid,
        executable,
        started_at_micros: info
            .pbi_start_tvsec
            .saturating_mul(1_000_000)
            .saturating_add(info.pbi_start_tvusec),
    })
}

#[cfg(target_os = "macos")]
pub fn process_snapshot(process_id: u32) -> Result<ProcessSnapshot, PlatformError> {
    macos_process_snapshot(process_id)
}

#[cfg(target_os = "linux")]
pub fn process_snapshot(process_id: u32) -> Result<ProcessSnapshot, PlatformError> {
    super::linux_process::linux_process_snapshot(process_id)
}

#[cfg(target_os = "macos")]
pub fn process_snapshots() -> Result<Vec<ProcessSnapshot>, PlatformError> {
    use libproc::processes::{ProcFilter, pids_by_type};

    Ok(pids_by_type(ProcFilter::All)?
        .into_iter()
        .filter_map(|process_id| macos_process_snapshot(process_id).ok())
        .collect())
}

#[cfg(target_os = "linux")]
pub fn process_snapshots() -> Result<Vec<ProcessSnapshot>, PlatformError> {
    super::linux_process::linux_process_snapshots()
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn same_process_instance(expected: &ProcessSnapshot, current: &ProcessSnapshot) -> bool {
    expected.id == current.id && expected.started_at_micros == current.started_at_micros
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn same_process_identity(expected: &ProcessSnapshot, current: &ProcessSnapshot) -> bool {
    same_process_instance(expected, current) && expected.executable == current.executable
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn descendant_snapshots(roots: &[u32], snapshots: &[ProcessSnapshot]) -> Vec<ProcessSnapshot> {
    let mut owned_ids = roots.to_vec();
    let mut descendants = Vec::new();
    loop {
        let mut changed = false;
        for snapshot in snapshots {
            if !owned_ids.contains(&snapshot.id) && owned_ids.contains(&snapshot.parent_id) {
                owned_ids.push(snapshot.id);
                descendants.push(snapshot.clone());
                changed = true;
            }
        }
        if !changed {
            return descendants;
        }
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn desktop_process_tree_from_snapshots(
    desktop_executable: &Path,
    snapshots: &[ProcessSnapshot],
) -> Vec<ProcessSnapshot> {
    let roots = snapshots
        .iter()
        .filter(|process| process.executable == desktop_executable)
        .cloned()
        .collect::<Vec<_>>();
    let root_ids = roots.iter().map(|process| process.id).collect::<Vec<_>>();
    let mut tree = roots;
    tree.extend(descendant_snapshots(&root_ids, snapshots));
    tree.sort_by_key(|process| process.id);
    tree
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
pub fn desktop_process_tree(
    installation: &DesktopInstallation,
) -> Result<Vec<ProcessSnapshot>, PlatformError> {
    Ok(desktop_process_tree_from_snapshots(
        &installation.desktop_executable,
        &process_snapshots()?,
    ))
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
pub(crate) struct ObservedProcessTree {
    pub(crate) root: ProcessSnapshot,
    known: Vec<ProcessSnapshot>,
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
impl ObservedProcessTree {
    pub(crate) fn new(root: ProcessSnapshot) -> Self {
        Self {
            known: vec![root.clone()],
            root,
        }
    }

    pub(crate) fn observe(&mut self) -> Result<Vec<ProcessSnapshot>, PlatformError> {
        let snapshots = process_snapshots()?;
        for expected in &mut self.known {
            if let Some(current) = snapshots.iter().find(|process| process.id == expected.id) {
                if !same_process_instance(expected, current) {
                    return Err(PlatformError::Invalid(format!(
                        "PID {} was reused while observing the process tree",
                        expected.id
                    )));
                }
                if expected.id == self.root.id && current.executable != self.root.executable {
                    return Err(PlatformError::Invalid(format!(
                        "Desktop root PID {} changed executable identity",
                        expected.id
                    )));
                }
                *expected = current.clone();
            }
        }
        let known_ids = self
            .known
            .iter()
            .map(|process| process.id)
            .collect::<Vec<_>>();
        let mut observed = if self.root.process_group_id == self.root.id {
            snapshots
                .iter()
                .filter(|process| {
                    process.started_at_micros >= self.root.started_at_micros
                        && process.process_group_id == self.root.process_group_id
                })
                .cloned()
                .collect::<Vec<_>>()
        } else {
            Vec::new()
        };
        observed.extend(descendant_snapshots(&known_ids, &snapshots));
        for process in observed {
            if !self.known.iter().any(|known| known.id == process.id) {
                self.known.push(process);
            }
        }
        Ok(self
            .known
            .iter()
            .filter_map(|expected| {
                snapshots
                    .iter()
                    .find(|current| same_process_instance(expected, current))
                    .cloned()
            })
            .collect())
    }

    pub(crate) fn root_is_live(&mut self) -> Result<bool, PlatformError> {
        Ok(self
            .observe()?
            .iter()
            .any(|process| process.id == self.root.id))
    }

    pub(crate) fn escaped(&mut self) -> Result<Vec<ProcessSnapshot>, PlatformError> {
        let live = self.observe()?;
        let descendants = descendant_snapshots(&[self.root.id], &live);
        Ok(live
            .into_iter()
            .filter(|process| {
                process.id != self.root.id
                    && !descendants
                        .iter()
                        .any(|descendant| descendant.id == process.id)
            })
            .collect())
    }

    pub(crate) fn signal_processes(
        &self,
        processes: &[ProcessSnapshot],
        signal: nix::sys::signal::Signal,
    ) -> Result<(), PlatformError> {
        use nix::errno::Errno;
        use nix::sys::signal::kill;
        use nix::unistd::Pid;

        for expected in processes {
            let current = match process_snapshot(expected.id) {
                Ok(current) => current,
                Err(PlatformError::NotFound(_)) => continue,
                Err(error) => return Err(error),
            };
            if !same_process_identity(expected, &current) {
                return Err(PlatformError::Invalid(format!(
                    "PID {} identity changed before signal delivery",
                    expected.id
                )));
            }
            let process_id = i32::try_from(expected.id).map_err(|_| {
                PlatformError::Invalid(format!("PID {} exceeds i32::MAX", expected.id))
            })?;
            if let Err(error) = kill(Pid::from_raw(process_id), signal)
                && error != Errno::ESRCH
            {
                return Err(PlatformError::Io(std::io::Error::from_raw_os_error(
                    error as i32,
                )));
            }
        }
        Ok(())
    }

    pub(crate) fn signal_exact(
        &mut self,
        signal: nix::sys::signal::Signal,
    ) -> Result<(), PlatformError> {
        let live = self.observe()?;
        self.signal_processes(&live, signal)
    }
}

#[cfg(target_os = "windows")]
pub fn desktop_process_ids() -> Result<Vec<u32>, PlatformError> {
    let mut matches = Vec::new();
    for process in windows_process::process_entries()? {
        let Ok(path) = windows_process::process_image_path(process.id) else {
            continue;
        };
        let path = path.to_string_lossy().replace('/', "\\").to_lowercase();
        if path.contains("\\windowsapps\\openai.codex_") && path.ends_with("\\app\\chatgpt.exe") {
            matches.push(process.id);
        }
    }
    Ok(matches)
}

#[cfg(target_os = "windows")]
pub fn desktop_root_process_ids() -> Result<Vec<u32>, PlatformError> {
    let entries = windows_process::process_entries()?;
    let desktop_ids = desktop_process_ids()?;
    Ok(entries
        .into_iter()
        .filter(|process| {
            desktop_ids.contains(&process.id) && !desktop_ids.contains(&process.parent_id)
        })
        .map(|process| process.id)
        .collect())
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
pub fn desktop_process_ids() -> Result<Vec<u32>, PlatformError> {
    let installation = discover_codex_desktop()?;
    Ok(desktop_process_tree(&installation)?
        .into_iter()
        .filter(|process| process.executable == installation.desktop_executable)
        .map(|process| process.id)
        .collect())
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
pub fn desktop_root_process_ids() -> Result<Vec<u32>, PlatformError> {
    desktop_process_ids()
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
pub fn desktop_process_ids() -> Result<Vec<u32>, PlatformError> {
    Err(PlatformError::Unsupported(
        "Desktop process discovery currently supports Windows, macOS, and Linux only",
    ))
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
pub fn desktop_root_process_ids() -> Result<Vec<u32>, PlatformError> {
    desktop_process_ids()
}

#[cfg(target_os = "windows")]
fn windows_executable_key(path: &Path) -> String {
    node_entrypoint_path(path)
        .to_string_lossy()
        .replace('/', "\\")
        .to_lowercase()
}

#[cfg(target_os = "windows")]
pub fn descendant_executable_exists(
    root_process_id: u32,
    executable: &Path,
) -> Result<bool, PlatformError> {
    let entries = windows_process::process_entries()?;
    let mut owned = vec![root_process_id];
    loop {
        let mut changed = false;
        for process in &entries {
            if !owned.contains(&process.id) && owned.contains(&process.parent_id) {
                owned.push(process.id);
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }
    let expected = windows_executable_key(executable);
    Ok(owned.into_iter().skip(1).any(|process_id| {
        windows_process::process_image_path(process_id)
            .is_ok_and(|path| windows_executable_key(&path) == expected)
    }))
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
pub fn descendant_executable_exists(
    root_process_id: u32,
    executable: &Path,
) -> Result<bool, PlatformError> {
    let snapshots = process_snapshots()?;
    Ok(descendant_snapshots(&[root_process_id], &snapshots)
        .iter()
        .any(|process| process.executable == executable))
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
pub fn descendant_executable_exists(
    _root_process_id: u32,
    _executable: &Path,
) -> Result<bool, PlatformError> {
    Err(PlatformError::Unsupported(
        "descendant process discovery currently supports Windows, macOS, and Linux only",
    ))
}

#[cfg(target_os = "windows")]
pub fn parent_process_id(process_id: u32) -> Result<Option<u32>, PlatformError> {
    Ok(windows_process::process_entries()?
        .into_iter()
        .find(|process| process.id == process_id)
        .map(|process| process.parent_id))
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
pub fn parent_process_id(process_id: u32) -> Result<Option<u32>, PlatformError> {
    process_snapshot(process_id).map(|process| Some(process.parent_id))
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
pub fn parent_process_id(_process_id: u32) -> Result<Option<u32>, PlatformError> {
    Err(PlatformError::Unsupported(
        "parent process discovery currently supports Windows, macOS, and Linux only",
    ))
}

#[cfg(target_os = "windows")]
pub fn process_executable_path(process_id: u32) -> Result<PathBuf, PlatformError> {
    windows_process::process_image_path(process_id).map_err(PlatformError::Io)
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
pub fn process_executable_path(process_id: u32) -> Result<PathBuf, PlatformError> {
    process_snapshot(process_id).map(|process| process.executable)
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
pub fn process_executable_path(_process_id: u32) -> Result<PathBuf, PlatformError> {
    Err(PlatformError::Unsupported(
        "process executable discovery currently supports Windows, macOS, and Linux only",
    ))
}

#[cfg(target_os = "windows")]
pub fn terminate_process_by_id(process_id: u32) -> Result<(), PlatformError> {
    windows_process::terminate_process(process_id, 1).map_err(PlatformError::Io)
}

#[cfg(not(target_os = "windows"))]
pub fn terminate_process_by_id(_process_id: u32) -> Result<(), PlatformError> {
    Err(PlatformError::Unsupported(
        "process termination by ID is currently supported on Windows only",
    ))
}

#[cfg(target_os = "windows")]
pub fn process_exists(process_id: u32) -> bool {
    windows_process::process_entries()
        .is_ok_and(|entries| entries.iter().any(|process| process.id == process_id))
}

#[cfg(target_os = "macos")]
pub fn process_exists(process_id: u32) -> bool {
    use libproc::libproc::proc_pid::pidpath;

    i32::try_from(process_id).is_ok_and(|process_id| pidpath(process_id).is_ok())
}

#[cfg(target_os = "linux")]
pub fn process_exists(process_id: u32) -> bool {
    super::linux_process::linux_process_exists(process_id)
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn signal_processes_checked(
    snapshots: &[ProcessSnapshot],
    signal: nix::sys::signal::Signal,
) -> Result<(), PlatformError> {
    use nix::errno::Errno;
    use nix::sys::signal::kill;
    use nix::unistd::Pid;

    for expected in snapshots {
        let current = match process_snapshot(expected.id) {
            Ok(current) => current,
            Err(PlatformError::NotFound(_)) => continue,
            Err(error) => return Err(error),
        };
        if !same_process_identity(expected, &current) {
            return Err(PlatformError::Invalid(format!(
                "PID {} identity changed before signal delivery",
                expected.id
            )));
        }
        let process_id = i32::try_from(expected.id)
            .map_err(|_| PlatformError::Invalid(format!("PID {} exceeds i32::MAX", expected.id)))?;
        if let Err(error) = kill(Pid::from_raw(process_id), signal)
            && error != Errno::ESRCH
        {
            return Err(PlatformError::Io(std::io::Error::from_raw_os_error(
                error as i32,
            )));
        }
    }
    Ok(())
}

/// Forcefully stop the entire Desktop process tree, including descendants such
/// as the injected Shim, Host Runtime, and app-server. The Desktop is verified
/// by identity before every signal so a reused PID is never terminated.
#[cfg(any(target_os = "macos", target_os = "linux"))]
pub fn force_stop_desktop(
    installation: &DesktopInstallation,
    grace: Duration,
) -> Result<(), PlatformError> {
    let members = desktop_process_tree(installation)?;
    if members.is_empty() {
        return Ok(());
    }
    signal_processes_checked(&members, nix::sys::signal::Signal::SIGTERM)?;
    let mut survivors = members;
    let started = Instant::now();
    loop {
        survivors.retain(|process| process_exists(process.id));
        if survivors.is_empty() {
            return Ok(());
        }
        if started.elapsed() >= grace {
            break;
        }
        thread::sleep(Duration::from_millis(20));
    }
    signal_processes_checked(&survivors, nix::sys::signal::Signal::SIGKILL)?;
    let forced_at = Instant::now();
    loop {
        let still_alive = survivors
            .iter()
            .filter(|process| process_exists(process.id))
            .collect::<Vec<_>>();
        if still_alive.is_empty() {
            return Ok(());
        }
        if forced_at.elapsed() >= grace {
            return Err(PlatformError::Invalid(format!(
                "Desktop processes remained after forced termination: {}",
                still_alive
                    .iter()
                    .map(|process| process.id.to_string())
                    .collect::<Vec<_>>()
                    .join(",")
            )));
        }
        thread::sleep(Duration::from_millis(20));
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
pub fn process_exists(_process_id: u32) -> bool {
    false
}

#[cfg(all(test, target_os = "windows"))]
mod windows_tests {
    use std::path::Path;

    use super::windows_executable_key;

    #[test]
    fn treats_verbatim_and_regular_windows_executable_paths_as_equal() {
        assert_eq!(
            windows_executable_key(Path::new(r"\\?\D:\Program\node.exe")),
            windows_executable_key(Path::new(r"d:\program\node.exe")),
        );
    }
}

#[cfg(all(test, any(target_os = "macos", target_os = "linux")))]
mod tests {
    use std::path::Path;

    use super::{
        ProcessSnapshot, desktop_process_tree_from_snapshots, process_snapshot,
        same_process_identity, same_process_instance,
    };

    fn snapshot(
        id: u32,
        parent_id: u32,
        executable: &str,
        started_at_micros: u64,
    ) -> ProcessSnapshot {
        ProcessSnapshot {
            id,
            parent_id,
            process_group_id: id,
            executable: executable.into(),
            started_at_micros,
        }
    }

    #[test]
    fn snapshots_the_current_process_with_native_platform_apis() {
        let snapshot = process_snapshot(std::process::id()).expect("current process snapshot");
        assert_eq!(snapshot.id, std::process::id());
        assert!(snapshot.parent_id > 0);
        assert!(snapshot.process_group_id > 0);
        assert!(snapshot.executable.is_absolute());
        assert!(snapshot.started_at_micros > 0);
    }

    #[test]
    fn selects_only_the_target_desktop_root_and_its_descendants() {
        let target = "/Applications/Codex.app/Contents/MacOS/ChatGPT";
        let snapshots = [
            snapshot(10, 1, target, 100),
            snapshot(
                11,
                10,
                "/Applications/Codex.app/Contents/Frameworks/Helper",
                101,
            ),
            snapshot(
                12,
                11,
                "/Applications/Codex.app/Contents/Resources/codex",
                102,
            ),
            snapshot(20, 1, "/tmp/Other.app/Contents/MacOS/ChatGPT", 90),
            snapshot(21, 20, "/tmp/unrelated-child", 91),
        ];
        let tree = desktop_process_tree_from_snapshots(Path::new(target), &snapshots);
        assert_eq!(
            tree.iter().map(|process| process.id).collect::<Vec<_>>(),
            [10, 11, 12]
        );
    }

    #[test]
    fn distinguishes_pid_reuse_from_a_legitimate_exec() {
        let original = snapshot(10, 1, "/tmp/helper", 100);
        let execed = snapshot(10, 1, "/tmp/tool", 100);
        let reused = snapshot(10, 1, "/tmp/helper", 101);
        assert!(same_process_instance(&original, &execed));
        assert!(!same_process_identity(&original, &execed));
        assert!(!same_process_instance(&original, &reused));
    }

    #[test]
    fn terminates_a_spawned_process_by_identity() {
        use std::process::Command;

        use nix::sys::signal::Signal;

        use super::signal_processes_checked;

        let mut child = Command::new("/bin/sleep")
            .arg("60")
            .spawn()
            .expect("spawn sleep");
        let snapshot = process_snapshot(child.id()).expect("snapshot sleep process");
        signal_processes_checked(&[snapshot], Signal::SIGTERM).expect("terminate sleep");
        let status = child.wait().expect("wait for sleep exit");
        assert!(!status.success());
    }
}
