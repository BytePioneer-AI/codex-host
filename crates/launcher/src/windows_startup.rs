//! Windows Desktop startup and the single AppX-to-direct retry.

use super::*;
use crate::desktop_attachment::{
    allocate_runtime_control_avoiding, publish_runtime_descriptor,
    wait_for_host_chain_during_startup,
};
use crate::desktop_retry::{CleanupObservation, LaunchPath, wait_for_clean_retry};
use codexhost_platform::{
    PlatformError, WindowsDesktopWatch, launch_windows_managed_desktop, require_no_windows_desktop,
};

const POLL: Duration = Duration::from_millis(50);
const STOP_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Debug)]
struct EarlyExit;

impl std::fmt::Display for EarlyExit {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("owned AppX Desktop exited before startup was ready")
    }
}

impl Error for EarlyExit {}

pub(super) fn supervise_desktop(
    installation: &DesktopInstallation,
    options: &ResolvedLaunchOptions,
    descriptor_path: &Path,
    explicit_direct: bool,
) -> Result<(), Box<dyn Error>> {
    let appx = matches!(
        &installation.identity,
        DesktopIdentity::WindowsPackage {
            appx_activation: Some(_),
            ..
        }
    );
    let path = if appx && !explicit_direct {
        LaunchPath::Appx
    } else {
        LaunchPath::Direct
    };
    let run = |path, control: &RuntimeControl| -> Result<(), Box<dyn Error>> {
        let mut environment = desktop_environment(
            options,
            control,
            &env::current_exe()?.canonicalize()?,
            descriptor_path,
            managed_desktop_data_directory(
                env::var_os(DATA_DIRECTORY_ENV),
                env::var_os(REMOTE_SSH_MANAGED_ENV),
            ),
        );
        environment.extend(codexhost_platform::proxy_environment());
        attempt(
            installation,
            options,
            descriptor_path,
            path,
            control,
            &environment,
        )
    };
    let first = allocate_runtime_control_avoiding(None)?;
    let Err(early) = run(path, &first) else {
        return Ok(());
    };
    if !early.is::<EarlyExit>() {
        return Err(early);
    }
    startup_trace("AppX startup cleaned up; retrying once via direct executable");
    allocate_runtime_control_avoiding(Some(&first))
        .and_then(|retry| run(LaunchPath::Direct, &retry))
        .map_err(|error| format!("{early}; direct executable attempt failed: {error}").into())
}

fn attempt(
    installation: &DesktopInstallation,
    options: &ResolvedLaunchOptions,
    descriptor_path: &Path,
    path: LaunchPath,
    control: &RuntimeControl,
    environment: &[(OsString, OsString)],
) -> Result<(), Box<dyn Error>> {
    startup_trace(match path {
        LaunchPath::Appx => "launching Codex Desktop via AppX debug activation",
        LaunchPath::Direct => "launching Codex Desktop via direct executable",
    });
    let started = Instant::now();
    let args =
        desktop_path_overrides::launch_arguments(&control.renderer_cdp_arguments, environment);
    let mut desktop = launch_windows_managed_desktop(
        installation,
        &options.shim,
        path == LaunchPath::Direct,
        &args,
        environment,
    )?;
    let mut controller = None;
    let mut watch = None;
    let result = (|| -> Result<_, Box<dyn Error>> {
        let root = desktop.snapshot()?;
        watch = Some(WindowsDesktopWatch::new(root.clone()));
        let watch = watch.as_mut().expect("Desktop watch initialized");
        let mut was_visible = false;
        let mut incomplete = false;
        let mut check = || -> Result<(), Box<dyn Error>> {
            match watch.observe(installation) {
                Ok(_) => {}
                Err(error @ PlatformError::UnmanagedDesktopConflict) => return Err(error.into()),
                Err(_) => incomplete = true,
            }
            if path == LaunchPath::Appx && !was_visible {
                match watch.has_visible_window() {
                    Ok(visible) => was_visible = visible,
                    Err(_) => incomplete = true,
                }
            }
            if let Some(status) = desktop.try_wait()? {
                let elapsed = started.elapsed();
                startup_trace(&format!(
                    "Desktop exited during startup after {} ms: {status}",
                    elapsed.as_millis()
                ));
                if !incomplete && path.after_exit(elapsed, was_visible).is_some() {
                    return Err(Box::new(EarlyExit));
                }
                return Err("Codex Desktop exited during startup; not retrying (direct launch, late/visible exit, or incomplete inspection)".into());
            }
            Ok(())
        };
        check()?;
        startup_trace("Codex Desktop launched");
        startup_trace("spawning Desktop Controller");
        let child = controller.insert(spawn_supervised(&mut desktop_controller_command(
            options,
            control,
            environment,
        ))?);
        startup_trace("waiting for Desktop Controller readiness");
        let receiver = controller_readiness_receiver(child)?;
        let readiness_deadline = Instant::now() + Duration::from_secs(120);
        loop {
            check()?;
            let remaining = readiness_deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err("Desktop Controller did not become ready before timeout".into());
            }
            match receiver.recv_timeout(POLL.min(remaining)) {
                Ok(line) => {
                    validate_controller_readiness(&line?)?;
                    break;
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err("Desktop Controller readiness pipe disconnected".into());
                }
            }
        }
        startup_trace("Desktop Controller ready");
        startup_trace("waiting for Host chain");
        if !wait_for_host_chain_during_startup(&root, options, Duration::from_secs(30), &mut check)?
        {
            startup_trace(
                "Host chain timed out without a verified early Desktop exit; no fallback",
            );
            return Err(
                "Codex Desktop did not start the codexhost Host chain before timeout".into(),
            );
        }
        // Do not retry once the chain has been seen, even if Desktop exits before publication.
        watch.observe(installation)?;
        if desktop.try_wait()?.is_some() {
            return Err("Codex Desktop exited after the Host chain started".into());
        }
        startup_trace("Host chain ready");
        let runtime = publish_runtime_descriptor(descriptor_path, control)?;
        startup_trace("runtime descriptor published");
        notify_ready_and_detach()?;
        Ok(runtime)
    })();
    let _runtime = match result {
        Ok(runtime) => runtime,
        Err(error) => {
            // Run both cleanups even if one fails. In particular a process-tree
            // inspection error from the Host wait must not strand Desktop.
            let controller_result = controller.as_mut().map(stop_controller_tree).transpose();
            let desktop_result = stop_owned_desktop(&mut desktop);
            if let Err(cleanup) = controller_result.and(desktop_result) {
                startup_trace("Windows startup cleanup could not be confirmed; no fallback");
                return Err(format!("{error}; cleanup failed: {cleanup}").into());
            }
            if error.is::<EarlyExit>() {
                let watch = watch.as_mut().expect("verified early exit has a watch");
                let cleanup_started = Instant::now();
                match wait_for_clean_retry(
                    || cleanup_started.elapsed(),
                    || match watch.observe(installation) {
                        Ok(true) => Ok(CleanupObservation::Residual),
                        Ok(false) => Ok(CleanupObservation::Empty),
                        Err(PlatformError::UnmanagedDesktopConflict) => {
                            Ok(CleanupObservation::Conflict)
                        }
                        Err(error) => Err(error),
                    },
                    thread::sleep,
                ) {
                    Ok(CleanupObservation::Empty) => {
                        if update_waiting_for_launcher_exit().map_err(|update| {
                            format!("{error}; no fallback: cannot verify update handoff: {update}")
                        })? {
                            return Err(
                                format!("{error}; no fallback during update handoff").into()
                            );
                        }
                        require_no_windows_desktop(installation)
                            .map_err(|conflict| format!("{error}; no fallback: {conflict}"))?;
                    }
                    Ok(CleanupObservation::Residual) => {
                        return Err(format!(
                            "{error}; no fallback: Desktop descendants did not exit"
                        )
                        .into());
                    }
                    Ok(CleanupObservation::Conflict) => {
                        return Err(format!(
                            "{error}; no fallback: {}",
                            PlatformError::UnmanagedDesktopConflict
                        )
                        .into());
                    }
                    Err(observation) => {
                        return Err(format!(
                            "{error}; no fallback: cleanup inspection failed: {observation}"
                        )
                        .into());
                    }
                }
            }
            return Err(error);
        }
    };
    drop(watch);
    let mut controller = controller.expect("startup published with a Controller");
    supervise_ready_desktop(&mut desktop, &mut controller)
}

fn stop_controller_tree(controller: &mut SupervisedChild) -> Result<(), Box<dyn Error>> {
    startup_trace("cleaning up Desktop Controller and its Job");
    if controller.has_live_processes()?
        && let Err(error) = controller.force_terminate()
        && controller.has_live_processes()?
    {
        return Err(error.into());
    }
    controller.wait_for_tree_exit(STOP_TIMEOUT)?;
    Ok(())
}

fn stop_owned_desktop(desktop: &mut DesktopProcess) -> Result<(), Box<dyn Error>> {
    if desktop.try_wait()?.is_none() {
        if let Err(error) = desktop.kill()
            && desktop.try_wait()?.is_none()
        {
            return Err(error.into());
        }
        if wait_for_desktop_exit(desktop, STOP_TIMEOUT)?.is_none() {
            return Err("owned Desktop did not exit after termination".into());
        }
    }
    Ok(())
}

#[cfg(test)]
#[test]
fn startup_cleanup_waits_for_the_controller_job_and_root() {
    let mut command = Command::new("cmd.exe");
    command.args(["/d", "/c", "ping", "-n", "30", "127.0.0.1", ">nul"]);
    configure_background_command(&mut command);
    let mut controller = spawn_supervised(&mut command).expect("spawn Controller fixture");
    stop_controller_tree(&mut controller).expect("confirm startup cleanup");
    assert!(controller.try_wait().unwrap().is_some());
    assert!(!controller.has_live_processes().unwrap());
}

fn supervise_ready_desktop(
    desktop: &mut DesktopProcess,
    controller: &mut SupervisedChild,
) -> Result<(), Box<dyn Error>> {
    let mut started_update_request = None;
    loop {
        if let Err(error) = start_pending_update(&mut started_update_request) {
            eprintln!("codexhost launcher: pending update could not be started: {error}");
        }
        if should_stop_desktop_for_update(started_update_request.is_some()) {
            if let Err(error) = stop_managed_desktop_for_update(desktop, controller) {
                eprintln!(
                    "codexhost launcher: managed Desktop could not be stopped for update: {error}"
                );
            } else {
                return Ok(());
            }
        }
        if let Some(status) = controller.try_wait()? {
            if let Some(desktop_status) = wait_for_desktop_exit(desktop, Duration::from_secs(1))? {
                if desktop_status.success() {
                    return Ok(());
                }
                return Err(
                    format!("Codex Desktop exited unsuccessfully: {desktop_status}").into(),
                );
            }
            let _ = stop_owned_desktop(desktop);
            return Err(
                format!("Desktop Controller exited while Desktop was running: {status}").into(),
            );
        }
        if let Some(status) = desktop.try_wait()? {
            stop_desktop_controller(controller)?;
            if !status.success() {
                return Err(format!("Codex Desktop exited unsuccessfully: {status}").into());
            }
            return Ok(());
        }
        thread::sleep(Duration::from_millis(100));
    }
}
