//! Windows apply ordering. Effects are native boundaries, not persisted states or policy switches.
use crate::{
    operation_lock::OperationLock,
    request::{Installation, UpdateRequest},
    status::{Outcome, write_result, write_status},
    windows_launch::LaunchFailure,
};
use std::error::Error;
#[cfg(target_os = "windows")]
use std::path::Path;
type Result<T> = std::result::Result<T, Box<dyn Error>>;

pub(super) trait Effects {
    fn handoff(&mut self, request: &UpdateRequest) -> Result<OperationLock>;
    fn install(
        &mut self,
        request: &UpdateRequest,
        before_write: &mut dyn FnMut() -> Result<()>,
    ) -> Result<()>;
    fn quiescent(&mut self, request: &UpdateRequest) -> Result<()>;
    fn restore_files(&mut self, request: &UpdateRequest) -> Result<UpdateRequest>;
    fn launch(&mut self, request: &UpdateRequest) -> std::result::Result<(), LaunchFailure>;
}

fn stopped_install_tool(request: &UpdateRequest, error: &(dyn Error + 'static)) -> bool {
    match &request.installation {
        Installation::Npm(_) => error
            .downcast_ref::<crate::npm_prepared::InstallFailure>()
            .is_some_and(|f| f.tool_stopped),
        Installation::WindowsInstaller(_) => error
            .downcast_ref::<crate::installer_recovery::ToolFailure>()
            .is_some_and(crate::installer_recovery::ToolFailure::may_restore),
        _ => false,
    }
}
fn recover(
    request: &UpdateRequest,
    ownership: &mut OperationLock,
    reason: &str,
    effects: &mut impl Effects,
) -> Result<()> {
    let result = (|| {
        effects.quiescent(request)?;
        let previous = effects.restore_files(request)?;
        write_status(request, "restarting", None)?;
        effects.launch(&previous).map_err(|e| Box::<dyn Error>::from(format!("original software restored, but original-version launch failed: {e}; recovery is not retried")))
    })();
    match result {
        Ok(()) => {
            let message =
                format!("update failed: {reason}; original version restored and its Host is ready");
            write_result(request, "failed", Some(&message), Outcome::Restored)?;
            ownership.finish()?;
            Err(message.into())
        }
        Err(error) => {
            let message = format!(
                "update failed: {reason}; original-channel recovery failed: {error}; materials retained"
            );
            write_result(request, "failed", Some(&message), Outcome::RecoveryFailed)?;
            Err(message.into())
        }
    }
}
pub(super) fn execute(request: &UpdateRequest, effects: &mut impl Effects) -> Result<()> {
    let mut installation_started = false;
    let result = (|| {
        let mut ownership = effects.handoff(request)?;
        if let Err(error) = effects.install(request, &mut || {
            write_status(request, "installing", None)?;
            ownership.mark_installing()?;
            installation_started = true;
            Ok(())
        }) {
            if stopped_install_tool(request, error.as_ref()) {
                return recover(request, &mut ownership, &error.to_string(), effects);
            }
            return Err(error);
        }
        write_status(request, "restarting", None)?;
        if let Err(error) = effects.launch(request) {
            if error.may_restore() {
                return recover(request, &mut ownership, &error.to_string(), effects);
            }
            return Err(error.into());
        }
        write_result(request, "succeeded", None, Outcome::Updated)?;
        ownership.finish()?;
        Ok(())
    })();
    if let Err(error) = &result {
        if installation_started {
            let _ = crate::status::write_failure(request, &error.to_string());
        } else {
            let _ = write_status(request, "failed", Some(&error.to_string()));
        }
    }
    result
}
#[cfg(target_os = "windows")]
pub(super) fn apply(path: &Path) -> Result<()> {
    // Identity and prepared-material validation precede handoff.
    // Effects cannot be chosen through requests or environment.
    let request = UpdateRequest::parse(path)?;
    execute(&request, &mut Native)
}
#[cfg(target_os = "windows")]
struct Native;
#[cfg(target_os = "windows")]
impl Effects for Native {
    fn handoff(&mut self, r: &UpdateRequest) -> Result<OperationLock> {
        let lock = crate::wait_for_launcher_exit(r)?;
        if let Installation::Npm(npm) = &r.installation {
            crate::npm_processes::shutdown(npm)?;
        }
        Ok(lock)
    }
    fn install(
        &mut self,
        r: &UpdateRequest,
        before_write: &mut dyn FnMut() -> Result<()>,
    ) -> Result<()> {
        crate::install::install(r, before_write)
    }
    fn quiescent(&mut self, r: &UpdateRequest) -> Result<()> {
        match &r.installation {
            Installation::Npm(npm) => crate::npm_processes::ensure_quiescent(npm),
            Installation::WindowsInstaller(w) => {
                codexhost_platform::WindowsLaunchJob::ensure_no_images_under(&w.install_root)?;
                Ok(())
            }
            _ => Err("no original-channel recovery for this installation".into()),
        }
    }
    fn restore_files(&mut self, r: &UpdateRequest) -> Result<UpdateRequest> {
        let version = match &r.installation {
            Installation::Npm(_) => crate::npm_recovery::restore_files(r)?,
            Installation::WindowsInstaller(_) => crate::installer_recovery::restore_files(r)?,
            _ => return Err("no original-channel recovery for this installation".into()),
        };
        let mut previous = r.clone();
        previous.version = version;
        Ok(previous)
    }
    fn launch(&mut self, r: &UpdateRequest) -> std::result::Result<(), LaunchFailure> {
        crate::windows_launch::launch(r)
    }
}
#[cfg(test)]
#[path = "windows_apply_tests.rs"]
mod tests;
