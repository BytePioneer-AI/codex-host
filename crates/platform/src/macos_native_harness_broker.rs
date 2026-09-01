use std::path::{Path, PathBuf};

#[cfg(target_os = "macos")]
use std::fs::{self, OpenOptions};
#[cfg(target_os = "macos")]
use std::io::Write;
#[cfg(target_os = "macos")]
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
#[cfg(target_os = "macos")]
use std::process::{Command, Output};
#[cfg(target_os = "macos")]
use std::thread;
#[cfg(target_os = "macos")]
use std::time::{Duration, Instant};

#[cfg(target_os = "macos")]
use sha2::{Digest, Sha256};

use crate::PlatformError;

pub const NATIVE_HARNESS_BROKER_LABEL: &str = "ai.bytepioneer.codexhost.native-harness-broker";
const NATIVE_HARNESS_BROKER_ARGUMENT: &str = "--codexhost-harness-broker";
const NATIVE_HARNESS_BROKER_THROTTLE_SECONDS: u32 = 10;

#[derive(Debug, Clone, Copy)]
pub struct NativeHarnessBrokerPaths<'a> {
    pub home: &'a Path,
    pub node: &'a Path,
    pub host_runtime: &'a Path,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeHarnessBrokerLaunchAgentPlan {
    pub label: &'static str,
    pub launchctl_domain: String,
    pub launchctl_target: String,
    pub plist_path: PathBuf,
    pub broker_directory: PathBuf,
    pub descriptor_path: PathBuf,
    pub program_arguments: [String; 3],
    pub plist_xml: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeHarnessBrokerCommand {
    pub program: &'static str,
    pub arguments: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeHarnessBrokerLaunchctlPlan {
    pub print: NativeHarnessBrokerCommand,
    pub bootstrap: NativeHarnessBrokerCommand,
    pub bootout: NativeHarnessBrokerCommand,
    pub kickstart: NativeHarnessBrokerCommand,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NativeHarnessBrokerObservedState {
    NotLoaded,
    LoadedStopped,
    Running,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NativeHarnessBrokerInstallStep {
    Bootout,
    WritePlist,
    Bootstrap,
    Kickstart,
}

#[cfg(target_os = "macos")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NativeHarnessBrokerInstallOutcome {
    AlreadyRunning,
    Started,
    Installed,
    Reinstalled,
}

#[cfg(target_os = "macos")]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeHarnessBrokerStatus {
    pub label: &'static str,
    pub launchctl_target: String,
    pub plist_path: PathBuf,
    pub observed: NativeHarnessBrokerObservedState,
    pub plist_matches: bool,
    pub descriptor_ready: bool,
}

fn required_absolute_path(path: &Path, label: &str) -> Result<String, PlatformError> {
    let value = path.to_str().ok_or_else(|| {
        PlatformError::Invalid(format!(
            "{label} must be valid UTF-8 for a LaunchAgent property list: {}",
            path.display()
        ))
    })?;
    if !value.starts_with('/') {
        return Err(PlatformError::Invalid(format!(
            "{label} must be an absolute path: {}",
            path.display()
        )));
    }
    Ok(value.to_owned())
}

fn xml_text(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

pub fn plan_native_harness_broker_launch_agent(
    paths: NativeHarnessBrokerPaths<'_>,
    console_uid: u32,
) -> Result<NativeHarnessBrokerLaunchAgentPlan, PlatformError> {
    plan_native_harness_broker_launch_agent_with_environment(paths, console_uid, &[])
}

fn launch_agent_environment_xml(environment: &[(String, String)]) -> Result<String, PlatformError> {
    const ALLOWED: [&str; 9] = [
        "HTTP_PROXY",
        "http_proxy",
        "HTTPS_PROXY",
        "https_proxy",
        "ALL_PROXY",
        "all_proxy",
        "NO_PROXY",
        "no_proxy",
        "NODE_USE_ENV_PROXY",
    ];
    if environment.is_empty() {
        return Ok(String::new());
    }
    let mut values = environment.to_vec();
    values.sort_by(|left, right| left.0.cmp(&right.0));
    let mut prior: Option<String> = None;
    let mut xml = String::from("<key>EnvironmentVariables</key>\n<dict>\n");
    for (name, value) in values {
        if !ALLOWED.contains(&name.as_str()) {
            return Err(PlatformError::Invalid(format!(
                "native Harness broker environment variable is not allowlisted: {name}"
            )));
        }
        if prior.as_deref() == Some(name.as_str()) {
            return Err(PlatformError::Invalid(format!(
                "native Harness broker environment variable is duplicated: {name}"
            )));
        }
        let proxy_variable = matches!(
            name.as_str(),
            "HTTP_PROXY" | "http_proxy" | "HTTPS_PROXY" | "https_proxy" | "ALL_PROXY" | "all_proxy"
        );
        if proxy_variable && value.contains('@') {
            return Err(PlatformError::Invalid(format!(
                "native Harness broker will not persist proxy credentials from {name}"
            )));
        }
        if name == "NODE_USE_ENV_PROXY" && value != "0" && value != "1" {
            return Err(PlatformError::Invalid(
                "NODE_USE_ENV_PROXY must be either 0 or 1".to_owned(),
            ));
        }
        xml.push_str(&format!(
            "<key>{}</key>\n<string>{}</string>\n",
            xml_text(&name),
            xml_text(&value)
        ));
        prior = Some(name);
    }
    xml.push_str("</dict>\n");
    Ok(xml)
}

pub fn plan_native_harness_broker_launch_agent_with_environment(
    paths: NativeHarnessBrokerPaths<'_>,
    console_uid: u32,
    environment: &[(String, String)],
) -> Result<NativeHarnessBrokerLaunchAgentPlan, PlatformError> {
    if console_uid == 0 {
        return Err(PlatformError::Invalid(
            "the macOS Aqua console user must not be root".to_owned(),
        ));
    }
    required_absolute_path(paths.home, "user home")?;
    let node = required_absolute_path(paths.node, "packaged Node.js runtime")?;
    let host_runtime = required_absolute_path(paths.host_runtime, "packaged Host Runtime")?;
    let launchctl_domain = format!("gui/{console_uid}");
    let launchctl_target = format!("{launchctl_domain}/{NATIVE_HARNESS_BROKER_LABEL}");
    let plist_path = paths
        .home
        .join("Library/LaunchAgents")
        .join(format!("{NATIVE_HARNESS_BROKER_LABEL}.plist"));
    let broker_directory = paths.home.join(".codexhost/harness-broker");
    let descriptor_path = broker_directory.join("claude-code-broker-v1.json");
    let program_arguments = [
        node,
        host_runtime,
        NATIVE_HARNESS_BROKER_ARGUMENT.to_owned(),
    ];
    let environment_xml = launch_agent_environment_xml(environment)?;
    let plist_xml = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"https://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n\
<plist version=\"1.0\">\n\
<dict>\n\
  <key>Label</key>\n\
  <string>{}</string>\n\
  <key>ProgramArguments</key>\n\
  <array>\n\
    <string>{}</string>\n\
    <string>{}</string>\n\
    <string>{}</string>\n\
  </array>\n\
  <key>LimitLoadToSessionType</key>\n\
  <string>Aqua</string>\n\
  <key>RunAtLoad</key>\n\
  <true/>\n\
  <key>ThrottleInterval</key>\n\
  <integer>{NATIVE_HARNESS_BROKER_THROTTLE_SECONDS}</integer>\n\
  <key>ProcessType</key>\n\
  <string>Interactive</string>\n\
{}\
  <key>StandardOutPath</key>\n\
  <string>/dev/null</string>\n\
  <key>StandardErrorPath</key>\n\
  <string>/dev/null</string>\n\
</dict>\n\
</plist>\n",
        xml_text(NATIVE_HARNESS_BROKER_LABEL),
        xml_text(&program_arguments[0]),
        xml_text(&program_arguments[1]),
        xml_text(&program_arguments[2]),
        environment_xml,
    );
    Ok(NativeHarnessBrokerLaunchAgentPlan {
        label: NATIVE_HARNESS_BROKER_LABEL,
        launchctl_domain,
        launchctl_target,
        plist_path,
        broker_directory,
        descriptor_path,
        program_arguments,
        plist_xml,
    })
}

pub fn plan_native_harness_broker_launchctl(
    console_uid: u32,
    plist_path: &Path,
) -> Result<NativeHarnessBrokerLaunchctlPlan, PlatformError> {
    if console_uid == 0 {
        return Err(PlatformError::Invalid(
            "the macOS Aqua console user must not be root".to_owned(),
        ));
    }
    let plist_path = required_absolute_path(plist_path, "LaunchAgent property list")?;
    let domain = format!("gui/{console_uid}");
    let target = format!("{domain}/{NATIVE_HARNESS_BROKER_LABEL}");
    let command = |arguments: Vec<String>| NativeHarnessBrokerCommand {
        program: "/bin/launchctl",
        arguments,
    };
    Ok(NativeHarnessBrokerLaunchctlPlan {
        print: command(vec!["print".to_owned(), target.clone()]),
        bootstrap: command(vec!["bootstrap".to_owned(), domain, plist_path]),
        bootout: command(vec!["bootout".to_owned(), target.clone()]),
        kickstart: command(vec!["kickstart".to_owned(), "-k".to_owned(), target]),
    })
}

#[must_use]
pub fn plan_native_harness_broker_install(
    plist_matches: bool,
    observed: NativeHarnessBrokerObservedState,
) -> Vec<NativeHarnessBrokerInstallStep> {
    match (plist_matches, observed) {
        (true, NativeHarnessBrokerObservedState::Running) => {
            vec![NativeHarnessBrokerInstallStep::Kickstart]
        }
        (true, NativeHarnessBrokerObservedState::LoadedStopped) => {
            vec![NativeHarnessBrokerInstallStep::Kickstart]
        }
        (true, NativeHarnessBrokerObservedState::NotLoaded) => {
            vec![NativeHarnessBrokerInstallStep::Bootstrap]
        }
        (false, NativeHarnessBrokerObservedState::NotLoaded) => vec![
            NativeHarnessBrokerInstallStep::WritePlist,
            NativeHarnessBrokerInstallStep::Bootstrap,
        ],
        (false, NativeHarnessBrokerObservedState::LoadedStopped)
        | (false, NativeHarnessBrokerObservedState::Running) => vec![
            NativeHarnessBrokerInstallStep::Bootout,
            NativeHarnessBrokerInstallStep::WritePlist,
            NativeHarnessBrokerInstallStep::Bootstrap,
        ],
    }
}

#[cfg(target_os = "macos")]
fn require_current_aqua_uid(home: &Path) -> Result<u32, PlatformError> {
    use nix::unistd::Uid;

    let effective_uid = Uid::effective().as_raw();
    if effective_uid == 0 {
        return Err(PlatformError::Invalid(
            "the native Harness broker cannot be installed as root".to_owned(),
        ));
    }
    let home_metadata = fs::symlink_metadata(home)?;
    if home_metadata.file_type().is_symlink() || !home_metadata.is_dir() {
        return Err(PlatformError::Invalid(format!(
            "current user home must be a real directory, not a symlink: {}",
            home.display()
        )));
    }
    if home_metadata.uid() != effective_uid {
        return Err(PlatformError::Invalid(format!(
            "current user does not own the target home directory: {}",
            home.display()
        )));
    }
    let console_metadata = fs::metadata("/dev/console")?;
    let console_uid = console_metadata.uid();
    if console_uid == 0 || console_uid != effective_uid {
        return Err(PlatformError::Invalid(format!(
            "no Aqua console session is active for the current user (effective uid {effective_uid}, console uid {console_uid})"
        )));
    }
    Ok(console_uid)
}

#[cfg(target_os = "macos")]
fn require_regular_nonsymlink_file(path: &Path, label: &str) -> Result<(), PlatformError> {
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        PlatformError::Invalid(format!(
            "{label} is unavailable at '{}': {error}",
            path.display()
        ))
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(PlatformError::Invalid(format!(
            "{label} must be a regular file and not a symlink: {}",
            path.display()
        )));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn require_executable_file(path: &Path, label: &str) -> Result<(), PlatformError> {
    require_regular_nonsymlink_file(path, label)?;
    if fs::metadata(path)?.mode() & 0o111 == 0 {
        return Err(PlatformError::Invalid(format!(
            "{label} must have an executable permission bit: {}",
            path.display()
        )));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn ensure_owned_directory(
    path: &Path,
    uid: u32,
    harden_to_owner_only: bool,
) -> Result<(), PlatformError> {
    if !path.exists() {
        fs::create_dir(path)?;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    let mut metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() || metadata.uid() != uid {
        return Err(PlatformError::Invalid(format!(
            "managed directory must be a current-user-owned real directory: {}",
            path.display()
        )));
    }
    if harden_to_owner_only && metadata.mode() & 0o777 != 0o700 {
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
        metadata = fs::symlink_metadata(path)?;
    }
    if metadata.file_type().is_symlink()
        || !metadata.is_dir()
        || metadata.uid() != uid
        || if harden_to_owner_only {
            metadata.mode() & 0o777 != 0o700
        } else {
            metadata.mode() & 0o022 != 0
        }
    {
        return Err(PlatformError::Invalid(format!(
            "managed directory permissions or ownership are unsafe: {}",
            path.display()
        )));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn ensure_managed_directories(
    plan: &NativeHarnessBrokerLaunchAgentPlan,
    uid: u32,
) -> Result<(), PlatformError> {
    let home =
        plan.plist_path.ancestors().nth(3).ok_or_else(|| {
            PlatformError::Invalid("LaunchAgent path has no user home".to_owned())
        })?;
    let library = home.join("Library");
    let launch_agents = library.join("LaunchAgents");
    ensure_owned_directory(&library, uid, false)?;
    ensure_owned_directory(&launch_agents, uid, true)?;
    let codexhost = home.join(".codexhost");
    ensure_owned_directory(&codexhost, uid, true)?;
    ensure_owned_directory(&plan.broker_directory, uid, true)
}

#[cfg(target_os = "macos")]
fn plist_matches(
    plan: &NativeHarnessBrokerLaunchAgentPlan,
    uid: u32,
) -> Result<bool, PlatformError> {
    let metadata = match fs::symlink_metadata(&plan.plist_path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.into()),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(PlatformError::Invalid(format!(
            "managed LaunchAgent property list must be a regular file and not a symlink: {}",
            plan.plist_path.display()
        )));
    }
    if metadata.uid() != uid {
        return Err(PlatformError::Invalid(format!(
            "managed LaunchAgent property list belongs to another user: {}",
            plan.plist_path.display()
        )));
    }
    if metadata.mode() & 0o777 != 0o600 {
        return Ok(false);
    }
    Ok(fs::read_to_string(&plan.plist_path)? == plan.plist_xml)
}

#[cfg(target_os = "macos")]
fn validate_secure_plist(
    plan: &NativeHarnessBrokerLaunchAgentPlan,
    uid: u32,
) -> Result<(), PlatformError> {
    let parent = plan
        .plist_path
        .parent()
        .ok_or_else(|| PlatformError::Invalid("LaunchAgent path has no parent".to_owned()))?;
    ensure_owned_directory(parent, uid, true)?;
    let metadata = fs::symlink_metadata(&plan.plist_path)?;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.uid() != uid
        || metadata.mode() & 0o777 != 0o600
    {
        return Err(PlatformError::Invalid(format!(
            "managed LaunchAgent property list must be a current-user-owned 0600 regular file: {}",
            plan.plist_path.display()
        )));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn atomic_write_plist(
    plan: &NativeHarnessBrokerLaunchAgentPlan,
    uid: u32,
) -> Result<(), PlatformError> {
    if let Ok(metadata) = fs::symlink_metadata(&plan.plist_path) {
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(PlatformError::Invalid(format!(
                "refusing to replace a non-regular LaunchAgent property list: {}",
                plan.plist_path.display()
            )));
        }
        if metadata.uid() != uid {
            return Err(PlatformError::Invalid(format!(
                "refusing to replace a LaunchAgent property list owned by another user: {}",
                plan.plist_path.display()
            )));
        }
    }
    let parent = plan
        .plist_path
        .parent()
        .ok_or_else(|| PlatformError::Invalid("LaunchAgent path has no parent".to_owned()))?;
    ensure_owned_directory(parent, uid, true)?;
    let temporary_path = parent.join(format!(
        ".{NATIVE_HARNESS_BROKER_LABEL}.{}.tmp",
        std::process::id()
    ));
    let result = (|| -> Result<(), PlatformError> {
        let mut temporary = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temporary_path)?;
        temporary.write_all(plan.plist_xml.as_bytes())?;
        temporary.sync_all()?;
        fs::rename(&temporary_path, &plan.plist_path)?;
        validate_secure_plist(plan, uid)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary_path);
    }
    result
}

#[cfg(target_os = "macos")]
fn run_launchctl(command: &NativeHarnessBrokerCommand) -> Result<Output, PlatformError> {
    Command::new(command.program)
        .args(&command.arguments)
        .output()
        .map_err(PlatformError::Io)
}

#[cfg(target_os = "macos")]
fn command_failure(command: &NativeHarnessBrokerCommand, output: &Output) -> PlatformError {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    PlatformError::Invalid(format!(
        "{} {} failed with {}{}",
        command.program,
        command.arguments.join(" "),
        output.status,
        if stderr.is_empty() {
            String::new()
        } else {
            format!(": {stderr}")
        }
    ))
}

#[cfg(target_os = "macos")]
fn observed_launchctl_state(
    commands: &NativeHarnessBrokerLaunchctlPlan,
) -> Result<NativeHarnessBrokerObservedState, PlatformError> {
    let output = run_launchctl(&commands.print)?;
    if output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        return Ok(
            if stdout.lines().any(|line| line.trim() == "state = running") {
                NativeHarnessBrokerObservedState::Running
            } else {
                NativeHarnessBrokerObservedState::LoadedStopped
            },
        );
    }
    let stderr = String::from_utf8_lossy(&output.stderr).to_ascii_lowercase();
    if stderr.contains("could not find service") || stderr.contains("service not found") {
        Ok(NativeHarnessBrokerObservedState::NotLoaded)
    } else {
        Err(command_failure(&commands.print, &output))
    }
}

#[cfg(target_os = "macos")]
fn descriptor_fingerprint(
    plan: &NativeHarnessBrokerLaunchAgentPlan,
    uid: u32,
) -> Result<Option<[u8; 32]>, PlatformError> {
    let metadata = match fs::symlink_metadata(&plan.descriptor_path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(PlatformError::Invalid(format!(
            "native Harness broker descriptor must be a regular file and not a symlink: {}",
            plan.descriptor_path.display()
        )));
    }
    if metadata.uid() != uid {
        return Err(PlatformError::Invalid(format!(
            "native Harness broker descriptor belongs to another user: {}",
            plan.descriptor_path.display()
        )));
    }
    if metadata.mode() & 0o777 != 0o600 || metadata.len() == 0 {
        return Ok(None);
    }
    let bytes = fs::read(&plan.descriptor_path)?;
    if bytes.is_empty() {
        return Ok(None);
    }
    Ok(Some(Sha256::digest(bytes).into()))
}

#[cfg(target_os = "macos")]
fn wait_for_ready(
    commands: &NativeHarnessBrokerLaunchctlPlan,
    plan: &NativeHarnessBrokerLaunchAgentPlan,
    uid: u32,
    previous_descriptor: Option<[u8; 32]>,
    timeout: Duration,
) -> Result<bool, PlatformError> {
    let started = Instant::now();
    loop {
        let descriptor = descriptor_fingerprint(plan, uid)?;
        if observed_launchctl_state(commands)? == NativeHarnessBrokerObservedState::Running
            && descriptor.is_some()
            && descriptor != previous_descriptor
        {
            return Ok(true);
        }
        if started.elapsed() >= timeout {
            return Ok(false);
        }
        thread::sleep(Duration::from_millis(50));
    }
}

#[cfg(target_os = "macos")]
fn execute_required(command: &NativeHarnessBrokerCommand) -> Result<(), PlatformError> {
    let output = run_launchctl(command)?;
    if output.status.success() {
        Ok(())
    } else {
        Err(command_failure(command, &output))
    }
}

#[cfg(target_os = "macos")]
fn broker_context(
    paths: NativeHarnessBrokerPaths<'_>,
    environment: &[(String, String)],
) -> Result<
    (
        NativeHarnessBrokerLaunchAgentPlan,
        NativeHarnessBrokerLaunchctlPlan,
    ),
    PlatformError,
> {
    let uid = require_current_aqua_uid(paths.home)?;
    require_executable_file(paths.node, "packaged Node.js runtime")?;
    require_regular_nonsymlink_file(paths.host_runtime, "packaged Host Runtime")?;
    let plan = plan_native_harness_broker_launch_agent_with_environment(paths, uid, environment)?;
    let commands = plan_native_harness_broker_launchctl(uid, &plan.plist_path)?;
    Ok((plan, commands))
}

#[cfg(target_os = "macos")]
pub fn inspect_native_harness_broker(
    paths: NativeHarnessBrokerPaths<'_>,
    environment: &[(String, String)],
) -> Result<NativeHarnessBrokerStatus, PlatformError> {
    let uid = require_current_aqua_uid(paths.home)?;
    let (plan, commands) = broker_context(paths, environment)?;
    Ok(NativeHarnessBrokerStatus {
        label: plan.label,
        launchctl_target: plan.launchctl_target.clone(),
        plist_path: plan.plist_path.clone(),
        observed: observed_launchctl_state(&commands)?,
        plist_matches: plist_matches(&plan, uid)?,
        descriptor_ready: descriptor_fingerprint(&plan, require_current_aqua_uid(paths.home)?)?
            .is_some(),
    })
}

#[cfg(target_os = "macos")]
pub fn install_native_harness_broker(
    paths: NativeHarnessBrokerPaths<'_>,
    environment: &[(String, String)],
) -> Result<NativeHarnessBrokerInstallOutcome, PlatformError> {
    let (plan, commands) = broker_context(paths, environment)?;
    ensure_managed_directories(&plan, require_current_aqua_uid(paths.home)?)?;
    let uid = require_current_aqua_uid(paths.home)?;
    let matches = plist_matches(&plan, uid)?;
    let observed = observed_launchctl_state(&commands)?;
    let previous_descriptor = descriptor_fingerprint(&plan, require_current_aqua_uid(paths.home)?)?;
    let steps = plan_native_harness_broker_install(matches, observed);
    for step in &steps {
        match step {
            NativeHarnessBrokerInstallStep::Bootout => execute_required(&commands.bootout)?,
            NativeHarnessBrokerInstallStep::WritePlist => atomic_write_plist(&plan, uid)?,
            NativeHarnessBrokerInstallStep::Bootstrap => {
                validate_secure_plist(&plan, uid)?;
                execute_required(&commands.bootstrap)?;
            }
            NativeHarnessBrokerInstallStep::Kickstart => {
                validate_secure_plist(&plan, uid)?;
                execute_required(&commands.kickstart)?;
            }
        }
    }
    if !wait_for_ready(
        &commands,
        &plan,
        require_current_aqua_uid(paths.home)?,
        previous_descriptor,
        Duration::from_secs(3),
    )? {
        return Err(PlatformError::Invalid(format!(
            "native Harness broker did not enter the running state in {}",
            plan.launchctl_target
        )));
    }
    Ok(match steps.as_slice() {
        [] => NativeHarnessBrokerInstallOutcome::AlreadyRunning,
        [NativeHarnessBrokerInstallStep::Kickstart] => NativeHarnessBrokerInstallOutcome::Started,
        [
            NativeHarnessBrokerInstallStep::WritePlist,
            NativeHarnessBrokerInstallStep::Bootstrap,
        ] => NativeHarnessBrokerInstallOutcome::Installed,
        _ => NativeHarnessBrokerInstallOutcome::Reinstalled,
    })
}

#[cfg(target_os = "macos")]
pub fn stop_native_harness_broker(
    paths: NativeHarnessBrokerPaths<'_>,
) -> Result<bool, PlatformError> {
    let (_plan, commands) = broker_context(paths, &[])?;
    if observed_launchctl_state(&commands)? == NativeHarnessBrokerObservedState::NotLoaded {
        return Ok(false);
    }
    execute_required(&commands.bootout)?;
    Ok(true)
}

#[cfg(target_os = "macos")]
pub fn uninstall_native_harness_broker(
    paths: NativeHarnessBrokerPaths<'_>,
) -> Result<bool, PlatformError> {
    let (plan, commands) = broker_context(paths, &[])?;
    if observed_launchctl_state(&commands)? != NativeHarnessBrokerObservedState::NotLoaded {
        execute_required(&commands.bootout)?;
    }
    let metadata = match fs::symlink_metadata(&plan.plist_path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.into()),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(PlatformError::Invalid(format!(
            "refusing to remove a non-regular LaunchAgent property list: {}",
            plan.plist_path.display()
        )));
    }
    fs::remove_file(&plan.plist_path)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::{
        NATIVE_HARNESS_BROKER_LABEL, NativeHarnessBrokerInstallStep,
        NativeHarnessBrokerObservedState, NativeHarnessBrokerPaths,
        plan_native_harness_broker_install, plan_native_harness_broker_launch_agent,
        plan_native_harness_broker_launch_agent_with_environment,
        plan_native_harness_broker_launchctl,
    };

    #[test]
    fn launch_agent_plan_runs_the_packaged_broker_only_in_aqua() {
        let plan = plan_native_harness_broker_launch_agent(
            NativeHarnessBrokerPaths {
                home: Path::new("/Users/moka"),
                node: Path::new("/Applications/codexhost.app/Contents/Resources/runtime/node"),
                host_runtime: Path::new(
                    "/Applications/codexhost.app/Contents/Resources/app/host-runtime.mjs",
                ),
            },
            501,
        )
        .expect("valid plan");

        assert_eq!(plan.label, NATIVE_HARNESS_BROKER_LABEL);
        assert_eq!(plan.launchctl_domain, "gui/501");
        assert_eq!(
            plan.descriptor_path,
            Path::new("/Users/moka/.codexhost/harness-broker/claude-code-broker-v1.json")
        );
        assert_eq!(
            plan.program_arguments,
            [
                "/Applications/codexhost.app/Contents/Resources/runtime/node",
                "/Applications/codexhost.app/Contents/Resources/app/host-runtime.mjs",
                "--codexhost-harness-broker",
            ]
        );
        assert!(plan.plist_xml.contains("<string>Aqua</string>"));
        assert!(plan.plist_xml.contains("<key>RunAtLoad</key>\n<true/>"));
        assert!(plan.plist_xml.contains("<key>ThrottleInterval</key>"));
        assert!(!plan.plist_xml.contains("KeepAlive"));
        assert!(!plan.plist_xml.contains("EnvironmentVariables"));
        assert!(!plan.plist_xml.to_ascii_lowercase().contains("keychain"));
        assert!(!plan.plist_xml.to_ascii_lowercase().contains("password"));
    }

    #[test]
    fn launchctl_plan_targets_only_the_current_users_gui_domain() {
        let plist = Path::new(
            "/Users/moka/Library/LaunchAgents/ai.bytepioneer.codexhost.native-harness-broker.plist",
        );
        let commands = plan_native_harness_broker_launchctl(501, plist).expect("command plan");

        assert_eq!(commands.print.program, "/bin/launchctl");
        assert_eq!(
            commands.print.arguments,
            [
                "print",
                "gui/501/ai.bytepioneer.codexhost.native-harness-broker"
            ]
        );
        assert_eq!(
            commands.bootstrap.arguments,
            ["bootstrap", "gui/501", plist.to_str().expect("UTF-8 plist")]
        );
        assert_eq!(
            commands.bootout.arguments,
            [
                "bootout",
                "gui/501/ai.bytepioneer.codexhost.native-harness-broker"
            ]
        );
        assert_eq!(
            commands.kickstart.arguments,
            [
                "kickstart",
                "-k",
                "gui/501/ai.bytepioneer.codexhost.native-harness-broker"
            ]
        );
    }

    #[test]
    fn launch_agent_persists_only_the_normalized_proxy_allowlist() {
        let paths = NativeHarnessBrokerPaths {
            home: Path::new("/Users/moka"),
            node: Path::new("/opt/codexhost/node"),
            host_runtime: Path::new("/opt/codexhost/host-runtime.mjs"),
        };
        let plan = plan_native_harness_broker_launch_agent_with_environment(
            paths,
            501,
            &[
                ("HTTPS_PROXY".into(), "http://127.0.0.1:2080".into()),
                ("NODE_USE_ENV_PROXY".into(), "1".into()),
            ],
        )
        .expect("proxy allowlist");
        assert!(plan.plist_xml.contains("<key>EnvironmentVariables</key>"));
        assert!(plan.plist_xml.contains("<key>HTTPS_PROXY</key>"));
        assert!(!plan.plist_xml.contains("ANTHROPIC"));

        assert!(
            plan_native_harness_broker_launch_agent_with_environment(
                paths,
                501,
                &[("CLAUDE_TOKEN".into(), "secret".into())],
            )
            .is_err()
        );
    }

    #[test]
    fn install_restarts_the_exact_agent_to_load_updated_runtime_code() {
        assert_eq!(
            plan_native_harness_broker_install(true, NativeHarnessBrokerObservedState::Running),
            [NativeHarnessBrokerInstallStep::Kickstart]
        );
    }

    #[test]
    fn install_replaces_a_loaded_agent_when_its_plist_changed() {
        assert_eq!(
            plan_native_harness_broker_install(false, NativeHarnessBrokerObservedState::Running),
            [
                NativeHarnessBrokerInstallStep::Bootout,
                NativeHarnessBrokerInstallStep::WritePlist,
                NativeHarnessBrokerInstallStep::Bootstrap,
            ]
        );
    }

    #[test]
    fn install_starts_an_exact_but_stopped_agent_without_rewriting_it() {
        assert_eq!(
            plan_native_harness_broker_install(
                true,
                NativeHarnessBrokerObservedState::LoadedStopped,
            ),
            [NativeHarnessBrokerInstallStep::Kickstart]
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn existing_managed_directory_is_hardened_and_revalidated() {
        use std::fs;
        use std::os::unix::fs::{MetadataExt, PermissionsExt};

        use nix::unistd::Uid;

        let root = crate::temporary_directory("codexhost-broker-directory-security");
        let managed = root.join("LaunchAgents");
        fs::create_dir(&managed).expect("managed directory");
        fs::set_permissions(&managed, fs::Permissions::from_mode(0o777))
            .expect("insecure fixture permissions");

        super::ensure_owned_directory(&managed, Uid::effective().as_raw(), true)
            .expect("harden current-user directory");
        let metadata = fs::symlink_metadata(&managed).expect("hardened metadata");
        assert_eq!(metadata.mode() & 0o777, 0o700);
        assert_eq!(metadata.uid(), Uid::effective().as_raw());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn managed_directory_rejects_symlinks_and_foreign_owners() {
        use std::fs;
        use std::os::unix::fs::symlink;

        use nix::unistd::Uid;

        let root = crate::temporary_directory("codexhost-broker-directory-identity");
        let real = root.join("real");
        let linked = root.join("linked");
        fs::create_dir(&real).expect("real directory");
        symlink(&real, &linked).expect("directory symlink");
        let uid = Uid::effective().as_raw();

        assert!(super::ensure_owned_directory(&linked, uid, true).is_err());
        assert!(super::ensure_owned_directory(&real, uid.saturating_add(1), true).is_err());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn atomic_plist_publish_finishes_with_current_user_and_0600_mode() {
        use std::fs;
        use std::os::unix::fs::{MetadataExt, PermissionsExt};

        use nix::unistd::Uid;

        let home = crate::temporary_directory("codexhost-broker-plist-security");
        let uid = Uid::effective().as_raw();
        let plan = plan_native_harness_broker_launch_agent(
            NativeHarnessBrokerPaths {
                home: &home,
                node: Path::new("/opt/codexhost/node"),
                host_runtime: Path::new("/opt/codexhost/host-runtime.mjs"),
            },
            uid,
        )
        .expect("LaunchAgent plan");
        fs::create_dir(home.join("Library")).expect("Library fixture");
        fs::set_permissions(home.join("Library"), fs::Permissions::from_mode(0o700))
            .expect("Library permissions");

        super::ensure_managed_directories(&plan, uid).expect("secure directories");
        super::atomic_write_plist(&plan, uid).expect("atomic plist publish");

        let metadata = fs::symlink_metadata(&plan.plist_path).expect("plist metadata");
        assert!(metadata.is_file());
        assert!(!metadata.file_type().is_symlink());
        assert_eq!(metadata.uid(), uid);
        assert_eq!(metadata.mode() & 0o777, 0o600);
    }
}
