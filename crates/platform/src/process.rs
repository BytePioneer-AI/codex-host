#[cfg(target_os = "macos")]
use std::path::Path;
use std::path::PathBuf;

use super::PlatformError;
#[cfg(target_os = "windows")]
use super::windows_process;
#[cfg(target_os = "macos")]
use super::{DesktopInstallation, discover_codex_desktop};

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

#[cfg(target_os = "macos")]
pub fn process_snapshots() -> Result<Vec<ProcessSnapshot>, PlatformError> {
    use libproc::processes::{ProcFilter, pids_by_type};

    Ok(pids_by_type(ProcFilter::All)?
        .into_iter()
        .filter_map(|process_id| macos_process_snapshot(process_id).ok())
        .collect())
}

#[cfg(target_os = "macos")]
fn same_process_instance(expected: &ProcessSnapshot, current: &ProcessSnapshot) -> bool {
    expected.id == current.id && expected.started_at_micros == current.started_at_micros
}

#[cfg(target_os = "macos")]
fn same_process_identity(expected: &ProcessSnapshot, current: &ProcessSnapshot) -> bool {
    same_process_instance(expected, current) && expected.executable == current.executable
}

#[cfg(target_os = "macos")]
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

#[cfg(target_os = "macos")]
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

#[cfg(target_os = "macos")]
pub fn desktop_process_tree(
    installation: &DesktopInstallation,
) -> Result<Vec<ProcessSnapshot>, PlatformError> {
    Ok(desktop_process_tree_from_snapshots(
        &installation.desktop_executable,
        &process_snapshots()?,
    ))
}

#[cfg(target_os = "macos")]
pub(crate) struct ObservedProcessTree {
    pub(crate) root: ProcessSnapshot,
    known: Vec<ProcessSnapshot>,
}

#[cfg(target_os = "macos")]
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
            let current = match macos_process_snapshot(expected.id) {
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

#[cfg(target_os = "macos")]
pub fn desktop_process_ids() -> Result<Vec<u32>, PlatformError> {
    let installation = discover_codex_desktop()?;
    Ok(desktop_process_tree(&installation)?
        .into_iter()
        .filter(|process| process.executable == installation.desktop_executable)
        .map(|process| process.id)
        .collect())
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub fn desktop_process_ids() -> Result<Vec<u32>, PlatformError> {
    Err(PlatformError::Unsupported(
        "Desktop process discovery currently supports Windows and macOS only",
    ))
}

#[cfg(target_os = "windows")]
pub fn parent_process_id(process_id: u32) -> Result<Option<u32>, PlatformError> {
    Ok(windows_process::process_entries()?
        .into_iter()
        .find(|process| process.id == process_id)
        .map(|process| process.parent_id))
}

#[cfg(target_os = "macos")]
pub fn parent_process_id(process_id: u32) -> Result<Option<u32>, PlatformError> {
    macos_process_snapshot(process_id).map(|process| Some(process.parent_id))
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub fn parent_process_id(_process_id: u32) -> Result<Option<u32>, PlatformError> {
    Err(PlatformError::Unsupported(
        "parent process discovery currently supports Windows and macOS only",
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

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub fn process_exists(_process_id: u32) -> bool {
    false
}

#[cfg(all(test, target_os = "macos"))]
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
    fn snapshots_the_current_macos_process_with_native_libproc() {
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
}
