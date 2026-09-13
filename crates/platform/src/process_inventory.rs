use std::io;

const MAX_EXECUTABLE_NAME_BYTES: usize = 256;
const MAX_PROCESS_IDS: usize = 10_000;

fn validate_executable_name(name: &str) -> io::Result<()> {
    if name.is_empty()
        || name.len() > MAX_EXECUTABLE_NAME_BYTES
        || name == "."
        || name == ".."
        || name.trim() != name
        || name
            .chars()
            .any(|character| character.is_control() || character == '/' || character == '\\')
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid executable name",
        ));
    }
    Ok(())
}

fn executable_basename(command: &str) -> io::Result<&str> {
    let basename = command
        .rsplit(['/', '\\'])
        .next()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "invalid process record"))?;
    Ok(basename)
}

#[cfg(not(target_os = "windows"))]
mod imp {
    use super::{MAX_PROCESS_IDS, executable_basename, validate_executable_name};
    use std::io::{self, Read};
    use std::process::{Command, Stdio};
    use std::sync::mpsc;
    use std::thread;
    use std::time::{Duration, Instant};

    const MAX_PS_OUTPUT_BYTES: usize = 1024 * 1024;
    const PS_DEADLINE: Duration = Duration::from_secs(2);
    const POLL_INTERVAL: Duration = Duration::from_millis(10);

    fn invalid_process_output() -> io::Error {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid process inventory output",
        )
    }

    fn parse_ps_output(output: &[u8], name: &str) -> io::Result<Vec<u32>> {
        if output.is_empty() || !output.ends_with(b"\n") {
            return Err(invalid_process_output());
        }
        let output = std::str::from_utf8(output).map_err(|_| invalid_process_output())?;
        let mut process_ids = Vec::new();
        let mut saw_record = false;
        for line in output.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let boundary = line
                .find(char::is_whitespace)
                .ok_or_else(invalid_process_output)?;
            let process_id = line[..boundary]
                .parse::<u32>()
                .map_err(|_| invalid_process_output())?;
            if process_id == 0 {
                return Err(invalid_process_output());
            }
            saw_record = true;
            let command = line[boundary..].trim();
            let basename = executable_basename(command)?;
            if basename == name {
                process_ids.push(process_id);
                if process_ids.len() > MAX_PROCESS_IDS {
                    return Err(io::Error::other("process inventory exceeds its limit"));
                }
            }
        }
        if !saw_record {
            return Err(invalid_process_output());
        }
        process_ids.sort_unstable();
        process_ids.dedup();
        Ok(process_ids)
    }

    fn stop_and_reap(child: &mut std::process::Child, reader: thread::JoinHandle<()>) {
        let _ = child.kill();
        let _ = child.wait();
        let _ = reader.join();
    }

    pub(super) fn process_ids_by_executable_name(name: &str) -> io::Result<Vec<u32>> {
        validate_executable_name(name)?;
        let mut child = Command::new("/bin/ps")
            .args(["-axww", "-o", "pid=", "-o", "comm="])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()?;
        let stdout = match child.stdout.take() {
            Some(stdout) => stdout,
            None => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(io::Error::other("process inventory output unavailable"));
            }
        };
        let (sender, receiver) = mpsc::sync_channel(1);
        let reader = thread::spawn(move || {
            let mut output = Vec::new();
            let result = stdout
                .take((MAX_PS_OUTPUT_BYTES + 1) as u64)
                .read_to_end(&mut output)
                .map(|_| output);
            let _ = sender.send(result);
        });
        let deadline = Instant::now() + PS_DEADLINE;
        let mut collected_output = None;
        loop {
            match receiver.try_recv() {
                Ok(result) => {
                    let output = match result {
                        Ok(output) if output.len() <= MAX_PS_OUTPUT_BYTES => output,
                        Ok(_) => {
                            stop_and_reap(&mut child, reader);
                            return Err(io::Error::other(
                                "process inventory output exceeds its limit",
                            ));
                        }
                        Err(error) => {
                            stop_and_reap(&mut child, reader);
                            return Err(error);
                        }
                    };
                    collected_output = Some(output);
                }
                Err(mpsc::TryRecvError::Empty) => {}
                Err(mpsc::TryRecvError::Disconnected) if collected_output.is_none() => {
                    stop_and_reap(&mut child, reader);
                    return Err(io::Error::other("process inventory reader failed"));
                }
                Err(mpsc::TryRecvError::Disconnected) => {}
            }
            let status = match child.try_wait() {
                Ok(status) => status,
                Err(error) => {
                    stop_and_reap(&mut child, reader);
                    return Err(error);
                }
            };
            if let Some(status) = status {
                let _ = child.wait();
                let output = match collected_output {
                    Some(output) => Ok(output),
                    None => receiver.recv().unwrap_or_else(|_| {
                        Err(io::Error::other("process inventory reader failed"))
                    }),
                };
                let _ = reader.join();
                let output = output?;
                if output.len() > MAX_PS_OUTPUT_BYTES {
                    return Err(io::Error::other(
                        "process inventory output exceeds its limit",
                    ));
                }
                if !status.success() {
                    return Err(io::Error::other("process inventory helper failed"));
                }
                return parse_ps_output(&output, name);
            }
            if Instant::now() >= deadline {
                stop_and_reap(&mut child, reader);
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "process inventory helper timed out",
                ));
            }
            thread::sleep(POLL_INTERVAL);
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn parses_only_exact_executable_basenames() {
            let output = b" 12 /usr/local/bin/codex\n13 codex-helper\n14 /tmp/codex\n";
            assert_eq!(parse_ps_output(output, "codex").unwrap(), vec![12, 14]);
        }

        #[test]
        fn rejects_malformed_or_ambiguous_records() {
            for output in [
                b"".as_slice(),
                b"\n".as_slice(),
                b"not-a-pid codex\n".as_slice(),
                b"12\n".as_slice(),
                b"12 codex".as_slice(),
                b"0 codex\n".as_slice(),
                b"12 /\n".as_slice(),
                b"\xff codex\n".as_slice(),
            ] {
                assert!(parse_ps_output(output, "codex").is_err());
            }
        }

        #[test]
        fn enumerates_the_bounded_ps_helper() {
            assert!(!process_ids_by_executable_name("ps").unwrap().is_empty());
        }
    }
}

#[cfg(target_os = "windows")]
mod imp {
    use super::{MAX_PROCESS_IDS, executable_basename, validate_executable_name};
    use std::ffi::c_void;
    use std::io;
    use std::mem::{size_of, zeroed};

    type Handle = *mut c_void;

    const INVALID_HANDLE_VALUE: Handle = -1_isize as Handle;
    const TH32CS_SNAPPROCESS: u32 = 0x0000_0002;
    const ERROR_NO_MORE_FILES: i32 = 18;

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

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CloseHandle(handle: Handle) -> i32;
        fn CreateToolhelp32Snapshot(flags: u32, process_id: u32) -> Handle;
        fn Process32FirstW(snapshot: Handle, entry: *mut NativeProcessEntry) -> i32;
        fn Process32NextW(snapshot: Handle, entry: *mut NativeProcessEntry) -> i32;
        fn GetLastError() -> u32;
    }

    struct Snapshot(Handle);

    impl Drop for Snapshot {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }

    fn entry_name(entry: &NativeProcessEntry) -> io::Result<String> {
        let length = entry
            .executable_name
            .iter()
            .position(|value| *value == 0)
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "invalid process record"))?;
        if length == 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "invalid process record",
            ));
        }
        String::from_utf16(&entry.executable_name[..length])
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "invalid process record"))
    }

    pub(super) fn process_ids_by_executable_name(name: &str) -> io::Result<Vec<u32>> {
        validate_executable_name(name)?;
        let folded_name = name.to_lowercase();
        unsafe {
            let snapshot = Snapshot(CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0));
            if snapshot.0 == INVALID_HANDLE_VALUE {
                return Err(io::Error::last_os_error());
            }
            let mut entry: NativeProcessEntry = zeroed();
            entry.size = size_of::<NativeProcessEntry>() as u32;
            if Process32FirstW(snapshot.0, &mut entry) == 0 {
                return Err(io::Error::last_os_error());
            }
            let mut process_ids = Vec::new();
            loop {
                let executable = entry_name(&entry)?;
                if executable_basename(&executable)?.to_lowercase() == folded_name {
                    if entry.process_id == 0 {
                        return Err(io::Error::new(
                            io::ErrorKind::InvalidData,
                            "invalid process record",
                        ));
                    }
                    process_ids.push(entry.process_id);
                    if process_ids.len() > MAX_PROCESS_IDS {
                        return Err(io::Error::other("process inventory exceeds its limit"));
                    }
                }
                if Process32NextW(snapshot.0, &mut entry) == 0 {
                    if GetLastError() as i32 != ERROR_NO_MORE_FILES {
                        return Err(io::Error::last_os_error());
                    }
                    break;
                }
            }
            process_ids.sort_unstable();
            process_ids.dedup();
            Ok(process_ids)
        }
    }
}

/// Returns currently observable process IDs whose executable basename exactly
/// matches `name`. This is a point-in-time inventory, not proof that another
/// matching process cannot start after the call returns.
pub fn process_ids_by_executable_name(name: &str) -> io::Result<Vec<u32>> {
    imp::process_ids_by_executable_name(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_paths_controls_whitespace_and_oversized_names() {
        for name in [
            "",
            ".",
            "..",
            " codex",
            "codex ",
            "bin/codex",
            "bin\\codex.exe",
            "codex\n",
        ] {
            assert!(validate_executable_name(name).is_err(), "accepted {name:?}");
        }
        assert!(validate_executable_name(&"x".repeat(257)).is_err());
        assert!(validate_executable_name("codex.exe").is_ok());
    }
}
