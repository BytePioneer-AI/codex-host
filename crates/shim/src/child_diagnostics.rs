//! Child stderr observation used to keep a failed Host Runtime's own diagnostic visible.

use std::io::{self, Read, Write};
use std::process::ExitStatus;

/// Retains the last complete non-empty line of a byte stream without buffering the stream.
#[derive(Default)]
struct LastLine {
    current: Vec<u8>,
    last: Vec<u8>,
}

impl LastLine {
    const MAX_BYTES: usize = 2 * 1024;

    fn observe(&mut self, bytes: &[u8]) {
        for byte in bytes {
            if matches!(byte, b'\n' | b'\r') {
                self.finish_line();
            } else if self.current.len() < Self::MAX_BYTES {
                self.current.push(*byte);
            }
        }
    }

    fn finish_line(&mut self) {
        if self.current.iter().any(|byte| !byte.is_ascii_whitespace()) {
            std::mem::swap(&mut self.last, &mut self.current);
        }
        self.current.clear();
    }

    fn into_line(mut self) -> Option<String> {
        self.finish_line();
        let line = String::from_utf8_lossy(&self.last).trim().to_owned();
        (!line.is_empty()).then_some(line)
    }
}

/// Copies a child's stderr byte-for-byte and reports its last non-empty line.
pub(super) fn copy_stream_with_last_line<R, W>(
    mut reader: R,
    mut writer: W,
) -> io::Result<Option<String>>
where
    R: Read,
    W: Write,
{
    let mut buffer = [0_u8; 16 * 1024];
    let mut last_line = LastLine::default();
    loop {
        let count = match reader.read(&mut buffer) {
            Ok(0) => return Ok(last_line.into_line()),
            Ok(count) => count,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        };
        writer.write_all(&buffer[..count])?;
        writer.flush()?;
        last_line.observe(&buffer[..count]);
    }
}

pub(super) fn host_runtime_failure_summary(status: &ExitStatus, last_line: Option<&str>) -> String {
    let outcome = match (status.code(), super::exit_signal(status)) {
        (_, Some(signal)) => format!("terminated by signal {signal}"),
        (Some(code), None) => format!("exited with code {code}"),
        (None, None) => "exited unsuccessfully".to_owned(),
    };
    match last_line {
        Some(line) => format!("codexhost shim: Host Runtime {outcome}: {line}"),
        None => format!("codexhost shim: Host Runtime {outcome} without diagnostics"),
    }
}

#[cfg(test)]
mod tests {
    use super::{LastLine, copy_stream_with_last_line, host_runtime_failure_summary};

    #[test]
    fn remembers_the_last_non_empty_stderr_line_across_chunks() {
        let mut last_line = LastLine::default();
        last_line.observe(b"codexhost Host Runtime: Host initialization ");
        last_line.observe(b"failed: Another codexhost process owns Mapping Store\n\n  \r\n");
        assert_eq!(
            last_line.into_line().as_deref(),
            Some(
                "codexhost Host Runtime: Host initialization failed: Another codexhost process owns Mapping Store"
            )
        );

        let mut unterminated = LastLine::default();
        unterminated.observe(b"first\nsecond without newline");
        assert_eq!(
            unterminated.into_line().as_deref(),
            Some("second without newline")
        );
        assert_eq!(LastLine::default().into_line(), None);
    }

    #[test]
    fn copies_stderr_bytes_unchanged_while_tracking_the_last_line() {
        let input = b"\xffraw\nlast line\n".to_vec();
        let mut output = Vec::new();
        let last = copy_stream_with_last_line(input.as_slice(), &mut output).expect("copy stderr");
        assert_eq!(output, input);
        assert_eq!(last.as_deref(), Some("last line"));
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn summarizes_a_failed_host_runtime_with_its_last_diagnostic() {
        use std::os::unix::process::ExitStatusExt;

        let failed = std::process::ExitStatus::from_raw(1 << 8);
        assert_eq!(
            host_runtime_failure_summary(&failed, Some("Host initialization failed: locked")),
            "codexhost shim: Host Runtime exited with code 1: Host initialization failed: locked"
        );
        assert_eq!(
            host_runtime_failure_summary(&failed, None),
            "codexhost shim: Host Runtime exited with code 1 without diagnostics"
        );
    }
}
