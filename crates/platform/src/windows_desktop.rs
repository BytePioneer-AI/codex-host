use std::ffi::{OsStr, OsString};
use std::io;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::process::ExitStatusExt;
use std::process::ExitStatus;
use std::thread;
use std::time::{Duration, Instant};

use windows::Win32::Foundation::{
    HANDLE, RPC_E_CHANGED_MODE, STILL_ACTIVE, WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows::Win32::System::Com::{
    CLSCTX_INPROC_SERVER, CLSCTX_LOCAL_SERVER, COINIT_APARTMENTTHREADED, CoCreateInstance,
    CoInitializeEx, CoUninitialize,
};
use windows::Win32::System::Threading::{
    GetExitCodeProcess, OpenProcess, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE, TerminateProcess,
    WaitForSingleObject,
};
use windows::Win32::UI::Shell::{
    ACTIVATEOPTIONS, ApplicationActivationManager, IApplicationActivationManager,
    IPackageDebugSettings, PackageDebugSettings,
};
use windows::core::{HSTRING, Owned};

use super::PlatformError;
use super::process::desktop_root_process_ids;

fn windows_error(context: &str, error: windows::core::Error) -> PlatformError {
    PlatformError::Invalid(format!("{context}: {error}"))
}

struct ComApartment {
    uninitialize: bool,
}

impl ComApartment {
    fn initialize() -> Result<Self, PlatformError> {
        let result = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
        if result.is_ok() {
            Ok(Self { uninitialize: true })
        } else if result == RPC_E_CHANGED_MODE {
            Ok(Self {
                uninitialize: false,
            })
        } else {
            Err(windows_error(
                "cannot initialize packaged-app activation",
                result.into(),
            ))
        }
    }
}

impl Drop for ComApartment {
    fn drop(&mut self) {
        if self.uninitialize {
            unsafe { CoUninitialize() };
        }
    }
}

struct PackageEnvironment {
    settings: IPackageDebugSettings,
    package_full_name: HSTRING,
    armed: bool,
}

impl PackageEnvironment {
    fn enable(package_full_name: &str, environment: &[u16]) -> Result<Self, PlatformError> {
        let settings: IPackageDebugSettings =
            unsafe { CoCreateInstance(&PackageDebugSettings, None, CLSCTX_INPROC_SERVER) }
                .map_err(|error| {
                    windows_error("cannot initialize AppX package environment", error)
                })?;
        let package_full_name = HSTRING::from(package_full_name);
        unsafe {
            settings.EnableDebugging(
                &package_full_name,
                windows::core::PCWSTR::null(),
                windows::core::PCWSTR(environment.as_ptr()),
            )
        }
        .map_err(|error| windows_error("cannot install the temporary AppX environment", error))?;
        Ok(Self {
            settings,
            package_full_name,
            armed: true,
        })
    }

    fn disable(&mut self) -> Result<(), PlatformError> {
        if self.armed {
            unsafe { self.settings.DisableDebugging(&self.package_full_name) }.map_err(
                |error| windows_error("cannot remove the temporary AppX environment", error),
            )?;
            self.armed = false;
        }
        Ok(())
    }
}

impl Drop for PackageEnvironment {
    fn drop(&mut self) {
        if self.armed {
            let _ = unsafe { self.settings.DisableDebugging(&self.package_full_name) };
        }
    }
}

pub struct WindowsDesktopProcess {
    process_id: u32,
    process: Owned<HANDLE>,
    status: Option<ExitStatus>,
}

impl WindowsDesktopProcess {
    #[must_use]
    pub fn id(&self) -> u32 {
        self.process_id
    }

    pub fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        if let Some(status) = self.status {
            return Ok(Some(status));
        }
        let result = unsafe { WaitForSingleObject(*self.process, 0) };
        if result == WAIT_TIMEOUT {
            return Ok(None);
        }
        if result != WAIT_OBJECT_0 {
            return Err(io::Error::last_os_error());
        }
        let mut exit_code = STILL_ACTIVE.0 as u32;
        unsafe { GetExitCodeProcess(*self.process, &mut exit_code) }
            .map_err(|error| io::Error::other(format!("cannot read Desktop exit code: {error}")))?;
        let status = ExitStatus::from_raw(exit_code);
        self.status = Some(status);
        Ok(Some(status))
    }

    pub fn wait(&mut self) -> io::Result<ExitStatus> {
        if let Some(status) = self.status {
            return Ok(status);
        }
        let result = unsafe { WaitForSingleObject(*self.process, u32::MAX) };
        if result != WAIT_OBJECT_0 {
            return Err(io::Error::last_os_error());
        }
        self.try_wait()?.ok_or_else(|| {
            io::Error::other("packaged Codex Desktop remained active after its wait completed")
        })
    }

    pub fn kill(&mut self) -> io::Result<()> {
        unsafe { TerminateProcess(*self.process, 1) }
            .map_err(|error| io::Error::other(format!("cannot terminate Desktop: {error}")))
    }
}

pub fn quote_windows_argument(argument: &OsStr) -> OsString {
    let value = argument.to_string_lossy();
    if !value.is_empty() && !value.contains([' ', '\t', '"']) {
        return argument.to_owned();
    }
    let mut output = String::from("\"");
    let mut backslashes = 0;
    for character in value.chars() {
        match character {
            '\\' => backslashes += 1,
            '"' => {
                output.push_str(&"\\".repeat(backslashes * 2 + 1));
                output.push('"');
                backslashes = 0;
            }
            _ => {
                output.push_str(&"\\".repeat(backslashes));
                output.push(character);
                backslashes = 0;
            }
        }
    }
    output.push_str(&"\\".repeat(backslashes * 2));
    output.push('"');
    OsString::from(output)
}

pub fn windows_command_line(arguments: &[OsString]) -> OsString {
    arguments
        .iter()
        .map(|argument| quote_windows_argument(argument))
        .collect::<Vec<_>>()
        .join(OsStr::new(" "))
}

pub fn windows_environment_block(
    environment: &[(OsString, OsString)],
) -> Result<Vec<u16>, PlatformError> {
    for (name, value) in environment {
        let name = name.encode_wide().collect::<Vec<_>>();
        let value = value.encode_wide().collect::<Vec<_>>();
        if name.is_empty()
            || name.contains(&0)
            || name.contains(&('=' as u16))
            || value.contains(&0)
        {
            return Err(PlatformError::Invalid(
                "AppX environment contains an invalid name or value".into(),
            ));
        }
    }
    let mut entries = environment.to_vec();
    entries.sort_by(|left, right| {
        left.0
            .to_string_lossy()
            .to_lowercase()
            .cmp(&right.0.to_string_lossy().to_lowercase())
    });
    let mut block = Vec::new();
    for (name, value) in entries {
        block.extend(name.encode_wide());
        block.push('=' as u16);
        block.extend(value.encode_wide());
        block.push(0);
    }
    block.push(0);
    if block.len() == 1 {
        block.push(0);
    }
    Ok(block)
}

fn wait_for_desktop_root(
    activation_process_id: u32,
    timeout: Duration,
) -> Result<WindowsDesktopProcess, PlatformError> {
    let started = Instant::now();
    loop {
        match desktop_root_process_ids()?.as_slice() {
            [process_id] if *process_id == activation_process_id => {
                return supervise_desktop(*process_id);
            }
            [] if started.elapsed() < timeout => thread::sleep(Duration::from_millis(20)),
            [] => {
                return Err(PlatformError::NotFound(
                    "Codex Desktop AppX activation did not create a root process before timeout"
                        .into(),
                ));
            }
            roots => {
                return Err(PlatformError::Invalid(format!(
                    "Codex Desktop AppX activation did not own the observed root processes: {}",
                    roots
                        .iter()
                        .map(u32::to_string)
                        .collect::<Vec<_>>()
                        .join(", ")
                )));
            }
        }
    }
}

pub fn activate_packaged_desktop(
    package_full_name: &str,
    app_user_model_id: &str,
    arguments: &[OsString],
    environment: &[(OsString, OsString)],
) -> Result<WindowsDesktopProcess, PlatformError> {
    let _apartment = ComApartment::initialize()?;
    let environment = windows_environment_block(environment)?;
    let mut package_environment = PackageEnvironment::enable(package_full_name, &environment)?;
    let manager: IApplicationActivationManager =
        unsafe { CoCreateInstance(&ApplicationActivationManager, None, CLSCTX_LOCAL_SERVER) }
            .map_err(|error| windows_error("cannot initialize AppX activation manager", error))?;
    let activation_process_id = unsafe {
        manager.ActivateApplication(
            &HSTRING::from(app_user_model_id),
            &HSTRING::from(windows_command_line(arguments).to_string_lossy().as_ref()),
            ACTIVATEOPTIONS(0),
        )
    }
    .map_err(|error| windows_error("cannot activate Codex Desktop AppX package", error))?;
    let desktop = wait_for_desktop_root(activation_process_id, Duration::from_secs(5))?;
    package_environment.disable()?;
    Ok(desktop)
}

pub fn supervise_desktop(process_id: u32) -> Result<WindowsDesktopProcess, PlatformError> {
    let process =
        unsafe { OpenProcess(PROCESS_SYNCHRONIZE | PROCESS_TERMINATE, false, process_id) }
            .map_err(|error| windows_error("cannot supervise activated Codex Desktop", error))?;
    Ok(WindowsDesktopProcess {
        process_id,
        process: unsafe { Owned::new(process) },
        status: None,
    })
}

pub fn activate_stock_desktop(
    app_user_model_id: &str,
) -> Result<WindowsDesktopProcess, PlatformError> {
    let _apartment = ComApartment::initialize()?;
    let manager: IApplicationActivationManager =
        unsafe { CoCreateInstance(&ApplicationActivationManager, None, CLSCTX_LOCAL_SERVER) }
            .map_err(|error| windows_error("cannot initialize AppX activation manager", error))?;
    let activation_process_id = unsafe {
        manager.ActivateApplication(
            &HSTRING::from(app_user_model_id),
            &HSTRING::new(),
            ACTIVATEOPTIONS(0),
        )
    }
    .map_err(|error| windows_error("cannot activate stock Codex Desktop", error))?;
    wait_for_desktop_root(activation_process_id, Duration::from_secs(5))
}

#[cfg(test)]
mod tests {
    use std::ffi::{OsStr, OsString};

    use super::{quote_windows_argument, windows_command_line, windows_environment_block};

    #[test]
    fn quotes_packaged_activation_arguments() {
        assert_eq!(quote_windows_argument(OsStr::new("plain")), "plain");
        assert_eq!(
            quote_windows_argument(OsStr::new("two words")),
            "\"two words\""
        );
        assert_eq!(
            windows_command_line(&[
                OsString::from("--inspect=127.0.0.1:43123"),
                OsString::from("two words"),
            ]),
            "--inspect=127.0.0.1:43123 \"two words\""
        );
    }

    #[test]
    fn builds_a_sorted_double_nul_environment_block() {
        let block = windows_environment_block(&[
            (OsString::from("z"), OsString::from("last")),
            (OsString::from("A"), OsString::from("first")),
        ])
        .expect("valid environment");
        let expected = "A=first\0z=last\0\0".encode_utf16().collect::<Vec<_>>();
        assert_eq!(block, expected);
        assert_eq!(
            windows_environment_block(&[]).expect("empty environment"),
            [0, 0]
        );
        assert!(
            windows_environment_block(&[(OsString::from("bad=name"), OsString::new())]).is_err()
        );
    }
}
