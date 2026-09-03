use std::collections::{HashMap, HashSet};
use std::error::Error;
use std::path::{Path, PathBuf};
#[cfg(target_os = "macos")]
use std::process::Command;
use std::thread;
use std::time::{Duration, Instant};

use codexhost_platform::{
    ProcessSnapshot, process_snapshot, process_snapshots, terminate_process_instance,
};

const STOP_TIMEOUT: Duration = Duration::from_secs(3);

type LifecycleResult<T> = Result<T, Box<dyn Error>>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ListenerRole {
    Stock,
    Managed,
}

struct TerminateOptions {
    role: ListenerRole,
    socket_path: PathBuf,
    stock_codex_path: PathBuf,
    node_path: PathBuf,
    host_runtime_path: PathBuf,
}

fn parse_options(arguments: &[String]) -> LifecycleResult<TerminateOptions> {
    let role = match arguments.first().map(String::as_str) {
        Some("stock") => ListenerRole::Stock,
        Some("managed") => ListenerRole::Managed,
        _ => return Err("remote listener role must be 'stock' or 'managed'".into()),
    };
    let mut socket_path = None;
    let mut stock_codex_path = None;
    let mut node_path = None;
    let mut host_runtime_path = None;
    let mut index = 1;
    while index < arguments.len() {
        let option = &arguments[index];
        let value = arguments
            .get(index + 1)
            .ok_or_else(|| format!("{option} requires a path"))?;
        match option.as_str() {
            "--socket" => socket_path = Some(PathBuf::from(value)),
            "--stock-codex" => stock_codex_path = Some(PathBuf::from(value)),
            "--node" => node_path = Some(PathBuf::from(value)),
            "--host-runtime" => host_runtime_path = Some(PathBuf::from(value)),
            _ => return Err(format!("unknown remote lifecycle option '{option}'").into()),
        }
        index += 2;
    }
    Ok(TerminateOptions {
        role,
        socket_path: socket_path.ok_or("--socket is required")?,
        stock_codex_path: stock_codex_path.ok_or("--stock-codex is required")?,
        node_path: node_path.ok_or("--node is required")?,
        host_runtime_path: host_runtime_path.ok_or("--host-runtime is required")?,
    })
}

#[cfg(target_os = "linux")]
fn socket_owner_process_ids(socket_path: &Path) -> LifecycleResult<Vec<u32>> {
    use std::os::unix::fs::MetadataExt;

    let socket_text = socket_path.to_string_lossy();
    let socket_inodes = std::fs::read_to_string("/proc/net/unix")?
        .lines()
        .filter_map(|line| {
            let fields = line.split_ascii_whitespace().collect::<Vec<_>>();
            if fields
                .get(7)
                .is_some_and(|path| *path == socket_text.as_ref())
            {
                fields.get(6).map(|inode| (*inode).to_owned())
            } else {
                None
            }
        })
        .collect::<HashSet<_>>();
    if socket_inodes.is_empty() {
        return Ok(Vec::new());
    }
    let current_uid = std::fs::metadata("/proc/self")?.uid();
    let mut owners = Vec::new();
    for entry in std::fs::read_dir("/proc")?.filter_map(Result::ok) {
        let Some(process_id) = entry
            .file_name()
            .to_str()
            .and_then(|name| name.parse::<u32>().ok())
        else {
            continue;
        };
        if entry.metadata().map(|metadata| metadata.uid()).ok() != Some(current_uid) {
            continue;
        }
        let file_descriptors = match std::fs::read_dir(entry.path().join("fd")) {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        if file_descriptors.filter_map(Result::ok).any(|descriptor| {
            std::fs::read_link(descriptor.path())
                .ok()
                .and_then(|target| {
                    target
                        .to_str()?
                        .strip_prefix("socket:[")?
                        .strip_suffix(']')
                        .map(str::to_owned)
                })
                .is_some_and(|inode| socket_inodes.contains(&inode))
        }) {
            owners.push(process_id);
        }
    }
    owners.sort_unstable();
    owners.dedup();
    Ok(owners)
}

#[cfg(target_os = "macos")]
fn socket_owner_process_ids(socket_path: &Path) -> LifecycleResult<Vec<u32>> {
    let user_id = Command::new("id").arg("-u").output()?;
    if !user_id.status.success() {
        return Err("cannot resolve the current user ID".into());
    }
    let user_id = String::from_utf8(user_id.stdout)?.trim().to_owned();
    let output = Command::new("lsof")
        .args(["-n", "-t", "-a", "-u", &user_id, "--"])
        .arg(socket_path)
        .output()?;
    if !output.status.success() && output.stdout.is_empty() {
        return Ok(Vec::new());
    }
    let mut owners = String::from_utf8(output.stdout)?
        .lines()
        .filter_map(|line| line.trim().parse::<u32>().ok())
        .collect::<Vec<_>>();
    owners.sort_unstable();
    owners.dedup();
    Ok(owners)
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn socket_owner_process_ids(_socket_path: &Path) -> LifecycleResult<Vec<u32>> {
    Err("remote Host lifecycle requires macOS or Linux".into())
}

#[cfg(target_os = "linux")]
fn process_arguments(process_id: u32) -> LifecycleResult<Vec<String>> {
    Ok(std::fs::read(format!("/proc/{process_id}/cmdline"))?
        .split(|byte| *byte == 0)
        .filter(|argument| !argument.is_empty())
        .map(|argument| String::from_utf8_lossy(argument).into_owned())
        .collect())
}

#[cfg(target_os = "macos")]
fn process_arguments(process_id: u32) -> LifecycleResult<Vec<String>> {
    let output = Command::new("ps")
        .args(["-ww", "-p", &process_id.to_string(), "-o", "command="])
        .output()?;
    if !output.status.success() {
        return Err(format!("cannot inspect PID {process_id} command").into());
    }
    Ok(vec![String::from_utf8(output.stdout)?.trim().to_owned()])
}

fn has_default_listener(arguments: &[String]) -> bool {
    let command = arguments.join(" ");
    let app_server = arguments.iter().any(|argument| argument == "app-server")
        || command.contains(" app-server ");
    let exact_arguments = arguments
        .windows(2)
        .any(|pair| pair[0] == "--listen" && pair[1] == "unix://")
        || arguments
            .iter()
            .any(|argument| argument == "--listen=unix://");
    let shell_command = arguments.len() == 1
        && (command.contains(" --listen unix://") || command.contains(" --listen=unix://"));
    let proxy = arguments.iter().any(|argument| argument == "proxy")
        || command.contains(" app-server proxy");
    app_server && (exact_arguments || shell_command) && !proxy
}

fn is_managed_desktop_ssh_service(arguments: &[String]) -> bool {
    arguments == ["codex app-server desktop-ssh-websocket-v0.sock"]
}

fn command_mentions_path(arguments: &[String], expected: &Path) -> bool {
    let expected = expected.to_string_lossy();
    arguments
        .iter()
        .any(|argument| argument == expected.as_ref())
        || (arguments.len() == 1
            && arguments[0]
                .split_ascii_whitespace()
                .map(|argument| argument.trim_matches(['\'', '"']))
                .any(|argument| argument == expected.as_ref()))
}

fn matching_root(
    owner: &ProcessSnapshot,
    snapshots: &HashMap<u32, ProcessSnapshot>,
    options: &TerminateOptions,
) -> LifecycleResult<Option<ProcessSnapshot>> {
    let expected_node = options.node_path.canonicalize()?;
    let expected_stock = options.stock_codex_path.canonicalize()?;
    let expected_command = match options.role {
        ListenerRole::Stock => &options.stock_codex_path,
        ListenerRole::Managed => &options.host_runtime_path,
    };
    let mut current = Some(owner.clone());
    for _ in 0..32 {
        let Some(snapshot) = current else { break };
        let executable = snapshot.executable.canonicalize().ok();
        let arguments = process_arguments(snapshot.id).unwrap_or_default();
        let listener_matches = match options.role {
            ListenerRole::Stock => {
                let executable_matches = executable.as_ref() == Some(&expected_stock)
                    || (executable.as_ref() == Some(&expected_node)
                        && command_mentions_path(&arguments, expected_command));
                executable_matches && has_default_listener(&arguments)
            }
            ListenerRole::Managed => {
                executable.as_ref() == Some(&expected_node)
                    && (command_mentions_path(&arguments, expected_command)
                        || is_managed_desktop_ssh_service(&arguments))
                    && (has_default_listener(&arguments)
                        || is_managed_desktop_ssh_service(&arguments))
            }
        };
        if listener_matches {
            return Ok(Some(snapshot));
        }
        current = snapshots.get(&snapshot.parent_id).cloned();
    }
    Ok(None)
}

fn matching_roots(
    owners: &[u32],
    all: &[ProcessSnapshot],
    options: &TerminateOptions,
) -> LifecycleResult<Vec<ProcessSnapshot>> {
    let snapshots = all
        .iter()
        .cloned()
        .map(|snapshot| (snapshot.id, snapshot))
        .collect::<HashMap<_, _>>();
    let mut roots = Vec::new();
    for owner_id in owners {
        let Some(owner) = snapshots.get(owner_id) else {
            continue;
        };
        if let Some(root) = matching_root(owner, &snapshots, options)?
            && !roots
                .iter()
                .any(|candidate: &ProcessSnapshot| candidate.id == root.id)
        {
            roots.push(root);
        }
    }
    Ok(roots)
}

pub fn existing_listener_is_reusable(
    socket_path: &Path,
    stock_codex_path: &Path,
    node_path: Option<&Path>,
    host_runtime_path: Option<&Path>,
) -> LifecycleResult<bool> {
    let (role, node_path, host_runtime_path) = match (node_path, host_runtime_path) {
        (Some(node_path), Some(host_runtime_path)) => (
            ListenerRole::Managed,
            node_path.to_owned(),
            host_runtime_path.to_owned(),
        ),
        (None, None) => (
            ListenerRole::Stock,
            stock_codex_path.to_owned(),
            stock_codex_path.to_owned(),
        ),
        _ => {
            return Err(
                "CODEXHOST_HOST_NODE_PATH and CODEXHOST_HOST_RUNTIME_PATH must be configured together"
                    .into(),
            );
        }
    };
    let options = TerminateOptions {
        role,
        socket_path: socket_path.to_owned(),
        stock_codex_path: stock_codex_path.to_owned(),
        node_path,
        host_runtime_path,
    };
    let owners = socket_owner_process_ids(socket_path)?;
    if owners.is_empty() {
        return Ok(false);
    }
    let all = process_snapshots()?;
    let roots = matching_roots(&owners, &all, &options)?;
    if roots.len() == 1 {
        return Ok(true);
    }
    Err("remote Host socket owner does not match the requested installed listener".into())
}

fn descendants(root: &ProcessSnapshot, snapshots: &[ProcessSnapshot]) -> Vec<ProcessSnapshot> {
    let mut selected = vec![root.clone()];
    let mut selected_ids = HashSet::from([root.id]);
    loop {
        let mut changed = false;
        for snapshot in snapshots {
            if !selected_ids.contains(&snapshot.id) && selected_ids.contains(&snapshot.parent_id) {
                selected_ids.insert(snapshot.id);
                selected.push(snapshot.clone());
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }
    selected
}

fn process_is_live(expected: &ProcessSnapshot) -> bool {
    process_snapshot(expected.id)
        .is_ok_and(|current| current.started_at_micros == expected.started_at_micros)
}

fn terminate_tree(root: &ProcessSnapshot, all: &[ProcessSnapshot]) -> LifecycleResult<()> {
    let mut tree = descendants(root, all);
    tree.sort_by_key(|process| process.id == root.id);
    for process in &tree {
        terminate_process_instance(process, false)?;
    }
    let deadline = Instant::now() + STOP_TIMEOUT;
    while tree.iter().any(process_is_live) && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(25));
    }
    for process in &tree {
        if process_is_live(process) {
            terminate_process_instance(process, true)?;
        }
    }
    let deadline = Instant::now() + STOP_TIMEOUT;
    while tree.iter().any(process_is_live) && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(25));
    }
    if tree.iter().any(process_is_live) {
        return Err(format!("remote listener PID {} did not exit", root.id).into());
    }
    Ok(())
}

pub fn run_terminate(arguments: &[String]) -> LifecycleResult<i32> {
    let options = parse_options(arguments)?;
    let owners = socket_owner_process_ids(&options.socket_path)?;
    if owners.is_empty() {
        return Err(format!(
            "no process owns remote Host socket {}",
            options.socket_path.display()
        )
        .into());
    }
    let all = process_snapshots()?;
    let mut roots = matching_roots(&owners, &all, &options)?;
    if roots.len() != 1 {
        return Err(
            "remote Host socket owner does not match the requested installed listener".into(),
        );
    }
    let root = roots.remove(0);
    terminate_tree(&root, &all)?;
    println!("terminated_pid={}", root.id);
    Ok(0)
}

#[cfg(test)]
mod tests {
    use super::{command_mentions_path, has_default_listener, is_managed_desktop_ssh_service};
    use std::path::Path;

    fn arguments(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    #[test]
    fn accepts_only_default_listener_commands() {
        assert!(has_default_listener(&arguments(&[
            "node",
            "/opt/codex/bin/codex",
            "app-server",
            "--listen",
            "unix://",
        ])));
        assert!(!has_default_listener(&arguments(&[
            "codex",
            "app-server",
            "proxy",
            "--listen",
            "unix://",
        ])));
        assert!(!has_default_listener(&arguments(&[
            "codex",
            "app-server",
            "--listen",
            "unix:///tmp/custom.sock",
        ])));
        assert!(is_managed_desktop_ssh_service(&arguments(&[
            "codex app-server desktop-ssh-websocket-v0.sock",
        ])));
        assert!(!is_managed_desktop_ssh_service(&arguments(&[
            "codex app-server desktop-ssh-websocket-v1.sock",
        ])));
    }

    #[test]
    fn requires_the_manifest_command_path() {
        let values = arguments(&["node", "/opt/codex/bin/codex", "app-server"]);
        assert!(command_mentions_path(
            &values,
            Path::new("/opt/codex/bin/codex")
        ));
        assert!(!command_mentions_path(
            &values,
            Path::new("/other/bin/codex")
        ));
    }
}
