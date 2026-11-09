//! Current-user login startup. Service supervision remains with the Launcher.
use std::path::PathBuf;

use crate::PlatformError;

#[cfg(target_os = "macos")]
#[path = "autostart_macos.rs"]
mod native;
#[cfg(target_os = "linux")]
#[path = "autostart_linux.rs"]
mod native;
#[cfg(target_os = "windows")]
#[allow(unsafe_code)]
#[path = "autostart_windows.rs"]
mod native;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AutostartCommand {
    pub executable: PathBuf,
    /// npm's JavaScript wrapper, run by executable (the current Node).
    pub wrapper: Option<PathBuf>,
}

impl AutostartCommand {
    fn arguments(&self) -> Result<Vec<String>, PlatformError> {
        #[cfg(target_os = "windows")]
        let executable = if self.wrapper.is_none() {
            self.executable.with_file_name("codexhost-start.exe")
        } else {
            self.executable.clone()
        };
        #[cfg(not(target_os = "windows"))]
        let executable = &self.executable;
        let mut arguments = Vec::new();
        for path in std::iter::once(executable.as_path()).chain(self.wrapper.as_deref()) {
            if !path.is_absolute() || !path.is_file() {
                return Err(PlatformError::Invalid(format!(
                    "autostart program is missing or not an absolute file: {}",
                    path.display()
                )));
            }
            arguments.push(
                path.to_str()
                    .ok_or_else(|| PlatformError::Invalid("autostart paths must be UTF-8".into()))?
                    .to_owned(),
            );
        }
        if cfg!(target_os = "windows") && self.wrapper.is_none() {
            arguments.push("--autostart".into());
        } else {
            arguments.extend(["web".into(), "--background".into()]);
        }
        Ok(arguments)
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum AutostartStatus {
    On,
    Off,
    Invalid(String),
}

fn validate_arguments(arguments: &[String]) -> Result<(), PlatformError> {
    let executable = arguments
        .first()
        .ok_or_else(|| PlatformError::Invalid("autostart command has no program".into()))?;
    // npm's second argument is the absolute wrapper path; native commands have
    // a subcommand or switch in that position.
    let wrapper = arguments
        .get(1)
        .filter(|path| std::path::Path::new(path).is_absolute());
    for path in std::iter::once(executable).chain(wrapper) {
        if !std::path::Path::new(path).is_file() {
            return Err(PlatformError::Invalid(format!(
                "autostart program is missing: {path}"
            )));
        }
    }
    Ok(())
}

pub fn autostart_status() -> AutostartStatus {
    match native::read() {
        Ok(None) => AutostartStatus::Off,
        Ok(Some(content)) => match native::validate(&content) {
            Ok(()) => AutostartStatus::On,
            Err(error) => AutostartStatus::Invalid(error.to_string()),
        },
        Err(error) => AutostartStatus::Invalid(error.to_string()),
    }
}

pub fn enable_autostart(command: &AutostartCommand) -> Result<(), PlatformError> {
    native::write(&native::render(&command.arguments()?)?)
}

pub fn disable_autostart() -> Result<(), PlatformError> {
    native::remove()
}

pub fn refresh_autostart(command: &AutostartCommand) -> Result<(), PlatformError> {
    // Presence is the opt-in, including a stale entry whose program was removed.
    if let Some(current) = native::read()? {
        let content = native::render(&command.arguments()?)?;
        if current != content {
            native::write(&content)?;
        }
    }
    Ok(())
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn read_file(path: &std::path::Path) -> Result<Option<String>, PlatformError> {
    match std::fs::read_to_string(path) {
        Ok(content) => Ok(Some(content)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn remove_file(path: &std::path::Path) -> Result<(), PlatformError> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn home() -> Result<PathBuf, PlatformError> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| PlatformError::NotFound("HOME is unavailable".into()))
}

#[cfg(any(target_os = "macos", test))]
fn launch_agent(arguments: &[String]) -> String {
    use crate::macos_native_harness_broker::xml_text;
    let arguments = arguments
        .iter()
        .map(|argument| format!("<string>{}</string>", xml_text(argument)))
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"https://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n\
<plist version=\"1.0\"><dict>\n\
<key>Label</key><string>ai.bytepioneer.codexhost.autostart</string>\n\
<key>ProgramArguments</key><array>\n{arguments}\n</array>\n\
<key>RunAtLoad</key><true/>\n\
</dict></plist>\n"
    )
}

#[cfg(any(target_os = "linux", test))]
fn systemd_unit(arguments: &[String]) -> String {
    let command = arguments
        .iter()
        .map(|argument| {
            serde_json::to_string(argument)
                .expect("serialize string")
                .replace('%', "%%")
                .replace('$', "$$")
        })
        .collect::<Vec<_>>()
        .join(" ");
    format!(
        "[Unit]\nDescription=codexhost login startup\n\n[Service]\nType=oneshot\nRemainAfterExit=yes\nExecStart={command}\n\n[Install]\nWantedBy=default.target\n"
    )
}

#[cfg(any(target_os = "linux", test))]
fn systemd_arguments(content: &str) -> Result<Vec<String>, PlatformError> {
    let command = content
        .lines()
        .find_map(|line| line.strip_prefix("ExecStart="))
        .ok_or_else(|| PlatformError::Invalid("autostart unit has no ExecStart".into()))?;
    let arguments = serde_json::Deserializer::from_str(command)
        .into_iter::<String>()
        .map(|value| value.map(|value| value.replace("%%", "%").replace("$$", "$")))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| PlatformError::Invalid(format!("invalid autostart ExecStart: {error}")))?;
    Ok(arguments)
}

#[cfg(any(target_os = "windows", test))]
fn windows_run_command(arguments: &[String]) -> Result<String, PlatformError> {
    use crate::windows_command_line::windows_command_line;
    let arguments = arguments
        .iter()
        .map(std::ffi::OsString::from)
        .collect::<Vec<_>>();
    let command = windows_command_line(&arguments)
        .to_string_lossy()
        .into_owned();
    let length = command.encode_utf16().count();
    if length > 260 {
        return Err(PlatformError::Invalid(format!(
            "Windows Run autostart command is {length} characters; the limit is 260. Install codexhost and Node at shorter paths."
        )));
    }
    Ok(command)
}

#[cfg(test)]
#[path = "autostart_tests.rs"]
mod tests;
