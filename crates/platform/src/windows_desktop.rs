use std::ffi::{OsStr, OsString};
use std::io;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::process::ExitStatusExt;
use std::process::{Child, ExitStatus};
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
    GetExitCodeProcess, GetProcessIdOfThread, OpenProcess, OpenThread,
    PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE, ResumeThread,
    THREAD_QUERY_LIMITED_INFORMATION, THREAD_SUSPEND_RESUME, TerminateProcess, WaitForSingleObject,
};
use windows::Win32::UI::Shell::{
    ACTIVATEOPTIONS, ApplicationActivationManager, IApplicationActivationManager,
    IPackageDebugSettings, PackageDebugSettings,
};
use windows::core::{HSTRING, Owned};

use super::process::desktop_root_process_ids;
use super::{APPX_RESUME_ARGUMENT, PlatformError};

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
        let debugger_executable = std::env::current_exe().map_err(PlatformError::Io)?;
        let debugger_command = windows_command_line(&[
            debugger_executable.into_os_string(),
            OsString::from(APPX_RESUME_ARGUMENT),
        ]);
        let debugger_command = debugger_command
            .encode_wide()
            .chain([0])
            .collect::<Vec<_>>();
        let settings: IPackageDebugSettings =
            unsafe { CoCreateInstance(&PackageDebugSettings, None, CLSCTX_INPROC_SERVER) }
                .map_err(|error| {
                    windows_error("cannot initialize AppX package environment", error)
                })?;
        let package_full_name = HSTRING::from(package_full_name);
        // Debug settings persist if a previous Launcher is force-terminated.
        // Clear any stale registration before replacing it for this activation.
        let _ = unsafe { settings.DisableDebugging(&package_full_name) };
        unsafe {
            // Windows 10 rejects a non-empty environment with E_INVALIDARG
            // unless a debugger command is also supplied. AppX appends
            // `-p <pid> -tid <tid>` and starts this helper while the application
            // thread is suspended; the helper validates and resumes that thread.
            settings.EnableDebugging(
                &package_full_name,
                windows::core::PCWSTR(debugger_command.as_ptr()),
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

enum WindowsDesktopBacking {
    Child(Child),
    Activated(Owned<HANDLE>),
}

pub struct WindowsDesktopProcess {
    process_id: u32,
    process: WindowsDesktopBacking,
    status: Option<ExitStatus>,
}

impl WindowsDesktopProcess {
    pub fn from_child(child: Child) -> Self {
        Self {
            process_id: child.id(),
            process: WindowsDesktopBacking::Child(child),
            status: None,
        }
    }

    #[must_use]
    pub fn id(&self) -> u32 {
        self.process_id
    }

    pub fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        if let Some(status) = self.status {
            return Ok(Some(status));
        }
        if let WindowsDesktopBacking::Child(child) = &mut self.process {
            return child.try_wait();
        }
        let WindowsDesktopBacking::Activated(process) = &self.process else {
            unreachable!("child process handled above")
        };
        let result = unsafe { WaitForSingleObject(**process, 0) };
        if result == WAIT_TIMEOUT {
            return Ok(None);
        }
        if result != WAIT_OBJECT_0 {
            return Err(io::Error::last_os_error());
        }
        let mut exit_code = STILL_ACTIVE.0 as u32;
        unsafe { GetExitCodeProcess(**process, &mut exit_code) }
            .map_err(|error| io::Error::other(format!("cannot read Desktop exit code: {error}")))?;
        let status = ExitStatus::from_raw(exit_code);
        self.status = Some(status);
        Ok(Some(status))
    }

    pub fn wait(&mut self) -> io::Result<ExitStatus> {
        if let Some(status) = self.status {
            return Ok(status);
        }
        if let WindowsDesktopBacking::Child(child) = &mut self.process {
            return child.wait();
        }
        let WindowsDesktopBacking::Activated(process) = &self.process else {
            unreachable!("child process handled above")
        };
        let result = unsafe { WaitForSingleObject(**process, u32::MAX) };
        if result != WAIT_OBJECT_0 {
            return Err(io::Error::last_os_error());
        }
        self.try_wait()?.ok_or_else(|| {
            io::Error::other("packaged Codex Desktop remained active after its wait completed")
        })
    }

    pub fn kill(&mut self) -> io::Result<()> {
        if let WindowsDesktopBacking::Child(child) = &mut self.process {
            return child.kill();
        }
        let WindowsDesktopBacking::Activated(process) = &self.process else {
            unreachable!("child process handled above")
        };
        unsafe { TerminateProcess(**process, 1) }
            .map_err(|error| io::Error::other(format!("cannot terminate Desktop: {error}")))
    }
}

struct ActivatedProcessGuard {
    process: Option<WindowsDesktopProcess>,
}

impl ActivatedProcessGuard {
    fn new(process: WindowsDesktopProcess) -> Self {
        Self {
            process: Some(process),
        }
    }

    fn disarm(mut self) -> WindowsDesktopProcess {
        self.process.take().expect("armed activated process")
    }
}

impl Drop for ActivatedProcessGuard {
    fn drop(&mut self) {
        let Some(process) = &mut self.process else {
            return;
        };
        if process.try_wait().ok().flatten().is_none() && process.kill().is_ok() {
            let _ = process.wait();
        }
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

/// Resume the initial thread created by AppX package debugging.
///
/// This is an internal Launcher entry point. Windows supplies both identifiers;
/// checking their relationship prevents the helper from resuming an unrelated
/// thread if it is invoked manually with mismatched arguments.
pub fn resume_packaged_application(arguments: &[String]) -> Result<(), PlatformError> {
    let [process_flag, process_id, thread_flag, thread_id] = arguments else {
        return Err(PlatformError::Invalid(
            "AppX resume helper requires '-p <pid> -tid <tid>'".into(),
        ));
    };
    if process_flag != "-p" || thread_flag != "-tid" {
        return Err(PlatformError::Invalid(
            "AppX resume helper received invalid process arguments".into(),
        ));
    }
    let process_id = process_id
        .parse::<u32>()
        .map_err(|_| PlatformError::Invalid("AppX resume helper received an invalid PID".into()))?;
    let thread_id = thread_id
        .parse::<u32>()
        .map_err(|_| PlatformError::Invalid("AppX resume helper received an invalid TID".into()))?;
    let thread = unsafe {
        OpenThread(
            THREAD_QUERY_LIMITED_INFORMATION | THREAD_SUSPEND_RESUME,
            false,
            thread_id,
        )
    }
    .map_err(|error| windows_error("cannot open the suspended AppX thread", error))?;
    let thread = unsafe { Owned::new(thread) };
    let owner_process_id = unsafe { GetProcessIdOfThread(*thread) };
    if owner_process_id == 0 {
        return Err(PlatformError::Io(io::Error::last_os_error()));
    }
    if owner_process_id != process_id {
        return Err(PlatformError::Invalid(
            "AppX resume helper received a thread owned by another process".into(),
        ));
    }
    let previous_suspend_count = unsafe { ResumeThread(*thread) };
    if previous_suspend_count == u32::MAX {
        return Err(PlatformError::Io(io::Error::last_os_error()));
    }
    if previous_suspend_count == 0 {
        return Err(PlatformError::Invalid(
            "AppX resume helper received a thread that was not suspended".into(),
        ));
    }
    Ok(())
}

fn wait_for_desktop_root(
    activation_process_id: u32,
    timeout: Duration,
) -> Result<(), PlatformError> {
    let started = Instant::now();
    loop {
        match desktop_root_process_ids()?.as_slice() {
            [process_id] if *process_id == activation_process_id => {
                return Ok(());
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
    let desktop = ActivatedProcessGuard::new(supervise_desktop(activation_process_id)?);
    wait_for_desktop_root(activation_process_id, Duration::from_secs(5))?;
    package_environment.disable()?;
    Ok(desktop.disarm())
}

pub fn supervise_desktop(process_id: u32) -> Result<WindowsDesktopProcess, PlatformError> {
    let process = unsafe {
        OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE | PROCESS_TERMINATE,
            false,
            process_id,
        )
    }
    .map_err(|error| windows_error("cannot supervise activated Codex Desktop", error))?;
    Ok(WindowsDesktopProcess {
        process_id,
        process: WindowsDesktopBacking::Activated(unsafe { Owned::new(process) }),
        status: None,
    })
}

pub fn activate_stock_desktop(
    package_full_name: &str,
    app_user_model_id: &str,
) -> Result<WindowsDesktopProcess, PlatformError> {
    let _apartment = ComApartment::initialize()?;
    // Recover from a Launcher that was terminated after enabling package
    // debugging but before its normal Drop cleanup ran.
    if let Ok(settings) = unsafe {
        CoCreateInstance::<_, IPackageDebugSettings>(
            &PackageDebugSettings,
            None,
            CLSCTX_INPROC_SERVER,
        )
    } {
        let _ = unsafe { settings.DisableDebugging(&HSTRING::from(package_full_name)) };
    }
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
    let desktop = ActivatedProcessGuard::new(supervise_desktop(activation_process_id)?);
    wait_for_desktop_root(activation_process_id, Duration::from_secs(5))?;
    Ok(desktop.disarm())
}

#[cfg(test)]
mod tests {
    use std::ffi::{OsStr, OsString};
    use std::process::Command;

    use super::{
        ActivatedProcessGuard, WindowsDesktopProcess, quote_windows_argument,
        resume_packaged_application, supervise_desktop, windows_command_line,
        windows_environment_block,
    };

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
    fn rejects_invalid_appx_resume_arguments_before_opening_a_thread() {
        assert!(resume_packaged_application(&[]).is_err());
        assert!(
            resume_packaged_application(&[
                "-p".into(),
                "not-a-pid".into(),
                "-tid".into(),
                "42".into(),
            ])
            .is_err()
        );
        assert!(
            resume_packaged_application(&["--pid".into(), "1".into(), "-tid".into(), "2".into(),])
                .is_err()
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

    #[test]
    fn reads_exit_status_from_a_supervised_process() {
        let mut child = Command::new("cmd.exe")
            .args(["/d", "/c", "ping -n 2 127.0.0.1 >nul & exit /b 7"])
            .spawn()
            .expect("spawn supervised process fixture");
        let mut process = supervise_desktop(child.id()).expect("supervise process fixture");

        let status = process.wait().expect("read supervised process exit status");
        let _ = child.wait();

        assert_eq!(status.code(), Some(7));
    }

    #[test]
    fn armed_activation_guard_terminates_its_process() {
        let child = Command::new("cmd.exe")
            .args(["/d", "/c", "ping -n 30 127.0.0.1 >nul"])
            .spawn()
            .expect("spawn guarded process fixture");
        let process_id = child.id();
        let guard = ActivatedProcessGuard::new(WindowsDesktopProcess::from_child(child));

        drop(guard);

        assert!(!crate::process_exists(process_id));
    }
}
