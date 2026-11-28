use std::fs::{File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::Command;

pub(crate) fn capture(
    command: &mut Command,
    status_path: &Path,
    name: &str,
    append: bool,
) -> io::Result<PathBuf> {
    let path = status_path.with_file_name(name);
    let file = OpenOptions::new()
        .create(true)
        .write(true)
        .append(append)
        .truncate(!append)
        .open(&path)?;
    command.stdout(file.try_clone()?).stderr(file);
    Ok(path)
}

pub(crate) fn log_details(path: &Path, npm: bool) -> String {
    let lines = (|| -> io::Result<String> {
        let mut file = File::open(path)?;
        let length = file.metadata()?.len().min(16 * 1024);
        file.seek(SeekFrom::End(-(length as i64)))?;
        let mut bytes = Vec::new();
        file.take(length).read_to_end(&mut bytes)?;
        let text = String::from_utf8_lossy(&bytes);
        let lines = text
            .lines()
            .rev()
            .filter_map(|line| {
                let line = line.trim();
                if npm {
                    // Only copy npm's machine-readable fields. npm paths, URLs and
                    // registry responses belong in the local operation log.
                    let (prefix, value) = [
                        "npm error code ",
                        "npm ERR! code ",
                        "npm error syscall ",
                        "npm error errno ",
                    ]
                    .iter()
                    .find_map(|prefix| line.strip_prefix(prefix).map(|value| (*prefix, value)))?;
                    (!value.is_empty()
                        && value.len() < 40
                        && value
                            .chars()
                            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'))
                    .then(|| format!("{prefix}{value}"))
                } else {
                    let lower = line.to_ascii_lowercase();
                    (!line.is_empty()
                        && ![
                            "://",
                            "token",
                            "authorization",
                            "secret",
                            "password",
                            "credential",
                            "bearer",
                            "cookie",
                            "api_key",
                            "apikey",
                        ]
                        .iter()
                        .any(|key| lower.contains(key)))
                    .then(|| line.chars().take(360).collect())
                }
            })
            .take(if npm { 4 } else { 2 })
            .collect::<Vec<String>>();
        Ok(lines.into_iter().rev().collect::<Vec<_>>().join(" | "))
    })()
    .unwrap_or_default();
    if lines.is_empty() {
        format!("; log: {}", path.display())
    } else {
        format!("; {lines}; log: {}", path.display())
    }
}
