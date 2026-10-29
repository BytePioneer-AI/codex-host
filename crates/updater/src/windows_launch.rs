//! Recovery eligibility follows the actual spawn boundary, not an empty Job.
use std::{error::Error, fmt, io};
#[derive(Debug)]
pub(crate) enum LaunchFailure {
    NoChild(io::Error),
    OwnedLaunchStopped(String),
    Unproven(String),
}
impl LaunchFailure {
    #[cfg(target_os = "windows")]
    fn binding(error: Box<dyn Error>) -> Self {
        Self::Unproven(format!("child may be running; bind: {error}"))
    }
    pub(crate) fn may_restore(&self) -> bool {
        matches!(self, Self::NoChild(_) | Self::OwnedLaunchStopped(_))
    }
}
impl fmt::Display for LaunchFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NoChild(e) => {
                write!(f, "launcher spawn failed before any child was created: {e}")
            }
            Self::OwnedLaunchStopped(e) => {
                write!(f, "launcher readiness failed; owned launch stopped: {e}")
            }
            Self::Unproven(e) => write!(
                f,
                "launch state unproven; recovery blocked and materials retained: {e}"
            ),
        }
    }
}
impl Error for LaunchFailure {}
#[cfg(target_os = "windows")]
pub(crate) fn launch(request: &crate::request::UpdateRequest) -> Result<(), LaunchFailure> {
    let mut startup = crate::windows_ready::StartupCheck::capture(request)
        .map_err(|e| LaunchFailure::Unproven(format!("capture: {e}")))?;
    let key = startup
        .job_key()
        .map_err(|e| LaunchFailure::Unproven(format!("Job setup: {e}")))?;
    // relaunch_in_job has only one fallible operation: Windows Command::spawn.
    // Its io::Err comes from failed CreateProcess, not a later bind/wait error.
    let child = crate::install::relaunch_in_job(request, key).map_err(LaunchFailure::NoChild)?;
    startup.bind(&child).map_err(LaunchFailure::binding)?;
    if let Err(error) = startup.wait(std::time::Duration::from_secs(30)) {
        return match startup.stop_failed_launch() {
            Ok(()) => Err(LaunchFailure::OwnedLaunchStopped(error.to_string())),
            Err(cleanup) => Err(LaunchFailure::Unproven(format!(
                "{error}; cleanup: {cleanup}"
            ))),
        };
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_no_child_or_proven_owned_cleanup_allows_restore() {
        assert!(
            LaunchFailure::NoChild(io::Error::from(io::ErrorKind::PermissionDenied)).may_restore()
        );
        assert!(LaunchFailure::OwnedLaunchStopped("timeout".into()).may_restore());
        for stage in ["capture", "Job setup", "bind", "cleanup"] {
            let error = LaunchFailure::Unproven(stage.into());
            assert!(!error.may_restore());
            assert!(error.to_string().contains("materials retained"));
        }
    }
    #[cfg(target_os = "windows")]
    #[test]
    fn actual_bind_failure_with_a_live_wrong_image_never_allows_restore() {
        use std::{fs, process::Command};
        let key = codexhost_platform::WindowsLaunchJob::create_unique().unwrap();
        let root = std::env::temp_dir().join(format!("codexhost-bind-{}", key.key()));
        fs::create_dir_all(root.join("app")).unwrap();
        fs::create_dir_all(root.join("bin")).unwrap();
        fs::create_dir_all(root.join("runtime")).unwrap();
        fs::copy(
            std::env::current_exe().unwrap(),
            root.join("bin/codexhost.exe"),
        )
        .unwrap();
        fs::write(root.join("app/host-runtime.mjs"), "fixture").unwrap();
        fs::write(root.join("runtime/node.exe"), "fixture").unwrap();
        fs::write(root.join("app/codexhost-distribution.json"),serde_json::json!({"schemaVersion":1,"version":"1.2.4","distribution":"installer","target":format!("windows-{}",crate::windows_installation::architecture())}).to_string()).unwrap();
        let request:crate::request::UpdateRequest=serde_json::from_value(serde_json::json!({"schema_version":1,"version":"1.2.4","wait_pid":1,"wait_executable":root.join("bin/codexhost.exe"),"wait_started_at_micros":"1","runtime_descriptor_path":root.join("runtime.json"),"status_path":root.join("status.json"),"installation":{"kind":"windows-installer","installer_path":root.join("unused.exe"),"artifact_sha256":"ab".repeat(32),"install_root":root,"installed_version":"1.2.3"}})).unwrap();
        let mut startup = crate::windows_ready::StartupCheck::capture(&request).unwrap();
        struct Stop(std::process::Child);
        impl Drop for Stop {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        let mut child = Stop(
            Command::new("node")
                .args(["-e", "setInterval(()=>{},1000)"])
                .spawn()
                .unwrap(),
        );
        let error = startup
            .bind(&child.0)
            .map_err(LaunchFailure::binding)
            .unwrap_err();
        assert!(!error.may_restore());
        assert!(child.0.try_wait().unwrap().is_none());
        drop(child);
        drop(startup);
        fs::remove_dir_all(root).unwrap();
    }
    #[cfg(target_os = "windows")]
    #[test]
    fn actual_missing_launcher_spawn_creates_no_child_and_preserves_a_foreign_process() {
        use std::process::Command;
        let job = codexhost_platform::WindowsLaunchJob::create_unique().unwrap();
        let missing = std::env::temp_dir().join(format!("codexhost-missing-{}", job.key()));
        struct Stop(std::process::Child);
        impl Drop for Stop {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        let mut foreign = Stop(
            Command::new("node")
                .args(["-e", "setInterval(()=>{},1000)"])
                .spawn()
                .unwrap(),
        );
        let request:crate::request::UpdateRequest=serde_json::from_value(serde_json::json!({
            "schema_version":1,"version":"1.2.4","wait_pid":1,"wait_executable":missing.join("bin/codexhost.exe"),
            "wait_started_at_micros":"1","runtime_descriptor_path":missing.join("runtime.json"),"status_path":missing.join("status.json"),
            "installation":{"kind":"windows-installer","installer_path":missing.join("unused.exe"),"artifact_sha256":"ab".repeat(32),"install_root":missing,"installed_version":"1.2.3"}
        })).unwrap();
        let capture_failure = launch(&request).unwrap_err();
        assert!(!capture_failure.may_restore());
        let result = crate::install::relaunch_in_job(&request, job.key());
        assert!(result.is_err());
        let failure = result.map_err(LaunchFailure::NoChild).unwrap_err();
        assert!(failure.may_restore());
        assert!(job.is_empty().unwrap());
        assert!(!job.had_bound_processes().unwrap());
        assert!(foreign.0.try_wait().unwrap().is_none());
    }
}
