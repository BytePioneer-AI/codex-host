use std::ffi::c_void;
use std::io;
use std::mem::size_of;
use std::path::PathBuf;

pub type Handle = *mut c_void;

const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x0000_1000;
const PROCESS_VM_READ: u32 = 0x0000_0010;
const TOKEN_QUERY: u32 = 0x0000_0008;
const TOKEN_USER_INFORMATION_CLASS: u32 = 1;
const MAX_PROCESS_ENVIRONMENT_BYTES: usize = 8 * 1024 * 1024;
const PROCESS_ENVIRONMENT_READ_CHUNK_BYTES: usize = 4096;

#[repr(C)]
struct ProcessBasicInformation {
    reserved1: *mut c_void,
    peb_base_address: *mut Peb,
    reserved2: [*mut c_void; 2],
    unique_process_id: usize,
    reserved3: *mut c_void,
}

#[repr(C)]
struct Peb {
    reserved1: [u8; 2],
    being_debugged: u8,
    reserved2: [u8; 1],
    reserved3: [*mut c_void; 2],
    loader_data: *mut c_void,
    process_parameters: *mut RtlUserProcessParameters,
}

#[repr(C)]
struct UnicodeString {
    length: u16,
    maximum_length: u16,
    buffer: *mut u16,
}

#[repr(C)]
struct CurrentDirectory {
    path: UnicodeString,
    handle: Handle,
}

#[repr(C)]
struct RtlUserProcessParameters {
    maximum_length: u32,
    length: u32,
    flags: u32,
    debug_flags: u32,
    console_handle: Handle,
    console_flags: u32,
    standard_input: Handle,
    standard_output: Handle,
    standard_error: Handle,
    current_directory: CurrentDirectory,
    dll_path: UnicodeString,
    image_path_name: UnicodeString,
    command_line: UnicodeString,
    environment: *mut c_void,
}

#[repr(C)]
struct SidAndAttributes {
    sid: *mut c_void,
    attributes: u32,
}

#[repr(C)]
struct TokenUser {
    user: SidAndAttributes,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct FileTime {
    low_date_time: u32,
    high_date_time: u32,
}

#[link(name = "kernel32")]
unsafe extern "system" {
    fn CloseHandle(handle: Handle) -> i32;
    fn OpenProcess(desired_access: u32, inherit_handle: i32, process_id: u32) -> Handle;
    fn GetCurrentProcess() -> Handle;
    fn ReadProcessMemory(
        process: Handle,
        base_address: *const c_void,
        buffer: *mut c_void,
        size: usize,
        bytes_read: *mut usize,
    ) -> i32;
    fn QueryFullProcessImageNameW(
        process: Handle,
        flags: u32,
        name: *mut u16,
        size: *mut u32,
    ) -> i32;
    fn GetProcessTimes(
        process: Handle,
        creation_time: *mut FileTime,
        exit_time: *mut FileTime,
        kernel_time: *mut FileTime,
        user_time: *mut FileTime,
    ) -> i32;
}

#[link(name = "advapi32")]
unsafe extern "system" {
    fn OpenProcessToken(process: Handle, desired_access: u32, token: *mut Handle) -> i32;
    fn GetTokenInformation(
        token: Handle,
        information_class: u32,
        information: *mut c_void,
        information_length: u32,
        return_length: *mut u32,
    ) -> i32;
    fn EqualSid(first: *const c_void, second: *const c_void) -> i32;
}

#[link(name = "ntdll")]
unsafe extern "system" {
    fn NtQueryInformationProcess(
        process: Handle,
        information_class: u32,
        information: *mut c_void,
        information_length: u32,
        return_length: *mut u32,
    ) -> i32;
}

fn process_image_path(process: Handle) -> io::Result<PathBuf> {
    unsafe {
        let mut buffer = vec![0_u16; 32_768];
        let mut length = buffer.len() as u32;
        let result = QueryFullProcessImageNameW(process, 0, buffer.as_mut_ptr(), &mut length);
        if result == 0 {
            return Err(io::Error::last_os_error());
        }
        buffer.truncate(length as usize);
        Ok(PathBuf::from(String::from_utf16_lossy(&buffer)))
    }
}

fn process_started_at_micros(process: Handle) -> io::Result<u64> {
    let mut creation_time = FileTime::default();
    let mut exit_time = FileTime::default();
    let mut kernel_time = FileTime::default();
    let mut user_time = FileTime::default();
    let result = unsafe {
        GetProcessTimes(
            process,
            &mut creation_time,
            &mut exit_time,
            &mut kernel_time,
            &mut user_time,
        )
    };
    if result == 0 {
        return Err(io::Error::last_os_error());
    }
    let ticks =
        (u64::from(creation_time.high_date_time) << 32) | u64::from(creation_time.low_date_time);
    Ok(ticks / 10)
}

fn token_user_buffer(token: Handle) -> io::Result<Vec<u8>> {
    unsafe {
        let mut length = 0_u32;
        GetTokenInformation(
            token,
            TOKEN_USER_INFORMATION_CLASS,
            std::ptr::null_mut(),
            0,
            &mut length,
        );
        if length < size_of::<TokenUser>() as u32 {
            return Err(io::Error::last_os_error());
        }
        let mut buffer = vec![0_u8; length as usize];
        let result = GetTokenInformation(
            token,
            TOKEN_USER_INFORMATION_CLASS,
            buffer.as_mut_ptr().cast(),
            length,
            &mut length,
        );
        if result == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(buffer)
    }
}

fn belongs_to_current_user(process: Handle) -> io::Result<bool> {
    unsafe {
        let mut target_token: Handle = std::ptr::null_mut();
        if OpenProcessToken(process, TOKEN_QUERY, &mut target_token) == 0 {
            return Err(io::Error::last_os_error());
        }
        let mut current_token: Handle = std::ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut current_token) == 0 {
            let error = io::Error::last_os_error();
            CloseHandle(target_token);
            return Err(error);
        }
        let target = token_user_buffer(target_token);
        let current = token_user_buffer(current_token);
        CloseHandle(target_token);
        CloseHandle(current_token);
        let target = target?;
        let current = current?;
        let target_user = std::ptr::read_unaligned(target.as_ptr().cast::<TokenUser>());
        let current_user = std::ptr::read_unaligned(current.as_ptr().cast::<TokenUser>());
        if target_user.user.sid.is_null() || current_user.user.sid.is_null() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "process token has no user SID",
            ));
        }
        Ok(EqualSid(target_user.user.sid, current_user.user.sid) != 0)
    }
}

unsafe fn read_structure<T>(process: Handle, address: *const T) -> io::Result<T> {
    let mut value = std::mem::MaybeUninit::<T>::uninit();
    let mut bytes_read = 0_usize;
    let result = unsafe {
        ReadProcessMemory(
            process,
            address.cast(),
            value.as_mut_ptr().cast(),
            size_of::<T>(),
            &mut bytes_read,
        )
    };
    if result == 0 || bytes_read != size_of::<T>() {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { value.assume_init() })
}

fn process_parameters(process: Handle) -> io::Result<RtlUserProcessParameters> {
    unsafe {
        let mut information = std::mem::MaybeUninit::<ProcessBasicInformation>::zeroed();
        let status = NtQueryInformationProcess(
            process,
            0,
            information.as_mut_ptr().cast(),
            size_of::<ProcessBasicInformation>() as u32,
            std::ptr::null_mut(),
        );
        if status != 0 {
            return Err(io::Error::other(format!(
                "NtQueryInformationProcess failed with status 0x{status:08x}"
            )));
        }
        let information = information.assume_init();
        if information.peb_base_address.is_null() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "process has no PEB",
            ));
        }
        let peb = read_structure(process, information.peb_base_address)?;
        if peb.process_parameters.is_null() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "process has no process parameters",
            ));
        }
        read_structure(process, peb.process_parameters)
    }
}

fn process_command_line(process: Handle, command_line: &UnicodeString) -> io::Result<String> {
    if command_line.length == 0 || command_line.buffer.is_null() {
        return Ok(String::new());
    }
    let length = usize::from(command_line.length);
    if length % 2 != 0 || length > 64 * 1024 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid process command line length",
        ));
    }
    let mut bytes = vec![0_u8; length];
    let mut bytes_read = 0_usize;
    let result = unsafe {
        ReadProcessMemory(
            process,
            command_line.buffer.cast(),
            bytes.as_mut_ptr().cast(),
            bytes.len(),
            &mut bytes_read,
        )
    };
    if result == 0 || bytes_read != bytes.len() {
        return Err(io::Error::last_os_error());
    }
    let units = bytes
        .chunks_exact(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .collect::<Vec<_>>();
    String::from_utf16(&units)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "invalid command line UTF-16"))
}

fn process_environment_block(
    process: Handle,
    parameters: &RtlUserProcessParameters,
) -> io::Result<Vec<u16>> {
    unsafe {
        if parameters.environment.is_null() {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                "process has no environment block",
            ));
        }
        let mut bytes = Vec::new();
        while bytes.len() < MAX_PROCESS_ENVIRONMENT_BYTES {
            let remaining = MAX_PROCESS_ENVIRONMENT_BYTES - bytes.len();
            let length = remaining.min(PROCESS_ENVIRONMENT_READ_CHUNK_BYTES);
            let mut chunk = vec![0_u8; length];
            let mut bytes_read = 0_usize;
            let result = ReadProcessMemory(
                process,
                parameters.environment.cast::<u8>().add(bytes.len()).cast(),
                chunk.as_mut_ptr().cast(),
                chunk.len(),
                &mut bytes_read,
            );
            if bytes_read == 0 {
                return Err(if result == 0 {
                    io::Error::last_os_error()
                } else {
                    io::Error::new(io::ErrorKind::UnexpectedEof, "empty environment read")
                });
            }
            chunk.truncate(bytes_read);
            bytes.extend_from_slice(&chunk);
            let units = bytes
                .chunks_exact(2)
                .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
                .collect::<Vec<_>>();
            if let Some(end) = units.windows(2).position(|pair| pair == [0, 0]) {
                return Ok(units[..end].to_vec());
            }
            if result == 0 {
                return Err(io::Error::last_os_error());
            }
        }
        Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "process environment exceeds byte limit",
        ))
    }
}

fn environment_variable(block: &[u16], name: &str) -> io::Result<Option<String>> {
    if name.is_empty()
        || name
            .chars()
            .any(|character| matches!(character, '=' | '\0'))
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid environment variable name",
        ));
    }
    for entry in block.split(|unit| *unit == 0) {
        if entry.is_empty() {
            continue;
        }
        let entry = String::from_utf16(entry).map_err(|_| {
            io::Error::new(io::ErrorKind::InvalidData, "invalid environment UTF-16")
        })?;
        let Some((entry_name, value)) = entry.split_once('=') else {
            continue;
        };
        if !entry_name.is_empty() && entry_name.eq_ignore_ascii_case(name) {
            return Ok(Some(value.to_owned()));
        }
    }
    Ok(None)
}

pub struct ProcessEnvironmentValue {
    pub executable: PathBuf,
    pub command_line: String,
    pub started_at_micros: u64,
    pub value: String,
}

pub fn process_environment_variable(
    process_id: u32,
    name: &str,
) -> io::Result<Option<ProcessEnvironmentValue>> {
    unsafe {
        let process = OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ,
            0,
            process_id,
        );
        if process.is_null() {
            return Err(io::Error::last_os_error());
        }
        let result = (|| {
            if !belongs_to_current_user(process)? {
                return Ok(None);
            }
            let executable = process_image_path(process)?;
            let started_at_micros = process_started_at_micros(process)?;
            let parameters = process_parameters(process)?;
            let command_line = process_command_line(process, &parameters.command_line)?;
            let Some(value) =
                environment_variable(&process_environment_block(process, &parameters)?, name)?
            else {
                return Ok(None);
            };
            Ok(Some(ProcessEnvironmentValue {
                executable,
                command_line,
                started_at_micros,
                value,
            }))
        })();
        CloseHandle(process);
        result
    }
}

#[cfg(test)]
mod tests {
    use super::process_environment_variable;

    #[test]
    fn reads_current_process_environment_without_persisting_it() {
        let expected = std::env::var("PATH").expect("PATH environment variable");
        let observed = process_environment_variable(std::process::id(), "path")
            .expect("read current process environment")
            .expect("current process PATH");
        assert_eq!(observed.value, expected);
        assert_eq!(
            observed.executable,
            std::env::current_exe().expect("current executable path")
        );
    }
}
