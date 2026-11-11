//! A managed Desktop also passes its environment to native tool helpers. Their
//! private app-servers must not become another owner of the Host Runtime.

#[cfg(any(target_os = "windows", test))]
use codexhost_platform::ProcessSnapshot;

pub(crate) fn is_desktop_helper(_stock_codex_path: &std::path::Path) -> bool {
    #[cfg(target_os = "windows")]
    {
        let Some(launcher_id) = std::env::var(super::LAUNCHER_PID_ENV)
            .ok()
            .and_then(|value| value.parse::<u32>().ok())
            .filter(|id| *id != 0)
        else {
            return false;
        };
        is_helper_descendant(std::process::id(), launcher_id, |id| {
            codexhost_platform::process_snapshot(id).ok()
        })
    }
    #[cfg(target_os = "macos")]
    {
        is_macos_desktop_helper(_stock_codex_path).unwrap_or(false)
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    false
}

/// Returns whether the Shim's direct parent is positively known not to be Codex Desktop.
///
/// Only a caller whose official CLI belongs to a validated Desktop bundle can be classified.
/// Unknown layouts keep the caller on the Host Runtime path and its existing ownership checks.
pub(crate) fn is_known_non_desktop_caller(_stock_codex_path: &std::path::Path) -> bool {
    #[cfg(target_os = "macos")]
    {
        use codexhost_platform::process_snapshot;

        let Some(installation) = macos_desktop_installation(_stock_codex_path) else {
            return false;
        };
        let Ok(shim) = process_snapshot(std::process::id()) else {
            return false;
        };
        if shim.parent_id <= 1 {
            return false;
        }
        process_snapshot(shim.parent_id)
            .is_ok_and(|parent| parent.executable != installation.desktop_executable)
    }
    #[cfg(not(target_os = "macos"))]
    false
}

#[cfg(target_os = "macos")]
fn macos_desktop_installation(
    stock_codex_path: &std::path::Path,
) -> Option<codexhost_platform::DesktopInstallation> {
    use codexhost_platform::discover_codex_desktop_from_root;

    // Find the validated Desktop among the CLI's enclosing app bundles; newer
    // layouts nest the CLI in its own app.
    stock_codex_path
        .ancestors()
        .filter(|path| path.extension().is_some_and(|extension| extension == "app"))
        .find_map(|bundle| {
            let installation = discover_codex_desktop_from_root(bundle).ok()?;
            (installation.executable_codex_cli == stock_codex_path).then_some(installation)
        })
}

#[cfg(target_os = "macos")]
fn is_macos_desktop_helper(stock_codex_path: &std::path::Path) -> Option<bool> {
    use codexhost_platform::process_snapshot;

    // Launcher metadata marks a codexhost-managed Desktop tree. The Launcher may
    // exit, or its PID may be reused, while that Desktop and its native helpers
    // keep running with the inherited environment, so its liveness cannot decide
    // the role. LaunchServices reparents Desktop to launchd, so the Launcher is
    // never an ancestor either. The validated Desktop ancestry decides: a direct
    // Desktop -> Shim invocation stays Host, deeper descendants are helpers.
    std::env::var(super::LAUNCHER_PID_ENV)
        .ok()?
        .parse::<u32>()
        .ok()
        .filter(|id| *id != 0)?;
    std::env::var_os("CODEXHOST_LAUNCHER_EXECUTABLE")?;
    let installation = macos_desktop_installation(stock_codex_path)?;
    let mut child = process_snapshot(std::process::id()).ok()?;
    for depth in 1..=32 {
        if child.parent_id <= 1 || child.parent_id == child.id {
            return None;
        }
        let parent = process_snapshot(child.parent_id).ok()?;
        if parent.started_at_micros > child.started_at_micros {
            return None; // Parent PID was reused.
        }
        if parent.executable == installation.desktop_executable {
            return Some(depth > 1);
        }
        child = parent;
    }
    None
}

#[cfg(any(target_os = "windows", test))]
fn is_helper_descendant(
    shim_id: u32,
    launcher_id: u32,
    mut inspect: impl FnMut(u32) -> Option<ProcessSnapshot>,
) -> bool {
    let Some(mut child) = inspect(shim_id) else {
        return false;
    };
    // Windows launch is launcher -> Desktop -> shim. Only a positively observed
    // deeper descendant is a helper; stale/missing launch metadata keeps the
    // existing explicit Host/remote invocation behavior. Bound ancestry work.
    for depth in 1..=32 {
        if child.parent_id == 0 || child.parent_id == child.id {
            return false;
        }
        let Some(parent) = inspect(child.parent_id) else {
            return false;
        };
        if parent.started_at_micros > child.started_at_micros {
            return false; // Parent PID was reused.
        }
        if parent.id == launcher_id {
            return depth > 2;
        }
        child = parent;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot(id: u32, parent_id: u32) -> ProcessSnapshot {
        ProcessSnapshot {
            id,
            parent_id,
            process_group_id: 0,
            executable: std::path::PathBuf::from("fixture"),
            started_at_micros: u64::from(id),
        }
    }

    #[test]
    fn distinguishes_desktop_from_nested_helpers() {
        let inspect = |id| (id >= 1).then(|| snapshot(id, id - 1));
        assert!(!is_helper_descendant(3, 1, inspect));
        assert!(is_helper_descendant(4, 1, inspect));
        assert!(is_helper_descendant(5, 1, inspect));
        assert!(!is_helper_descendant(3, 99, inspect));
    }

    #[test]
    fn rejects_missing_reused_and_unbounded_ancestry() {
        assert!(!is_helper_descendant(4, 1, |_| None));
        assert!(!is_helper_descendant(4, 1, |id| {
            let mut value = snapshot(id, id - 1);
            if id == 2 {
                value.started_at_micros = 99;
            }
            Some(value)
        }));
        assert!(!is_helper_descendant(4, 1, |id| Some(snapshot(id, id))));
        let mut calls = 0;
        assert!(!is_helper_descendant(100, 1, |id| {
            calls += 1;
            Some(snapshot(id, id - 1))
        }));
        assert_eq!(calls, 33);
    }
}
