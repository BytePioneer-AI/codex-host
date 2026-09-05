//! A managed Desktop also passes its environment to native tool helpers. Their
//! private app-servers must not become another owner of the Host Runtime.

#[cfg(any(target_os = "windows", test))]
use codexhost_platform::ProcessSnapshot;

pub(crate) fn is_desktop_helper() -> bool {
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
    #[cfg(not(target_os = "windows"))]
    false
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
