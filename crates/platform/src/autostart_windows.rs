use windows::Win32::Foundation::{ERROR_FILE_NOT_FOUND, HLOCAL, LocalFree, WIN32_ERROR};
use windows::Win32::System::Registry::{
    HKEY, HKEY_CURRENT_USER, REG_SZ, RRF_RT_REG_SZ, RegCloseKey, RegCreateKeyW, RegDeleteKeyValueW,
    RegGetValueW, RegSetKeyValueW,
};
use windows::Win32::UI::Shell::CommandLineToArgvW;
use windows::core::{HSTRING, PCWSTR, w};

use super::validate_arguments;
pub(super) use super::windows_run_command as render;
use crate::PlatformError;

const KEY: PCWSTR = w!("Software\\Microsoft\\Windows\\CurrentVersion\\Run");
const NAME: PCWSTR = w!("codexhost");

fn check(result: WIN32_ERROR) -> Result<(), PlatformError> {
    result
        .ok()
        .map_err(|error| PlatformError::Invalid(format!("autostart registry: {error}")))
}

pub(super) fn read() -> Result<Option<String>, PlatformError> {
    let mut size = 0;
    // Query size before allocating the REG_SZ buffer; neither call creates a key.
    let result = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            KEY,
            NAME,
            RRF_RT_REG_SZ,
            None,
            None,
            Some(&mut size),
        )
    };
    if result == ERROR_FILE_NOT_FOUND {
        return Ok(None);
    }
    check(result)?;
    let mut buffer = vec![0u16; (size as usize).div_ceil(2)];
    unsafe {
        check(RegGetValueW(
            HKEY_CURRENT_USER,
            KEY,
            NAME,
            RRF_RT_REG_SZ,
            None,
            Some(buffer.as_mut_ptr().cast()),
            Some(&mut size),
        ))?;
    }
    let end = buffer
        .iter()
        .position(|value| *value == 0)
        .unwrap_or(buffer.len());
    String::from_utf16(&buffer[..end])
        .map(Some)
        .map_err(|error| {
            PlatformError::Invalid(format!("invalid autostart registry string: {error}"))
        })
}

pub(super) fn validate(content: &str) -> Result<(), PlatformError> {
    let command = HSTRING::from(content);
    let mut count = 0;
    // Windows owns the argument decoding, including quoted paths and backslashes.
    let arguments = unsafe { CommandLineToArgvW(&command, &mut count) };
    if arguments.is_null() {
        return Err(std::io::Error::last_os_error().into());
    }
    let decoded = unsafe {
        let result = std::slice::from_raw_parts(arguments, count as usize)
            .iter()
            .map(|argument| argument.to_string())
            .collect::<Result<Vec<_>, _>>();
        let _ = LocalFree(Some(HLOCAL(arguments.cast())));
        result
    }
    .map_err(|error| PlatformError::Invalid(format!("invalid autostart command: {error}")))?;
    validate_arguments(&decoded)
}

pub(super) fn write(command: &str) -> Result<(), PlatformError> {
    let data = command
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let mut key = HKEY::default();
    // Only HKCU is touched. Keep the key alive until RegSetKeyValueW returns.
    unsafe {
        check(RegCreateKeyW(HKEY_CURRENT_USER, KEY, &mut key))?;
        let result = RegSetKeyValueW(
            key,
            PCWSTR::null(),
            NAME,
            REG_SZ.0,
            Some(data.as_ptr().cast()),
            (data.len() * 2) as u32,
        );
        let _ = RegCloseKey(key);
        check(result)
    }
}

pub(super) fn remove() -> Result<(), PlatformError> {
    let result = unsafe { RegDeleteKeyValueW(HKEY_CURRENT_USER, KEY, NAME) };
    if result == ERROR_FILE_NOT_FOUND {
        Ok(())
    } else {
        check(result)
    }
}
