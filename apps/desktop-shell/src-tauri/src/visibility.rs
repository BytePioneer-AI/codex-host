use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WindowVisibilityState {
    pub hidden: bool,
    pub revision: u64,
}

pub(crate) const fn compute_window_hidden(visible: bool, minimized: bool) -> bool {
    !visible || minimized
}

#[derive(Debug)]
pub(crate) struct WindowVisibility {
    hidden: bool,
    revision: u64,
}

impl WindowVisibility {
    pub(crate) const fn new(hidden: bool) -> Self {
        Self {
            hidden,
            revision: 0,
        }
    }

    pub(crate) const fn state(&self) -> WindowVisibilityState {
        WindowVisibilityState {
            hidden: self.hidden,
            revision: self.revision,
        }
    }

    pub(crate) fn update(&mut self, hidden: bool) -> Option<WindowVisibilityState> {
        if self.hidden == hidden {
            return None;
        }
        self.hidden = hidden;
        self.revision = self.revision.saturating_add(1);
        Some(self.state())
    }
}

pub(crate) fn sync_script(state: WindowVisibilityState) -> String {
    format!(
        "window.__codexhostSetWindowHidden?.({}, {});",
        state.hidden, state.revision
    )
}

#[cfg(test)]
mod tests {
    use super::{WindowVisibility, WindowVisibilityState, compute_window_hidden, sync_script};

    #[test]
    fn computes_hidden_only_when_invisible_or_minimized() {
        assert!(!compute_window_hidden(true, false));
        assert!(compute_window_hidden(true, true));
        assert!(compute_window_hidden(false, false));
        assert!(compute_window_hidden(false, true));
    }

    #[test]
    fn updates_only_on_transition_and_increments_revision() {
        let mut tracker = WindowVisibility::new(true);
        assert_eq!(
            tracker.state(),
            WindowVisibilityState {
                hidden: true,
                revision: 0,
            }
        );
        assert_eq!(tracker.update(true), None);

        let shown = tracker.update(false).expect("hidden -> visible emits state");
        assert_eq!(
            shown,
            WindowVisibilityState {
                hidden: false,
                revision: 1,
            }
        );
        assert_eq!(tracker.update(false), None);

        let hidden = tracker.update(true).expect("visible -> hidden emits state");
        assert_eq!(
            hidden,
            WindowVisibilityState {
                hidden: true,
                revision: 2,
            }
        );
    }

    #[test]
    fn formats_sync_script_with_boolean_and_revision() {
        assert_eq!(
            sync_script(WindowVisibilityState {
                hidden: true,
                revision: 3,
            }),
            "window.__codexhostSetWindowHidden?.(true, 3);"
        );
        assert_eq!(
            sync_script(WindowVisibilityState {
                hidden: false,
                revision: 4,
            }),
            "window.__codexhostSetWindowHidden?.(false, 4);"
        );
    }
}
