use std::fs;
use std::path::PathBuf;

use plist::Value;

use super::{home, launch_agent, read_file, remove_file, validate_arguments};
use crate::PlatformError;

fn path() -> Result<PathBuf, PlatformError> {
    Ok(home()?.join("Library/LaunchAgents/ai.bytepioneer.codexhost.autostart.plist"))
}

pub(super) fn read() -> Result<Option<String>, PlatformError> {
    read_file(&path()?)
}

pub(super) fn validate(content: &str) -> Result<(), PlatformError> {
    let value = Value::from_reader_xml(content.as_bytes())
        .map_err(|error| PlatformError::Invalid(format!("invalid autostart plist: {error}")))?;
    let dictionary = value
        .as_dictionary()
        .ok_or_else(|| PlatformError::Invalid("autostart plist is not a dictionary".into()))?;
    let arguments = dictionary
        .get("ProgramArguments")
        .and_then(Value::as_array)
        .and_then(|values| {
            values
                .iter()
                .map(|value| value.as_string().map(str::to_owned))
                .collect::<Option<Vec<_>>>()
        })
        .ok_or_else(|| PlatformError::Invalid("invalid autostart ProgramArguments".into()))?;
    validate_arguments(&arguments)
}

pub(super) fn render(arguments: &[String]) -> Result<String, PlatformError> {
    Ok(launch_agent(arguments))
}

pub(super) fn write(content: &str) -> Result<(), PlatformError> {
    let path = path()?;
    fs::create_dir_all(path.parent().expect("LaunchAgents directory"))?;
    // No bootstrap: RunAtLoad is for the next login, not for toggling this setting.
    fs::write(path, content)?;
    Ok(())
}

pub(super) fn remove() -> Result<(), PlatformError> {
    remove_file(&path()?)
}
