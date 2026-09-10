//! Bounded generic file IPC. Never log request contents, paths, or parser causes.
use std::error::Error;
use std::io::{self, BufRead, Read, Write};
use std::path::PathBuf;

use codexhost_platform::{PRIVATE_FILE_LIMIT, PrivateDirectory};
use serde::Deserialize;
use serde_json::json;

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

fn request(reader: &mut impl BufRead) -> io::Result<Request> {
    let mut line = Vec::new();
    reader
        .take((REQUEST_LIMIT + 1) as u64)
        .read_until(b'\n', &mut line)?;
    if line.len() > REQUEST_LIMIT || line.last() != Some(&b'\n') {
        return Err(io::Error::other("invalid private-file request"));
    }
    serde_json::from_slice(&line).map_err(|_| io::Error::other("invalid private-file request"))
}

fn execute(reader: &mut impl BufRead, output: &mut impl Write) -> io::Result<()> {
    let response = match request(reader)? {
        Request::EnsureDirectory {
            directory,
            allow_read_only_directory,
        } => {
            PrivateDirectory::open_with_read_only_directory_access(
                &directory,
                true,
                allow_read_only_directory,
            )?;
            json!({"ok": true})
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
            json!({"content": bytes})
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
            json!({"ok": true})
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
            json!({"ok": true})
        }
        Request::Lock {
            directory,
            name,
            allow_read_only_directory,
        } => {
            let directory = PrivateDirectory::open_with_read_only_directory_access(
                &directory,
                false,
                allow_read_only_directory,
            )?;
            let _lease = directory.lock(&name)?;
            writeln!(output, "{{\"ready\":true}}")?;
            output.flush()?;
            // Holding stdin open holds the lease; owner death closes it automatically.
            // Bound memory even if a faulty caller sends additional bytes.
            io::copy(reader, &mut io::sink())?;
            return Ok(());
        }
    };
    serde_json::to_writer(&mut *output, &response)
        .map_err(|_| io::Error::other("private-file response failed"))?;
    writeln!(output)?;
    output.flush()
}

pub(crate) fn run() -> Result<(), Box<dyn Error>> {
    execute(&mut io::stdin().lock(), &mut io::stdout().lock())
        .map_err(|_| "native private-file operation failed".into())
}

#[cfg(test)]
mod tests {
    use super::*;
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
}
