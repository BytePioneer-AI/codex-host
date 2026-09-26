//! Coordinate the live Updater with shutdown of the Desktop it owns.

use std::error::Error;
use std::io;
use std::time::Duration;

use codexhost_platform::SupervisedChild;

#[cfg(any(target_os = "macos", target_os = "windows"))]
use crate::active_update::{StartedUpdate, start_pending_update};
use crate::stop_desktop_controller;

/// `Err` means cancellation has not finished: the Launcher must stay alive so
/// that its Updater cannot start installation through the ordinary exit path.
#[cfg(any(target_os = "macos", target_os = "windows"))]
pub(crate) fn poll_pending_update(
    started: &mut Option<StartedUpdate>,
    stop: impl FnOnce(&mut StartedUpdate) -> Result<(), Box<dyn Error>>,
) -> io::Result<bool> {
    let result = (|| {
        start_pending_update(started)?;
        let Some(update) = started.as_mut() else {
            return Ok(false);
        };
        if !update.waiting_for_launcher_exit()? {
            return Ok(false);
        }
        stop(update).map_err(|error| io::Error::other(error.to_string()))?;
        if !update.waiting_for_launcher_exit()? {
            return Err(io::Error::other(
                "Updater stopped waiting before Launcher exit",
            ));
        }
        Ok(true)
    })();
    match result {
        Ok(ready) => Ok(ready),
        Err(error) => {
            eprintln!("codexhost launcher: update handoff failed: {error}");
            if let Some(update) = started.as_mut() {
                update.abort(&error)?;
            }
            Ok(false)
        }
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
pub(crate) fn stop_managed_desktop_for_update(
    desktop: &mut codexhost_platform::DesktopSession,
    controller: &mut SupervisedChild,
    mut still_waiting: impl FnMut() -> io::Result<bool>,
) -> Result<(), Box<dyn Error>> {
    if !still_waiting()? {
        return Err("Updater is no longer waiting for Launcher exit".into());
    }
    stop_desktop_controller(controller)?;
    if !still_waiting()? {
        return Err("Updater stopped waiting before managed Desktop exit".into());
    }
    desktop.shutdown(Duration::from_secs(2))?;
    desktop.cleanup_escaped(Duration::from_secs(2))?;
    desktop.disarm_cleanup();
    Ok(())
}

#[cfg(target_os = "windows")]
pub(crate) fn stop_managed_desktop_for_update(
    desktop: &mut codexhost_platform::DesktopProcess,
    root: &codexhost_platform::ProcessSnapshot,
    installation: &codexhost_platform::DesktopInstallation,
    controller: &mut SupervisedChild,
    options: &crate::ResolvedLaunchOptions,
    mut still_waiting: impl FnMut() -> io::Result<bool>,
) -> Result<(), Box<dyn Error>> {
    use codexhost_platform::{
        descendant_process_snapshots, process_instance_exists, running_executable_snapshots,
        terminate_process_instance,
    };
    use std::thread;
    use std::time::Instant;

    // A path identifies an executable, not its owner. In particular npm uses
    // the shared system Node. Never turn a failed ancestry check into a sweep.
    let descendants = descendant_process_snapshots(root, &[&options.shim, &options.node])?;
    if !still_waiting()? {
        return Err("Updater is no longer waiting for Launcher exit".into());
    }
    if desktop.try_wait()?.is_none()
        && let Err(error) = desktop.kill()
        && desktop.try_wait()?.is_none()
    {
        return Err(error.into());
    }
    desktop.wait()?;
    let started = Instant::now();
    loop {
        if !still_waiting()? {
            return Err("Updater stopped waiting during managed Desktop shutdown".into());
        }
        let mut descendants_alive = false;
        for captured in &descendants {
            if process_instance_exists(captured.id, captured.started_at_micros)? {
                descendants_alive = true;
                terminate_process_instance(captured, true)?;
            }
        }
        if !descendants_alive {
            break;
        }
        if started.elapsed() >= Duration::from_secs(10) {
            return Err("managed Desktop descendants remained alive after root exit".into());
        }
        thread::sleep(Duration::from_millis(100));
    }
    if !still_waiting()? {
        return Err("Updater stopped waiting before managed Host exit".into());
    }
    stop_desktop_controller(controller)?;
    let bundled_node =
        crate::installation_layout::InstalledResources::from_current_executable()?.node;
    let executables = installation_executables(
        &installation.desktop_executable,
        &options.shim,
        &options.node,
        &bundled_node,
    )?;
    if !running_executable_snapshots(&executables)?.is_empty() {
        return Err("installation-owned Desktop, Shim, or Host processes remain alive".into());
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn installation_executables<'a>(
    desktop: &'a std::path::Path,
    shim: &'a std::path::Path,
    node: &'a std::path::Path,
    bundled_node: &std::path::Path,
) -> io::Result<Vec<&'a std::path::Path>> {
    let mut executables = vec![desktop, shim];
    match bundled_node.canonicalize() {
        Ok(bundled) if node.canonicalize()? == bundled => executables.push(node),
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    Ok(executables)
}

#[cfg(all(test, target_os = "windows"))]
mod tests;
