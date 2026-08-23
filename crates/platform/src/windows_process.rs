use std::ffi::c_void;
use std::io;
use std::mem::{size_of, zeroed};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::AsRawHandle;
use std::path::PathBuf;
use std::process::Child;
use std::ptr::null;

type Handle = *mut c_void;

const INVALID_HANDLE_VALUE: Handle = -1_isize as Handle;
const TH32CS_SNAPPROCESS: u32 = 0x0000_0002;
const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x0000_1000;
const PROCESS_TERMINATE: u32 = 0x0000_0001;
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS: i32 = 9;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x0000_2000;
const MOVE_FILE_REPLACE_EXISTING: u32 = 0x0000_0001;
const MOVE_FILE_WRITE_THROUGH: u32 = 0x0000_0008;

#[repr(C)]
struct NativeProcessEntry {
    size: u32,
    usage: u32,
    process_id: u32,
    default_heap_id: usize,
    module_id: u32,
    thread_count: u32,
    parent_process_id: u32,
    base_priority: i32,
    flags: u32,
    executable_name: [u16; 260],
}

#[repr(C)]
struct BasicLimitInformation {
    per_process_user_time_limit: i64,
    per_job_user_time_limit: i64,
    limit_flags: u32,
    minimum_working_set_size: usize,
    maximum_working_set_size: usize,
    active_process_limit: u32,
    affinity: usize,
    priority_class: u32,
    scheduling_class: u32,
}

#[repr(C)]
struct IoCounters {
    read_operation_count: u64,
    write_operation_count: u64,
    other_operation_count: u64,
    read_transfer_count: u64,
    write_transfer_count: u64,
    other_transfer_count: u64,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct FileTime {
    low_date_time: u32,
    high_date_time: u32,
}

#[repr(C)]
struct ExtendedLimitInformation {
    basic_limit_information: BasicLimitInformation,
    io_info: IoCounters,
    process_memory_limit: usize,
    job_memory_limit: usize,
    peak_process_memory_used: usize,
    peak_job_memory_used: usize,
}

#[link(name = "kernel32")]
unsafe extern "system" {
    fn CloseHandle(handle: Handle) -> i32;
    fn CreateToolhelp32Snapshot(flags: u32, process_id: u32) -> Handle;
    fn Process32FirstW(snapshot: Handle, entry: *mut NativeProcessEntry) -> i32;
    fn Process32NextW(snapshot: Handle, entry: *mut NativeProcessEntry) -> i32;
    fn OpenProcess(desired_access: u32, inherit_handle: i32, process_id: u32) -> Handle;
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
    fn CreateJobObjectW(attributes: *const c_void, name: *const u16) -> Handle;
    fn SetInformationJobObject(
        job: Handle,
        information_class: i32,
        information: *const c_void,
        information_length: u32,
    ) -> i32;
    fn AssignProcessToJobObject(job: Handle, process: Handle) -> i32;
    fn TerminateJobObject(job: Handle, exit_code: u32) -> i32;
    fn TerminateProcess(process: Handle, exit_code: u32) -> i32;
    fn MoveFileExW(existing: *const u16, replacement: *const u16, flags: u32) -> i32;
}

#[derive(Clone, Copy)]
pub struct ProcessEntry {
    pub id: u32,
    pub parent_id: u32,
}

pub struct ChildJob(Handle);

impl ChildJob {
    pub fn terminate(&self, exit_code: u32) -> io::Result<()> {
        let result = unsafe { TerminateJobObject(self.0, exit_code) };
        if result == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }
}

impl Drop for ChildJob {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}

pub fn process_entries() -> io::Result<Vec<ProcessEntry>> {
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return Err(io::Error::last_os_error());
        }
        let mut entry: NativeProcessEntry = zeroed();
        entry.size = size_of::<NativeProcessEntry>() as u32;
        let mut entries = Vec::new();
        if Process32FirstW(snapshot, &mut entry) != 0 {
            loop {
                entries.push(ProcessEntry {
                    id: entry.process_id,
                    parent_id: entry.parent_process_id,
                });
                if Process32NextW(snapshot, &mut entry) == 0 {
                    break;
                }
            }
        }
        CloseHandle(snapshot);
        Ok(entries)
    }
}

pub fn process_image_path(process_id: u32) -> io::Result<PathBuf> {
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, process_id);
        if process.is_null() {
            return Err(io::Error::last_os_error());
        }
        let mut buffer = vec![0_u16; 32_768];
        let mut length = buffer.len() as u32;
        let result = QueryFullProcessImageNameW(process, 0, buffer.as_mut_ptr(), &mut length);
        CloseHandle(process);
        if result == 0 {
            return Err(io::Error::last_os_error());
        }
        buffer.truncate(length as usize);
        Ok(PathBuf::from(String::from_utf16_lossy(&buffer)))
    }
}

fn process_started_at_micros_from_handle(process: Handle) -> io::Result<u64> {
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

pub fn process_started_at_micros(process_id: u32) -> io::Result<u64> {
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, process_id);
        if process.is_null() {
            return Err(io::Error::last_os_error());
        }
        let result = process_started_at_micros_from_handle(process);
        CloseHandle(process);
        result
    }
}

pub fn terminate_process_instance(
    process_id: u32,
    expected_started_at_micros: u64,
    exit_code: u32,
) -> io::Result<bool> {
    unsafe {
        let process = OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE,
            0,
            process_id,
        );
        if process.is_null() {
            return Ok(false);
        }
        let current_started_at_micros = match process_started_at_micros_from_handle(process) {
            Ok(value) => value,
            Err(error) => {
                CloseHandle(process);
                return Err(error);
            }
        };
        if current_started_at_micros != expected_started_at_micros {
            CloseHandle(process);
            return Ok(false);
        }
        let result = TerminateProcess(process, exit_code);
        let error = if result == 0 {
            Some(io::Error::last_os_error())
        } else {
            None
        };
        CloseHandle(process);
        match error {
            Some(error) => Err(error),
            None => Ok(true),
        }
    }
}

pub fn terminate_process(process_id: u32, exit_code: u32) -> io::Result<()> {
    unsafe {
        let process = OpenProcess(PROCESS_TERMINATE, 0, process_id);
        if process.is_null() {
            return Err(io::Error::last_os_error());
        }
        let result = TerminateProcess(process, exit_code);
        let error = if result == 0 {
            Some(io::Error::last_os_error())
        } else {
            None
        };
        CloseHandle(process);
        match error {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }
}

pub fn atomic_replace_file(source: &std::path::Path, target: &std::path::Path) -> io::Result<()> {
    let source = source
        .as_os_str()
        .encode_wide()
        .chain([0])
        .collect::<Vec<_>>();
    let target = target
        .as_os_str()
        .encode_wide()
        .chain([0])
        .collect::<Vec<_>>();
    let result = unsafe {
        MoveFileExW(
            source.as_ptr(),
            target.as_ptr(),
            MOVE_FILE_REPLACE_EXISTING | MOVE_FILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

pub fn guard_child(child: &Child) -> io::Result<ChildJob> {
    unsafe {
        let job = CreateJobObjectW(null(), null());
        if job.is_null() {
            return Err(io::Error::last_os_error());
        }
        let mut information: ExtendedLimitInformation = zeroed();
        information.basic_limit_information.limit_flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let configured = SetInformationJobObject(
            job,
            JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS,
            &information as *const _ as *const c_void,
            size_of::<ExtendedLimitInformation>() as u32,
        );
        let assigned = if configured != 0 {
            AssignProcessToJobObject(job, child.as_raw_handle() as Handle)
        } else {
            0
        };
        if configured == 0 || assigned == 0 {
            let error = io::Error::last_os_error();
            CloseHandle(job);
            return Err(error);
        }
        Ok(ChildJob(job))
    }
}
