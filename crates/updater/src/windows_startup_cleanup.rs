use super::*;

impl ProcessEvidence {
    fn matches(&self, process: &ProcessSnapshot) -> bool {
        self.pid == process.id
            && self.started_at_micros.parse::<u64>().ok() == Some(process.started_at_micros)
            && crate::windows_installation::same_path(&self.executable, &process.executable)
    }
}
impl StartupCheck {
    fn record_for_launch(&self) -> Result<Startup, Box<dyn Error>> {
        let origin = self.spawned.as_ref().ok_or("launch origin is not bound")?;
        let bytes = regular(
            &self.data.join("diagnostics/launcher-startup-v1.json"),
            256 * 1024,
        )?
        .ok_or("startup record is missing")?;
        let file: StartupFile = serde_json::from_slice(&bytes)?;
        if file.schema_version != 1 || file.records.len() > 10 {
            return Err("startup record schema is invalid".into());
        }
        let record = file
            .records
            .into_iter()
            .find(|record| {
                record.launcher_version == self.version
                    && record.started_at_ms >= self.started_at
                    && record.outcome != "attached"
                    && if self.npm_parent {
                        record
                            .parent
                            .as_ref()
                            .is_some_and(|parent| parent.matches(origin))
                    } else {
                        record.pid == origin.id
                            && record
                                .started_at_micros
                                .as_deref()
                                .and_then(|value| value.parse::<u64>().ok())
                                == Some(origin.started_at_micros)
                    }
            })
            .ok_or("no startup record belongs to this launch")?;
        let birth = record
            .started_at_micros
            .as_deref()
            .ok_or("Launcher creation identity is missing")?
            .parse::<u64>()?;
        if record.pid == 0 || birth == 0 || (self.npm_parent && record.pid == origin.id) {
            return Err("invalid Launcher creation identity".into());
        }
        match process_snapshot(record.pid) {
            Ok(current)
                if current.started_at_micros != birth
                    || !crate::windows_installation::same_path(
                        &current.executable,
                        &self.launcher,
                    ) =>
            {
                return Err("Launcher PID was reused or belongs to another installation".into());
            }
            Ok(current) if self.npm_parent && current.parent_id != origin.id => {
                return Err("Launcher parent changed".into());
            }
            Ok(_) => {}
            Err(_) if !codexhost_platform::process_exists(record.pid) => {}
            Err(error) => return Err(error.into()),
        }
        Ok(record)
    }
    pub(super) fn startup_failure(&self) -> Option<String> {
        self.record_for_launch()
            .ok()
            .filter(|record| record.outcome == "failed")
            .and_then(|record| record.error)
    }
    /// A late snapshot, empty Job, or persisted cleanup flag cannot certify all
    /// descendants: an intermediate parent may have exited before observation.
    pub(crate) fn stop_failed_launch(&self) -> Result<(), Box<dyn Error>> {
        #[cfg(target_os = "windows")]
        if let Some(job) = &self.job {
            let record = self.record_for_launch()?;
            // A process may exit after pre-resume assignment but before the
            // Launcher publishes its optional confirmation. This caller-owned
            // Job's kernel accounting survives that exit; a fresh empty Job or
            // a foreign persisted key is never a binding witness.
            if record
                .launch_job
                .as_deref()
                .is_some_and(|key| key != job.key())
                || !job.had_bound_processes()?
            {
                return Err(
                    "startup has no confirmed pre-execution binding; recovery blocked".into(),
                );
            }
            job.terminate_and_wait(Duration::from_secs(5))?;
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                let current = self.record_for_launch()?;
                let launcher_gone = !codexhost_platform::process_exists(current.pid);
                let origin = self.spawned.as_ref().ok_or("launch origin missing")?;
                if launcher_gone
                    && (!self.npm_parent || !codexhost_platform::process_exists(origin.id))
                {
                    return Ok(());
                }
                if Instant::now() >= deadline {
                    return Err("caller Job is empty but Launcher/wrapper still holds installation resources".into());
                }
                std::thread::sleep(Duration::from_millis(20));
            }
        }
        Err("startup-failure recovery blocked: activation ownership and pre-execution whole-tree isolation are unverified; no processes terminated; materials retained".into())
    }
}
