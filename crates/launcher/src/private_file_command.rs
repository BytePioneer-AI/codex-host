//! Bounded generic file IPC. Never log request contents, paths, or parser causes.
use std::error::Error;
use std::io::{self, BufRead, Read, Write};
use std::path::PathBuf;

use codexhost_platform::{PRIVATE_FILE_LIMIT, PrivateDirectory};
use serde::Deserialize;
use serde_json::{Value, json};

const REQUEST_LIMIT: usize = PRIVATE_FILE_LIMIT * 4 + 16_384;

#[derive(Deserialize)]
#[serde(tag = "operation", rename_all = "kebab-case", deny_unknown_fields)]
enum Request {
    EnsureDirectory {
        directory: PathBuf,
        #[serde(default)]
        allow_read_only_directory: bool,
    },
    Read {
        directory: PathBuf,
        name: String,
        #[serde(default)]
        allow_read_only_directory: bool,
    },
    Replace {
        directory: PathBuf,
        name: String,
        content: Vec<u8>,
        expected: Option<String>,
        #[serde(default)]
        allow_read_only_directory: bool,
    },
    Remove {
        directory: PathBuf,
        name: String,
        expected: String,
        #[serde(default)]
        allow_read_only_directory: bool,
    },
    Lock {
        directory: PathBuf,
        name: String,
        #[serde(default)]
        allow_read_only_directory: bool,
    },
}

fn request(reader: &mut impl BufRead, allow_eof: bool) -> io::Result<Option<Request>> {
    let mut line = Vec::new();
    reader
        .take((REQUEST_LIMIT + 1) as u64)
        .read_until(b'\n', &mut line)?;
    if line.is_empty() && allow_eof {
        return Ok(None);
    }
    if line.len() > REQUEST_LIMIT || line.last() != Some(&b'\n') {
        return Err(io::Error::other("invalid private-file request"));
    }
    serde_json::from_slice(&line)
        .map(Some)
        .map_err(|_| io::Error::other("invalid private-file request"))
}

fn operation(request: Request) -> io::Result<Value> {
    match request {
        Request::EnsureDirectory {
            directory,
            allow_read_only_directory,
        } => {
            PrivateDirectory::open_with_read_only_directory_access(
                &directory,
                true,
                allow_read_only_directory,
            )?;
            Ok(json!({"ok": true}))
        }
        Request::Read {
            directory,
            name,
            allow_read_only_directory,
        } => {
            let bytes = PrivateDirectory::open_with_read_only_directory_access(
                &directory,
                false,
                allow_read_only_directory,
            )?
            .read(&name)?;
            Ok(json!({"content": bytes}))
        }
        Request::Replace {
            directory,
            name,
            content,
            expected,
            allow_read_only_directory,
        } => {
            PrivateDirectory::open_with_read_only_directory_access(
                &directory,
                false,
                allow_read_only_directory,
            )?
            .replace(&name, &content, expected.as_deref())?;
            Ok(json!({"ok": true}))
        }
        Request::Remove {
            directory,
            name,
            expected,
            allow_read_only_directory,
        } => {
            PrivateDirectory::open_with_read_only_directory_access(
                &directory,
                false,
                allow_read_only_directory,
            )?
            .remove(&name, &expected)?;
            Ok(json!({"ok": true}))
        }
        Request::Lock { .. } => Err(io::Error::other("nested private-file lock rejected")),
    }
}

fn response(output: &mut impl Write, value: &Value) -> io::Result<()> {
    let bytes =
        serde_json::to_vec(value).map_err(|_| io::Error::other("private-file response failed"))?;
    if bytes.len() + 1 > REQUEST_LIMIT {
        return Err(io::Error::other("private-file response failed"));
    }
    output.write_all(&bytes)?;
    output.write_all(b"\n")?;
    output.flush()
}

fn locked(
    reader: &mut impl BufRead,
    output: &mut impl Write,
    directory: PathBuf,
    name: String,
    allow_read_only_directory: bool,
) -> io::Result<()> {
    let directory = PrivateDirectory::open_with_read_only_directory_access(
        &directory,
        false,
        allow_read_only_directory,
    )?;
    let lease = directory.lock(&name)?;
    directory.assert_lock(&name, &lease)?;
    response(output, &json!({"ready": true}))?;
    while let Some(request) = request(reader, true)? {
        if matches!(request, Request::Lock { .. }) {
            return Err(io::Error::other("nested private-file lock rejected"));
        }
        directory.assert_lock(&name, &lease)?;
        let result = operation(request);
        directory.assert_lock(&name, &lease)?;
        match result {
            Ok(value) => response(output, &value)?,
            Err(_) => response(output, &json!({"error": "failed"}))?,
        }
    }
    Ok(())
}

fn execute(reader: &mut impl BufRead, output: &mut impl Write) -> io::Result<()> {
    let request =
        request(reader, false)?.ok_or_else(|| io::Error::other("invalid private-file request"))?;
    match request {
        Request::Lock {
            directory,
            name,
            allow_read_only_directory,
        } => locked(reader, output, directory, name, allow_read_only_directory),
        request => match operation(request) {
            Ok(value) => response(output, &value),
            Err(_) => response(output, &json!({"error": "failed"})),
        },
    }
}

pub(crate) fn run() -> Result<(), Box<dyn Error>> {
    execute(&mut io::stdin().lock(), &mut io::stdout().lock())
        .map_err(|_| "native private-file operation failed".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn private_directory() -> PathBuf {
        static NEXT_ID: AtomicU64 = AtomicU64::new(0);
        let parent = std::fs::canonicalize(std::env::temp_dir()).unwrap();
        let path = parent.join(format!(
            "codexhost-private-command-{}-{}-{}",
            std::process::id(),
            NEXT_ID.fetch_add(1, Ordering::Relaxed),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        drop(PrivateDirectory::open(&path, true).unwrap());
        path
    }
    #[test]
    fn malformed_and_oversized_input_do_not_escape_in_errors() {
        for input in [
            b"{synthetic-secret}\n".to_vec(),
            vec![b'x'; REQUEST_LIMIT + 2],
        ] {
            let error = execute(&mut input.as_slice(), &mut Vec::new()).unwrap_err();
            assert!(!error.to_string().contains("synthetic-secret"));
        }
    }
    #[test]
    fn rejects_unknown_operations_and_fields() {
        for input in [b"{\"operation\":\"refresh-oauth\"}\n".as_slice(),
            b"{\"operation\":\"read\",\"directory\":\".\",\"name\":\"x\",\"token\":\"synthetic-secret\"}\n".as_slice()] {
            assert!(execute(&mut &*input, &mut Vec::new()).is_err());
        }
    }

    #[test]
    fn locked_session_continues_after_a_safe_operation_error() {
        let directory = private_directory();
        let input = [
            json!({"operation": "lock", "directory": directory, "name": "writer.lock"}),
            json!({"operation": "replace", "directory": directory, "name": "value", "content": [1, 2, 3], "expected": null}),
            json!({"operation": "replace", "directory": directory, "name": "value", "content": [4], "expected": null}),
            json!({"operation": "read", "directory": directory, "name": "value"}),
        ]
        .into_iter()
        .map(|value| format!("{value}\n"))
        .collect::<String>();
        let mut output = Vec::new();
        execute(&mut input.as_bytes(), &mut output).unwrap();
        let lines = String::from_utf8(output)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            lines,
            vec![
                json!({"ready": true}),
                json!({"ok": true}),
                json!({"error": "failed"}),
                json!({"content": [1, 2, 3]}),
            ]
        );
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn locked_session_stops_before_a_nested_lock_or_later_operation() {
        let directory = private_directory();
        let input = [
            json!({"operation": "lock", "directory": directory, "name": "writer.lock"}),
            json!({"operation": "lock", "directory": directory, "name": "nested.lock"}),
            json!({"operation": "replace", "directory": directory, "name": "value", "content": [1], "expected": null}),
        ]
        .into_iter()
        .map(|value| format!("{value}\n"))
        .collect::<String>();
        let mut output = Vec::new();
        let error = execute(&mut input.as_bytes(), &mut output).unwrap_err();
        assert_eq!(error.to_string(), "nested private-file lock rejected");
        assert_eq!(String::from_utf8(output).unwrap(), "{\"ready\":true}\n");
        assert!(!directory.join("value").exists());
        std::fs::remove_dir_all(directory).unwrap();
    }
}
