//! Protected update launch. The automatic-update acceptance gates remain in
//! place until the MSIX fixture verifies the native pre-resume binding.
use super::*;
use codexhost_platform::{WindowsLaunchJob, launch_desktop_in_job};

pub(super) fn launch(options: LaunchOptions) -> Result<(), Box<dyn Error>> {
    let job = WindowsLaunchJob::open(
        options
            .update_job
            .as_deref()
            .ok_or("protected launch requires its caller-held Job")?,
    )?;
    if !job.is_empty()? {
        return Err("protected launch requires a fresh empty caller Job".into());
    }
    let options = options.resolve()?;
    let installation = discover_desktop(options.custom_install_root.as_deref())?;
    // Do not attach, remove descriptors, or force another Launcher/Desktop out.
    let guard_path = runtime_instance::default_guard_path()?;
    let _guard = runtime_instance::try_acquire_launcher_guard(&guard_path)?
        .ok_or("another Launcher owns this Desktop; existing instance preserved")?;
    if !desktop_root_process_ids_for_installation(&installation)?.is_empty() {
        return Err("independent Desktop is running; instance preserved".into());
    }
    let descriptor_path = default_descriptor_path()?;
    if read_descriptor(&descriptor_path)?.is_some() {
        return Err("runtime descriptor must be resolved before protected launch; no existing process changed".into());
    }
    let control = allocate_runtime_control()?;
    // This caller-created key is NOT the package-wide RuntimeControl environment nonce.
    startup_record::desktop(
        &installation.version,
        &installation.build,
        &installation.install_root,
    );
    let mut environment = desktop_environment(
        &options,
        &control,
        &env::current_exe()?.canonicalize()?,
        &descriptor_path,
        managed_desktop_data_directory(
            env::var_os(DATA_DIRECTORY_ENV),
            env::var_os(REMOTE_SSH_MANAGED_ENV),
        ),
    );
    // Denial-only inherited hint: a directly spawned update helper checks real
    // kernel membership and refuses handoff if it inherited this old Job.
    environment.push((
        codexhost_platform::DESKTOP_LAUNCH_JOB_ENV.into(),
        job.key().into(),
    ));
    let arguments =
        desktop_path_overrides::launch_arguments(&control.renderer_cdp_arguments, &environment);
    let result = (|| -> Result<(), Box<dyn Error>> {
        // The resume helper assigns only the argument-bound initial process,
        // before execution. A reused/foreign activation PID is never killed.
        let mut desktop =
            launch_desktop_in_job(&installation, &options.shim, &arguments, &environment, &job)?;
        if !desktop.is_in_job(&job)? {
            return Err("Desktop did not join the pre-execution Job".into());
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let roots = desktop_root_process_ids_for_installation(&installation)?;
            if roots.iter().any(|pid| *pid != desktop.id()) {
                return Err("concurrent independent Desktop preserved".into());
            }
            if roots.contains(&desktop.id()) {
                break;
            }
            if desktop.try_wait()?.is_some() || Instant::now() >= deadline {
                return Err("owned Desktop root was not established before timeout".into());
            }
            thread::sleep(Duration::from_millis(20));
        }
        startup_record::launch_job(job.key());
        let mut controller = job.spawn_supervised(&mut desktop_controller_command(
            &options,
            &control,
            &environment,
        ))?;
        wait_for_controller_ready(&mut controller, Duration::from_secs(30))?;
        if !wait_for_host_chain(desktop.id(), &options, Duration::from_secs(30))? {
            return Err("protected Host chain did not become ready".into());
        }
        let _runtime = publish_runtime_descriptor(&descriptor_path, &control)?;
        notify_ready_and_detach()?;
        let mut started_update_request = None;
        loop {
            if let Err(error) = start_pending_update(&mut started_update_request, Some(&job)) {
                eprintln!("codexhost launcher: update handoff failed; Desktop preserved: {error}");
            }
            match active_update::waiting_outside_desktop_job(&job) {
                Ok(true) => return Ok(()),
                Ok(false) => {}
                Err(error) => eprintln!("codexhost launcher: update cleanup refused: {error}"),
            }
            if let Some(status) = controller.try_wait()? {
                return Err(format!("protected Controller exited: {status}").into());
            }
            if let Some(status) = desktop.try_wait()? {
                return if status.success() {
                    Ok(())
                } else {
                    Err(format!("protected Desktop exited: {status}").into())
                };
            }
            thread::sleep(Duration::from_millis(50));
        }
    })();
    // Both Desktop and Controller joined this same Job before their code ran.
    // A root's exit or an arbitrary persisted flag is not a cleanup witness.
    job.terminate_and_wait(Duration::from_secs(5))?;
    result
}
