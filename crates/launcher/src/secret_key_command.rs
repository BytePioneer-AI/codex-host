//! Bounded generic OS-secret IPC. Errors are deliberately content-free.

use std::error::Error;
use std::io::{self, BufRead, Read, Write};

use serde::Deserialize;
use serde_json::json;

const REQUEST_LIMIT: usize = 256;

#[derive(Deserialize)]
#[serde(tag = "operation", rename_all = "kebab-case", deny_unknown_fields)]
enum Request {
    Read { key_id: String },
    Create { key_id: String },
}

fn request(reader: &mut impl BufRead) -> io::Result<Request> {
    let mut line = Vec::new();
    reader
        .take((REQUEST_LIMIT + 1) as u64)
        .read_until(b'\n', &mut line)?;
    if line.len() > REQUEST_LIMIT || line.last() != Some(&b'\n') {
        return Err(io::Error::other("invalid native secret-key request"));
    }
    serde_json::from_slice(&line).map_err(|_| io::Error::other("invalid native secret-key request"))
}

fn execute(reader: &mut impl BufRead, output: &mut impl Write) -> Result<(), Box<dyn Error>> {
    let response = match request(reader)? {
        Request::Read { key_id } => {
            json!({"content": codexhost_platform::read_secret_key(&key_id)?})
        }
        Request::Create { key_id } => {
            json!({"content": codexhost_platform::create_secret_key(&key_id)?})
        }
    };
    serde_json::to_writer(&mut *output, &response)
        .map_err(|_| io::Error::other("native secret-key response failed"))?;
    writeln!(output)?;
    output.flush()?;
    Ok(())
}

pub(crate) fn run() -> Result<(), Box<dyn Error>> {
    execute(&mut io::stdin().lock(), &mut io::stdout().lock())
        .map_err(|_| "native secret-key operation failed".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unknown_operations_fields_and_oversized_input_without_os_access() {
        for input in [
            b"{\"operation\":\"delete\",\"key_id\":\"synthetic\"}\n".to_vec(),
            b"{\"operation\":\"read\",\"key_id\":\"synthetic\",\"secret\":\"never\"}\n".to_vec(),
            vec![b'x'; REQUEST_LIMIT + 2],
        ] {
            assert!(execute(&mut input.as_slice(), &mut Vec::new()).is_err());
        }
    }
}
