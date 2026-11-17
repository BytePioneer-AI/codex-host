//! Exact descendant ownership retained across forced supervisor termination.
use crate::process::{ObservedProcessTree, unix_process_snapshot};
use crate::{PlatformError, ProcessIdentity};

/// Observes descendants while their parent links still exist. Never claims a
/// supervisor's entire process group: it may also contain the invoking shell.
pub struct ShutdownProcessTree {
    tree: ObservedProcessTree,
}

impl ShutdownProcessTree {
    pub fn capture(expected: &ProcessIdentity) -> Result<Option<Self>, PlatformError> {
        let root = match unix_process_snapshot(expected.id) {
            Ok(root) => root,
            Err(PlatformError::NotFound(_)) => return Ok(None),
            Err(error) => return Err(error),
        };
        if root.started_at_micros != expected.started_at_micros {
            return Err(PlatformError::Invalid(format!(
                "PID {} was reused before shutdown observation",
                expected.id
            )));
        }
        let mut tree = ObservedProcessTree::new_with_process_group(root, None, None);
        tree.observe()?;
        if !tree.root_is_current()? {
            return Err(PlatformError::Invalid(
                "Shutdown root disappeared during observation; descendants cannot be verified"
                    .into(),
            ));
        }
        Ok(Some(Self { tree }))
    }

    pub fn has_live_processes(&mut self) -> Result<bool, PlatformError> {
        Ok(!self.tree.observe()?.is_empty())
    }

    pub fn exclude_process(&mut self, identity: ProcessIdentity) {
        self.tree.exclude_process(identity);
    }

    pub fn force_terminate(&mut self) -> Result<(), PlatformError> {
        self.tree.signal_exact(nix::sys::signal::Signal::SIGKILL)
    }
}
