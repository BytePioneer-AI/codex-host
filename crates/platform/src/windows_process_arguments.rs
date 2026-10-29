use crate::PlatformError;
use serde::Deserialize;
use std::ffi::OsString;
use std::io::Read;
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};
use windows::Win32::Foundation::{HLOCAL, LocalFree};
use windows::Win32::System::SystemInformation::GetSystemDirectoryW;
use windows::Win32::UI::Shell::CommandLineToArgvW;
use windows::core::PCWSTR;

const LIMIT: u64 = 4 * 1024 * 1024;
const TIMEOUT: Duration = Duration::from_secs(5);
const SCRIPT: &str = r#"
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
$items = @(CimCmdlets\Get-CimInstance Win32_Process | Where-Object { [string]::Equals($_.ExecutablePath, $env:CODEXHOST_QUERY_PROCESS_IMAGE, [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object {
  $micros = [decimal]::Truncate(([decimal]$_.CreationDate.ToFileTimeUtc()) / 10)
  [pscustomobject]@{ id = [uint32]$_.ProcessId; startedAtMicros = $micros.ToString([Globalization.CultureInfo]::InvariantCulture); commandLine = $_.CommandLine }
})
Microsoft.PowerShell.Utility\ConvertTo-Json -InputObject $items -Compress -Depth 3
"#;

/// Arguments observed with a process birth time. Before termination, match both
/// these fields and the executable against a fresh kernel process snapshot.
#[derive(Debug, Clone)]
pub struct ProcessArguments {
    pub id: u32,
    pub started_at_micros: u64,
    pub arguments: Vec<OsString>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Observation {
    id: u32,
    started_at_micros: String,
    command_line: String,
}

pub(crate) fn arguments(command_line: &str) -> Result<Vec<OsString>, PlatformError> {
    if command_line.is_empty()
        || command_line.contains('\0')
        || command_line.encode_utf16().count() > 32_767
    {
        return Err(PlatformError::Invalid(
            "invalid Windows process command line".into(),
        ));
    }
    let wide = std::ffi::OsStr::new(command_line)
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let mut count = 0;
    let values = unsafe { CommandLineToArgvW(PCWSTR(wide.as_ptr()), &mut count) };
    if values.is_null() {
        return Err(std::io::Error::last_os_error().into());
    }
    let result = unsafe { std::slice::from_raw_parts(values, count as usize) }
        .iter()
        .map(|value| {
            let length = unsafe { value.len() };
            OsString::from_wide(unsafe { std::slice::from_raw_parts(value.0, length) })
        })
        .collect();
    unsafe {
        let _ = LocalFree(Some(HLOCAL(values.cast())));
    }
    Ok(result)
}

fn powershell_path() -> Result<PathBuf, PlatformError> {
    let mut directory = vec![0_u16; 32_768];
    let length = unsafe { GetSystemDirectoryW(Some(&mut directory)) } as usize;
    if length == 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    if length >= directory.len() {
        return Err(PlatformError::Invalid(
            "Windows system path exceeds limit".into(),
        ));
    }
    Ok(PathBuf::from(OsString::from_wide(&directory[..length]))
        .join("WindowsPowerShell/v1.0/powershell.exe"))
}

/// Reads local WMI process arguments without executing any observed command.
/// The system shell, modules, UTF-8 output, size and lifetime are fixed here.
pub fn process_arguments_for_executable(
    executable: &Path,
) -> Result<Vec<ProcessArguments>, PlatformError> {
    if !executable.is_absolute() {
        return Err(PlatformError::Invalid(
            "process image must be absolute".into(),
        ));
    }
    let shell = powershell_path()?;
    let mut command = Command::new(&shell);
    command
        .args(["-NoProfile", "-NonInteractive", "-Command", SCRIPT])
        .env(
            "CODEXHOST_QUERY_PROCESS_IMAGE",
            crate::node_entrypoint_path(&executable.canonicalize()?),
        )
        .env(
            "PSModulePath",
            shell
                .parent()
                .ok_or_else(|| PlatformError::Invalid("system shell has no parent".into()))?
                .join("Modules"),
        )
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    crate::configure_background_command(&mut command);
    let mut child = command.spawn()?;
    let stdout = child.stdout.take().expect("piped process output");
    let reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        stdout
            .take(LIMIT + 1)
            .read_to_end(&mut bytes)
            .map(|_| bytes)
    });
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) if started.elapsed() < TIMEOUT => thread::sleep(Duration::from_millis(20)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                break Err(std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    "process argument query timed out",
                ));
            }
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                break Err(error);
            }
        }
    };
    let bytes = reader
        .join()
        .map_err(|_| PlatformError::Invalid("process output reader failed".into()))??;
    if !status?.success() || bytes.len() as u64 > LIMIT {
        return Err(PlatformError::Invalid(
            "cannot obtain bounded local process arguments".into(),
        ));
    }
    let observations: Vec<Observation> = serde_json::from_slice(&bytes).map_err(|error| {
        PlatformError::Invalid(format!("invalid process argument observation: {error}"))
    })?;
    observations
        .into_iter()
        .map(|observation| {
            let birth = observation
                .started_at_micros
                .parse::<u64>()
                .map_err(|_| PlatformError::Invalid("invalid process birth time".into()))?;
            if observation.id == 0 || birth == 0 {
                return Err(PlatformError::Invalid("empty process identity".into()));
            }
            Ok(ProcessArguments {
                id: observation.id,
                started_at_micros: birth,
                arguments: arguments(&observation.command_line)?,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn windows_parses_quoted_unicode_script_paths_and_options() {
        assert_eq!(arguments(r#""C:\Program Files\node.exe" --disable-warning=UNDICI-EHPA "D:\中文 prefix\app\console-server.mjs" serve"#).unwrap(),
            [r#"C:\Program Files\node.exe"#, "--disable-warning=UNDICI-EHPA", r#"D:\中文 prefix\app\console-server.mjs"#, "serve"].map(OsString::from));
        assert!(arguments("bad\0command").is_err());
    }
}
