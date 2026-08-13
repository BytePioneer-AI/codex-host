use super::{DesktopInstallation, PlatformError};
#[cfg(target_os = "windows")]
use super::{node_entrypoint_path, windows_process};
use std::path::{Path, PathBuf};
#[cfg(target_os = "macos")]
use std::thread;
#[cfg(target_os = "macos")]
use std::time::{Duration, Instant};

#[cfg(target_os = "linux")]
static LINUX_CLOCK_TICKS_PER_SECOND: std::sync::OnceLock<u64> = std::sync::OnceLock::new();

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessSnapshot {
    pub id: u32,
    pub parent_id: u32,
    pub process_group_id: u32,
    pub executable: PathBuf,
    pub started_at_micros: u64,
}

#[cfg(target_os = "macos")]
pub(crate) fn unix_process_snapshot(process_id: u32) -> Result<ProcessSnapshot, PlatformError> {
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

#[cfg(target_os = "linux")]
fn linux_stat_fields(process_id: u32) -> Result<(u32, u32, u64), PlatformError> {
    let path = format!("/proc/{process_id}/stat");
    let text = std::fs::read_to_string(&path).map_err(|error| match error.kind() {
        std::io::ErrorKind::NotFound => {
            PlatformError::NotFound(format!("cannot inspect PID {process_id}: {error}"))
        }
        _ => PlatformError::Io(error),
    })?;
    let command_end = text.rfind(')').ok_or_else(|| {
        PlatformError::Invalid(format!("PID {process_id} stat has no command terminator"))
    })?;
    let fields = text
        .get(command_end + 2..)
        .ok_or_else(|| PlatformError::Invalid(format!("PID {process_id} stat is truncated")))?
        .split_ascii_whitespace()
        .collect::<Vec<_>>();
    if fields.len() < 20 {
        return Err(PlatformError::Invalid(format!(
            "PID {process_id} stat has too few fields"
        )));
    }
    let parse = |index: usize, name: &str| {
        fields[index].parse::<u64>().map_err(|error| {
            PlatformError::Invalid(format!("PID {process_id} has invalid {name}: {error}"))
        })
    };
    let parent_id = u32::try_from(parse(1, "parent PID")?)
        .map_err(|_| PlatformError::Invalid(format!("PID {process_id} parent PID exceeds u32")))?;
    let process_group_id = u32::try_from(parse(2, "process group")?).map_err(|_| {
        PlatformError::Invalid(format!("PID {process_id} process group exceeds u32"))
    })?;
    let start_ticks = parse(19, "start time")?;
    let ticks_per_second = if let Some(ticks) = LINUX_CLOCK_TICKS_PER_SECOND.get() {
        *ticks
    } else {
        let ticks = nix::unistd::sysconf(nix::unistd::SysconfVar::CLK_TCK)
            .map_err(|error| PlatformError::Io(std::io::Error::from_raw_os_error(error as i32)))?
            .and_then(|ticks| u64::try_from(ticks).ok())
            .filter(|ticks| *ticks > 0)
            .ok_or_else(|| PlatformError::Invalid("Linux clock tick rate is unavailable".into()))?;
        let _ = LINUX_CLOCK_TICKS_PER_SECOND.set(ticks);
        ticks
    };
    let started_at_micros = start_ticks
        .saturating_mul(1_000_000)
        .checked_div(ticks_per_second)
        .ok_or_else(|| PlatformError::Invalid("Linux clock tick rate is zero".into()))?;
    Ok((parent_id, process_group_id, started_at_micros))
}

#[cfg(target_os = "linux")]
pub(crate) fn unix_process_snapshot(process_id: u32) -> Result<ProcessSnapshot, PlatformError> {
    let (parent_id, process_group_id, started_at_micros) = linux_stat_fields(process_id)?;
    let executable = std::fs::read_link(format!("/proc/{process_id}/exe")).map_err(|error| {
        match error.kind() {
            std::io::ErrorKind::NotFound => {
                PlatformError::NotFound(format!("cannot resolve PID {process_id}: {error}"))
            }
            _ => PlatformError::Io(error),
        }
    })?;
    Ok(ProcessSnapshot {
        id: process_id,
        parent_id,
        process_group_id,
        executable,
        started_at_micros,
    })
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
pub fn process_snapshot(process_id: u32) -> Result<ProcessSnapshot, PlatformError> {
    unix_process_snapshot(process_id)
}

#[cfg(target_os = "macos")]
pub fn process_snapshots() -> Result<Vec<ProcessSnapshot>, PlatformError> {
    use libproc::processes::{ProcFilter, pids_by_type};

    Ok(pids_by_type(ProcFilter::All)?
        .into_iter()
        .filter_map(|process_id| unix_process_snapshot(process_id).ok())
        .collect())
}

#[cfg(target_os = "linux")]
pub fn process_snapshots() -> Result<Vec<ProcessSnapshot>, PlatformError> {
    let entries = std::fs::read_dir("/proc")?;
    Ok(entries
        .filter_map(Result::ok)
        .filter_map(|entry| entry.file_name().to_str()?.parse::<u32>().ok())
        .filter_map(|process_id| unix_process_snapshot(process_id).ok())
        .collect())
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
pub(crate) fn same_process_instance(expected: &ProcessSnapshot, current: &ProcessSnapshot) -> bool {
    expected.id == current.id && expected.started_at_micros == current.started_at_micros
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn same_process_identity(expected: &ProcessSnapshot, current: &ProcessSnapshot) -> bool {
    same_process_instance(expected, current) && expected.executable == current.executable
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
pub(crate) fn descendant_snapshots(
    roots: &[u32],
    snapshots: &[ProcessSnapshot],
) -> Vec<ProcessSnapshot> {
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
    let matching_ids = snapshots
        .iter()
        .filter(|process| process.executable == desktop_executable)
        .map(|process| process.id)
        .collect::<Vec<_>>();
    let roots = snapshots
        .iter()
        .filter(|process| {
            process.executable == desktop_executable && !matching_ids.contains(&process.parent_id)
        })
        .cloned()
        .collect::<Vec<_>>();
    let root_ids = roots.iter().map(|process| process.id).collect::<Vec<_>>();
    let mut tree = roots;
    tree.extend(descendant_snapshots(&root_ids, snapshots));
    tree.sort_by_key(|process| process.id);
    tree
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
pub(crate) fn desktop_root_snapshots(
    desktop_executable: &Path,
    snapshots: &[ProcessSnapshot],
) -> Vec<ProcessSnapshot> {
    let tree = desktop_process_tree_from_snapshots(desktop_executable, snapshots);
    let tree_ids = tree.iter().map(|process| process.id).collect::<Vec<_>>();
    tree.into_iter()
        .filter(|process| {
            process.executable == desktop_executable && !tree_ids.contains(&process.parent_id)
        })
        .collect()
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
    process_group_id: Option<u32>,
    process_group_started_at_micros: u64,
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
impl ObservedProcessTree {
    pub(crate) fn new(root: ProcessSnapshot) -> Self {
        let process_group_id = (root.process_group_id == root.id).then_some(root.process_group_id);
        Self::new_with_process_group(root, process_group_id, None)
    }

    pub(crate) fn new_with_process_group(
        root: ProcessSnapshot,
        process_group_id: Option<u32>,
        process_group_started_at_micros: Option<u64>,
    ) -> Self {
        Self::new_with_owned_processes(
            root,
            process_group_id,
            process_group_started_at_micros,
            Vec::new(),
        )
    }

    pub(crate) fn new_with_owned_processes(
        root: ProcessSnapshot,
        process_group_id: Option<u32>,
        process_group_started_at_micros: Option<u64>,
        mut known: Vec<ProcessSnapshot>,
    ) -> Self {
        if !known
            .iter()
            .any(|process| same_process_instance(process, &root))
        {
            known.push(root.clone());
        }
        Self {
            process_group_id,
            process_group_started_at_micros: process_group_started_at_micros
                .unwrap_or(root.started_at_micros),
            known,
            root,
        }
    }

    pub(crate) fn process_group_id(&self) -> u32 {
        self.process_group_id.unwrap_or(self.root.process_group_id)
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
        let mut observed = self
            .process_group_id
            .map_or_else(Vec::new, |process_group_id| {
                snapshots
                    .iter()
                    .filter(|process| {
                        process.started_at_micros >= self.process_group_started_at_micros
                            && process.process_group_id == process_group_id
                    })
                    .cloned()
                    .collect::<Vec<_>>()
            });
        // The Linux managed-launch group is private when it is created, but a
        // later foreign member still must not silently become owned. The root
        // itself (exec path) and known descendants prove lineage; a same-PGID
        // process that cannot be traced from either is rejected before any
        // lifecycle signal can reach it.
        #[cfg(target_os = "linux")]
        if self.process_group_id.is_some() {
            let permitted = descendant_snapshots(&known_ids, &snapshots);
            if let Some(foreign) = observed.iter().find(|process| {
                !self
                    .known
                    .iter()
                    .any(|known| same_process_instance(known, process))
                    && !permitted
                        .iter()
                        .any(|descendant| same_process_instance(descendant, process))
            }) {
                return Err(PlatformError::Invalid(format!(
                    "unattributed PID {} joined the managed Desktop process group",
                    foreign.id
                )));
            }
        }
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
        #[cfg(target_os = "macos")]
        use nix::errno::Errno;
        #[cfg(target_os = "macos")]
        use nix::sys::signal::kill;
        #[cfg(target_os = "macos")]
        use nix::unistd::Pid;

        for expected in processes {
            #[cfg(target_os = "linux")]
            {
                use rustix::process::{Pid, PidfdFlags, Signal, pidfd_open, pidfd_send_signal};

                let process_id = Pid::from_raw(expected.id as i32).ok_or_else(|| {
                    PlatformError::Invalid(format!("PID {} is invalid", expected.id))
                })?;
                let descriptor = match pidfd_open(process_id, PidfdFlags::empty()) {
                    Ok(descriptor) => descriptor,
                    Err(error) if error == rustix::io::Errno::SRCH => continue,
                    Err(error) => return Err(PlatformError::Io(error.into())),
                };
                let current = match unix_process_snapshot(expected.id) {
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
                let signal = Signal::from_named_raw(signal as i32).ok_or_else(|| {
                    PlatformError::Invalid(format!("unsupported Unix signal {signal}"))
                })?;
                if let Err(error) = pidfd_send_signal(descriptor, signal)
                    && error != rustix::io::Errno::SRCH
                {
                    return Err(PlatformError::Io(error.into()));
                }
            }
            #[cfg(target_os = "macos")]
            {
                let current = match unix_process_snapshot(expected.id) {
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

#[cfg(any(target_os = "macos", target_os = "linux"))]
pub(crate) fn signal_processes_exact(
    processes: &[ProcessSnapshot],
    signal: nix::sys::signal::Signal,
) -> Result<(), PlatformError> {
    let snapshots = process_snapshots()?;
    let live = processes
        .iter()
        .filter_map(
            |expected| match snapshots.iter().find(|current| current.id == expected.id) {
                Some(current) if same_process_identity(expected, current) => {
                    Some(Ok(expected.clone()))
                }
                Some(_) => Some(Err(PlatformError::Invalid(format!(
                    "PID {} identity changed before cleanup",
                    expected.id
                )))),
                None => None,
            },
        )
        .collect::<Result<Vec<_>, _>>()?;
    let Some(root) = live.first().cloned() else {
        return Ok(());
    };
    // This is a one-shot exact-identity operation rather than supervision of
    // a new process group. Do not discover additional same-PGID processes.
    ObservedProcessTree::new_with_process_group(root, None, None).signal_processes(&live, signal)
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

#[cfg(target_os = "windows")]
pub fn desktop_process_ids_for_installation(
    installation: &DesktopInstallation,
) -> Result<Vec<u32>, PlatformError> {
    let expected = windows_executable_key(&installation.desktop_executable);
    Ok(windows_process::process_entries()?
        .into_iter()
        .filter(|process| {
            windows_process::process_image_path(process.id)
                .is_ok_and(|path| windows_executable_key(&path) == expected)
        })
        .map(|process| process.id)
        .collect())
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
pub fn desktop_process_ids_for_installation(
    installation: &DesktopInstallation,
) -> Result<Vec<u32>, PlatformError> {
    Ok(desktop_process_tree(installation)?
        .into_iter()
        .filter(|process| process.executable == installation.desktop_executable)
        .map(|process| process.id)
        .collect())
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
pub fn desktop_process_ids_for_installation(
    _installation: &DesktopInstallation,
) -> Result<Vec<u32>, PlatformError> {
    Err(PlatformError::Unsupported(
        "Desktop process discovery currently supports Windows, macOS, and Linux only",
    ))
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
pub fn desktop_root_snapshots_for_installation(
    installation: &DesktopInstallation,
) -> Result<Vec<ProcessSnapshot>, PlatformError> {
    Ok(desktop_root_snapshots(
        &installation.desktop_executable,
        &process_snapshots()?,
    ))
}

#[cfg(target_os = "windows")]
pub fn desktop_root_process_ids_for_installation(
    installation: &DesktopInstallation,
) -> Result<Vec<u32>, PlatformError> {
    let entries = windows_process::process_entries()?;
    let desktop_ids = desktop_process_ids_for_installation(installation)?;
    Ok(entries
        .into_iter()
        .filter(|process| {
            desktop_ids.contains(&process.id) && !desktop_ids.contains(&process.parent_id)
        })
        .map(|process| process.id)
        .collect())
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
pub fn desktop_root_process_ids_for_installation(
    installation: &DesktopInstallation,
) -> Result<Vec<u32>, PlatformError> {
    Ok(desktop_root_snapshots_for_installation(installation)?
        .into_iter()
        .map(|process| process.id)
        .collect())
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
pub fn desktop_root_process_ids_for_installation(
    _installation: &DesktopInstallation,
) -> Result<Vec<u32>, PlatformError> {
    Err(PlatformError::Unsupported(
        "Desktop process discovery currently supports Windows, macOS, and Linux only",
    ))
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
    unix_process_snapshot(process_id).map(|process| Some(process.parent_id))
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
    let Some(process_id) = i32::try_from(process_id)
        .ok()
        .and_then(rustix::process::Pid::from_raw)
    else {
        return false;
    };
    match rustix::process::test_kill_process(process_id) {
        Ok(()) | Err(rustix::io::Errno::PERM) => true,
        Err(_) => false,
    }
}

/// Forcefully stop an unmanaged macOS Desktop process tree, verifying every
/// process identity before signal delivery.
#[cfg(target_os = "macos")]
pub fn force_stop_desktop(
    installation: &DesktopInstallation,
    grace: Duration,
) -> Result<(), PlatformError> {
    let tree = desktop_process_tree(installation)?;
    if tree.is_empty() {
        return Ok(());
    }
    let mut observed = ObservedProcessTree::new(tree[0].clone());
    observed.signal_processes(&tree, nix::sys::signal::Signal::SIGTERM)?;
    let started = Instant::now();
    let survivors = loop {
        let survivors = observed.observe()?;
        if survivors.is_empty() {
            return Ok(());
        }
        if started.elapsed() >= grace {
            break survivors;
        }
        thread::sleep(Duration::from_millis(20));
    };
    observed.signal_processes(&survivors, nix::sys::signal::Signal::SIGKILL)?;
    let forced_at = Instant::now();
    loop {
        let still_alive = observed.observe()?;
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
        ObservedProcessTree, ProcessSnapshot, desktop_process_tree_from_snapshots,
        desktop_root_snapshots, process_snapshot, same_process_identity, same_process_instance,
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
    fn snapshots_the_current_unix_process() {
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
            snapshot(11, 10, target, 101),
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
        assert_eq!(
            desktop_root_snapshots(Path::new(target), &snapshots)
                .iter()
                .map(|process| process.id)
                .collect::<Vec<_>>(),
            [10]
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

    #[cfg(target_os = "linux")]
    #[test]
    fn pidfd_signal_targets_the_observed_process_instance() {
        use std::process::Command;
        use std::thread;
        use std::time::{Duration, Instant};

        let mut child = Command::new("sleep")
            .arg("30")
            .spawn()
            .expect("spawn sleep");
        let observed = process_snapshot(child.id()).expect("snapshot child");
        let tree = ObservedProcessTree::new(observed.clone());
        tree.signal_processes(&[observed], nix::sys::signal::Signal::SIGTERM)
            .expect("signal observed child");
        let started = Instant::now();
        loop {
            if child.try_wait().expect("wait child").is_some() {
                break;
            }
            assert!(
                started.elapsed() < Duration::from_secs(2),
                "pidfd signal did not terminate child"
            );
            thread::sleep(Duration::from_millis(10));
        }
    }
}
