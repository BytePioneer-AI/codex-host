use std::env;
use std::ffi::OsString;
use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{self, ExitStatus};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use codexhost_platform::{CODEX_CLI_PATH_ENV, STOCK_CODEX_PATH_ENV, parent_process_id};
use codexhost_shim::ProxyObserver;

#[cfg(unix)]
use crate::LAUNCH_MODE_ENV;
use crate::{DESKTOP_VERSION_ENV, INSTALL_ROOT_ENV, PROBE_OUTPUT_ENV};

fn unix_timestamp_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn json_string(value: &str) -> String {
    let mut output = String::with_capacity(value.len() + 2);
    output.push('"');
    for character in value.chars() {
        match character {
            '"' => output.push_str("\\\""),
            '\\' => output.push_str("\\\\"),
            '\u{08}' => output.push_str("\\b"),
            '\u{0c}' => output.push_str("\\f"),
            '\n' => output.push_str("\\n"),
            '\r' => output.push_str("\\r"),
            '\t' => output.push_str("\\t"),
            character if character <= '\u{1f}' => {
                write!(&mut output, "\\u{:04x}", character as u32).expect("write JSON escape");
            }
            character => output.push(character),
        }
    }
    output.push('"');
    output
}

fn release_architecture() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        architecture => architecture,
    }
}

fn classify_invocation(arguments: &[OsString]) -> &'static str {
    if arguments.iter().any(|argument| argument == "app-server") {
        "app-server"
    } else {
        "other"
    }
}

#[cfg(unix)]
fn platform_fields_from_group(process_group_id: u32) -> String {
    format!(
        "\"platform\":{},\"architecture\":{},\"process_group_id\":{},\"launch_mode\":{}",
        json_string(if cfg!(target_os = "macos") {
            "macos"
        } else {
            "linux"
        }),
        json_string(release_architecture()),
        process_group_id,
        json_string(&env::var(LAUNCH_MODE_ENV).unwrap_or_default()),
    )
}

#[cfg(unix)]
fn platform_fields(process_id: u32) -> Result<String, String> {
    codexhost_platform::process_snapshot(process_id)
        .map(|snapshot| platform_fields_from_group(snapshot.process_group_id))
        .map_err(|error| format!("could not inspect probe process {process_id}: {error}"))
}

#[cfg(target_os = "windows")]
fn platform_fields(_process_id: u32) -> Result<String, String> {
    Ok("\"platform\":\"windows\"".into())
}

#[cfg(not(any(target_os = "windows", unix)))]
fn platform_fields(_process_id: u32) -> Result<String, String> {
    Ok(format!(
        "\"platform\":{}",
        json_string(std::env::consts::OS)
    ))
}

#[cfg(unix)]
fn exit_fields(status: &ExitStatus) -> String {
    use std::os::unix::process::ExitStatusExt;

    format!(
        ",\"exit_signal\":{}",
        status
            .signal()
            .map_or_else(|| "null".into(), |signal| signal.to_string())
    )
}

#[cfg(not(unix))]
fn exit_fields(_status: &ExitStatus) -> String {
    String::new()
}

#[derive(Debug, Clone)]
pub struct ProbeCapture {
    output_directory: PathBuf,
}

impl ProbeCapture {
    pub fn from_environment() -> Result<Self, String> {
        let output_directory = env::var_os(PROBE_OUTPUT_ENV)
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .ok_or_else(|| format!("{PROBE_OUTPUT_ENV} is required for the Gate Shim"))?;
        Ok(Self { output_directory })
    }

    fn write_raw_record(&self, kind: &str, record: &str) -> std::io::Result<PathBuf> {
        fs::create_dir_all(&self.output_directory)?;
        let timestamp = unix_timestamp_millis();
        let process_id = process::id();
        let stem = format!("{timestamp}-{process_id}-{kind}");
        let temporary_path = self.output_directory.join(format!("{stem}.tmp"));
        let final_path = self.output_directory.join(format!("{stem}.json"));
        fs::write(&temporary_path, record)?;
        fs::rename(&temporary_path, &final_path)?;
        Ok(final_path)
    }
}

impl ProxyObserver for ProbeCapture {
    fn invocation(&self, arguments: &[OsString], stock_codex_path: &Path) {
        let process_id = process::id();
        let platform = match platform_fields(process_id) {
            Ok(fields) => fields,
            Err(error) => {
                eprintln!("codexhost Gate Shim: failed to inspect probe invocation: {error}");
                return;
            }
        };
        let parent_id = parent_process_id(process_id)
            .ok()
            .flatten()
            .map_or_else(|| "null".into(), |value| value.to_string());
        let args = arguments
            .iter()
            .map(|argument| json_string(&argument.to_string_lossy()))
            .collect::<Vec<_>>()
            .join(",");
        let cwd = env::current_dir()
            .map(|path| path.to_string_lossy().into_owned())
            .unwrap_or_default();
        let record = format!(
            concat!(
                "{{\"schema_version\":1,{},\"record_type\":\"invocation\",",
                "\"timestamp_ms\":{},\"process_id\":{},\"parent_process_id\":{},",
                "\"invocation_kind\":{},\"args\":[{}],\"cwd\":{},",
                "\"desktop_version\":{},\"install_root\":{},\"stock_codex_path\":{},",
                "\"environment_presence\":{{",
                "\"CODEX_CLI_PATH\":{},\"CODEXHOST_STOCK_CODEX_PATH\":{},",
                "\"CODEXHOST_PROBE_OUTPUT\":{},\"CODEXHOST_DESKTOP_VERSION\":{},",
                "\"CODEXHOST_INSTALL_ROOT\":{}",
                "}}}}"
            ),
            platform,
            unix_timestamp_millis(),
            process_id,
            parent_id,
            json_string(classify_invocation(arguments)),
            args,
            json_string(&cwd),
            json_string(&env::var(DESKTOP_VERSION_ENV).unwrap_or_default()),
            json_string(&env::var(INSTALL_ROOT_ENV).unwrap_or_default()),
            json_string(&stock_codex_path.to_string_lossy()),
            env::var_os(CODEX_CLI_PATH_ENV).is_some(),
            env::var_os(STOCK_CODEX_PATH_ENV).is_some(),
            env::var_os(PROBE_OUTPUT_ENV).is_some(),
            env::var_os(DESKTOP_VERSION_ENV).is_some(),
            env::var_os(INSTALL_ROOT_ENV).is_some(),
        );
        if let Err(error) = self.write_raw_record("invocation", &record) {
            eprintln!("codexhost Gate Shim: failed to write probe invocation: {error}");
        }
    }

    fn exit(&self, child_id: u32, status: &ExitStatus, elapsed: Duration) {
        let process_id = process::id();
        let platform = match platform_fields(process_id) {
            Ok(fields) => fields,
            Err(error) => {
                eprintln!("codexhost Gate Shim: failed to inspect probe exit: {error}");
                return;
            }
        };
        let exit_code = status
            .code()
            .map_or_else(|| "null".into(), |value| value.to_string());
        let record = format!(
            concat!(
                "{{\"schema_version\":1,{},\"record_type\":\"exit\",",
                "\"timestamp_ms\":{},\"process_id\":{},\"child_process_id\":{},",
                "\"exit_code\":{},\"success\":{},\"elapsed_ms\":{}{} }}"
            ),
            platform,
            unix_timestamp_millis(),
            process_id,
            child_id,
            exit_code,
            status.success(),
            elapsed.as_millis(),
            exit_fields(status),
        );
        if let Err(error) = self.write_raw_record("exit", &record) {
            eprintln!("codexhost Gate Shim: failed to write probe exit: {error}");
        }
    }
}

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    use super::platform_fields_from_group;
    use super::{classify_invocation, json_string, release_architecture};
    use std::ffi::OsString;

    #[test]
    fn escapes_json_control_characters() {
        assert_eq!(json_string("a\n\"b\\c"), "\"a\\n\\\"b\\\\c\"");
    }

    #[test]
    fn uses_release_architecture_names() {
        let expected = match std::env::consts::ARCH {
            "x86_64" => "x64",
            "aarch64" => "arm64",
            architecture => architecture,
        };
        assert_eq!(release_architecture(), expected);
    }

    #[cfg(unix)]
    #[test]
    fn formats_unix_process_group_evidence_without_a_process_lookup() {
        assert!(platform_fields_from_group(42).contains("\"process_group_id\":42"));
    }

    #[test]
    fn classifies_app_server_invocations() {
        assert_eq!(
            classify_invocation(&[OsString::from("-c"), OsString::from("app-server")]),
            "app-server"
        );
        assert_eq!(classify_invocation(&[OsString::from("--version")]), "other");
    }
}
