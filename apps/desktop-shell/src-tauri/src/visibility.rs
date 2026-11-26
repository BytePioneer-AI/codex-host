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
    reconcile_generation: u64,
}

impl WindowVisibility {
    pub(crate) const fn new(hidden: bool) -> Self {
        Self {
            hidden,
            revision: 0,
            reconcile_generation: 0,
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
        self.reconcile_generation = self.reconcile_generation.saturating_add(1);
        Some(self.state())
    }

    pub(crate) fn set_explicit(&mut self, hidden: bool) -> Option<WindowVisibilityState> {
        self.reconcile_generation = self.reconcile_generation.saturating_add(1);
        self.update(hidden)
    }

    pub(crate) fn begin_reconcile(&mut self) -> u64 {
        self.reconcile_generation = self.reconcile_generation.saturating_add(1);
        self.reconcile_generation
    }

    pub(crate) const fn is_reconcile_current(&self, generation: u64) -> bool {
        self.reconcile_generation == generation
    }

    pub(crate) fn apply_reconciled(
        &mut self,
        generation: u64,
        hidden: bool,
    ) -> Option<WindowVisibilityState> {
        if self.reconcile_generation != generation {
            return None;
        }
        self.update(hidden)
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

        let shown = tracker
            .update(false)
            .expect("hidden -> visible emits state");
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

    #[test]
    fn deferred_reconcile_converges_after_minimize_transition_and_drops_stale_generations() {
        let mut tracker = WindowVisibility::new(false);
        let from_command = tracker.begin_reconcile();
        let from_focus_loss = tracker.begin_reconcile();
        assert!(!tracker.is_reconcile_current(from_command));
        assert!(tracker.is_reconcile_current(from_focus_loss));
        assert_eq!(tracker.apply_reconciled(from_command, true), None);

        // During OS minimize animation, is_minimized() may still be false on the first check.
        assert_eq!(
            tracker.apply_reconciled(from_focus_loss, compute_window_hidden(true, false)),
            None
        );
        assert!(tracker.is_reconcile_current(from_focus_loss));

        // Once the OS finishes minimizing, the follow-up check transitions cleanly to hidden.
        let hidden = tracker
            .apply_reconciled(from_focus_loss, compute_window_hidden(true, true))
            .expect("settled minimize must emit hidden=true");
        assert_eq!(
            hidden,
            WindowVisibilityState {
                hidden: true,
                revision: 1,
            }
        );
        // Transitioning invalidates the completed reconcile generation so later retries no-op.
        assert!(!tracker.is_reconcile_current(from_focus_loss));
        assert_eq!(tracker.apply_reconciled(from_focus_loss, false), None);
    }

    #[test]
    fn unfocused_secondary_display_never_pauses_and_explicit_focus_cancels_pending_reconcile() {
        let mut tracker = WindowVisibility::new(false);
        let focus_loss = tracker.begin_reconcile();
        assert_eq!(
            tracker.apply_reconciled(focus_loss, compute_window_hidden(true, false)),
            None
        );
        assert_eq!(
            tracker.apply_reconciled(focus_loss, compute_window_hidden(true, false)),
            None
        );
        assert_eq!(
            tracker.state(),
            WindowVisibilityState {
                hidden: false,
                revision: 0,
            }
        );

        // Explicit focus/show cancels any pending focus-loss reconcile even when already visible.
        assert_eq!(tracker.set_explicit(false), None);
        assert!(!tracker.is_reconcile_current(focus_loss));
        assert_eq!(tracker.apply_reconciled(focus_loss, true), None);
    }
}
