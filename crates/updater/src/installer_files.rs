//! Published installer software ownership, not a snapshot of user data or Inno's ledger.
use serde::Deserialize;
use std::{
    collections::BTreeSet,
    error::Error,
    fs,
    path::{Path, PathBuf},
};
pub(crate) const MARKER: &str = "app/codexhost-inno-files-v1.txt";
#[derive(Debug)]
pub(crate) struct Entry {
    pub path: String,
    pub sha256: String,
    pub bytes: u64,
}
pub(crate) struct Manifest {
    pub text: String,
    pub version: String,
    pub target: String,
    pub files: Vec<Entry>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Sidecar {
    schema_version: u8,
    installer_sha256: String,
    files: String,
}
pub(crate) fn bounded(path: &Path) -> Result<Vec<u8>, Box<dyn Error>> {
    let info = fs::symlink_metadata(path)?;
    if !info.is_file() || info.file_type().is_symlink() || info.len() > 2 * 1024 * 1024 {
        return Err("installer manifest is not a bounded regular file".into());
    }
    Ok(fs::read(path)?)
}
pub(crate) fn parse(text: String) -> Result<Manifest, Box<dyn Error>> {
    if text.len() > 1024 * 1024 || text.contains('\r') || !text.ends_with('\n') {
        return Err("invalid installer manifest encoding".into());
    }
    let lines: Vec<_> = text.lines().collect();
    if lines.len() < 8
        || lines.len() > 2051
        || lines[0] != "codexhost-inno-files-v1"
        || !matches!(lines[2], "windows-x64" | "windows-arm64")
    {
        return Err("unsupported original-installer recovery capability".into());
    }
    crate::request::validate_version(lines[1])?;
    let mut names = BTreeSet::new();
    let mut files = Vec::new();
    for line in &lines[3..] {
        let parts: Vec<_> = line.split(' ').collect();
        if parts.len() != 3
            || parts[0].len() != 64
            || !parts[0]
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err("invalid installer file digest".into());
        }
        let name = parts[2];
        if name.len() > 240
            || name == MARKER
            || !(name == "THIRD_PARTY_NOTICES.txt"
                || ["app/", "bin/", "libexec/", "runtime/", "licenses/"]
                    .iter()
                    .any(|prefix| name.starts_with(prefix)))
        {
            return Err("installer file outside software scope".into());
        }
        for part in name.split('/') {
            let base = part.split('.').next().unwrap_or("").to_ascii_lowercase();
            if part.is_empty()
                || matches!(part, "." | "..")
                || part.ends_with('.')
                || !part
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_@.-".contains(&b))
                || matches!(base.as_str(), "con" | "prn" | "aux" | "nul")
                || ((base.starts_with("com") || base.starts_with("lpt"))
                    && base.len() == 4
                    && base.as_bytes()[3].is_ascii_digit())
            {
                return Err("ambiguous installer software path".into());
            }
        }
        if !names.insert(name.to_ascii_lowercase()) {
            return Err("duplicate installer file".into());
        }
        if parts[1].is_empty() || !parts[1].bytes().all(|b| b.is_ascii_digit()) {
            return Err("invalid installer file size".into());
        }
        let bytes = parts[1].parse::<u64>()?;
        if bytes > 9_007_199_254_740_991 {
            return Err("installer file too large".into());
        }
        files.push(Entry {
            path: name.into(),
            sha256: parts[0].into(),
            bytes,
        });
    }
    for file in &files {
        let mut p = Path::new(&file.path).parent();
        while let Some(parent) = p {
            if names.contains(
                &parent
                    .to_string_lossy()
                    .replace('\\', "/")
                    .to_ascii_lowercase(),
            ) {
                return Err("installer file/directory collision".into());
            }
            p = parent.parent();
        }
    }
    for name in [
        "bin/codexhost.exe",
        "runtime/node.exe",
        "libexec/codexhost-updater.exe",
        "app/host-runtime.mjs",
        "app/codexhost-distribution.json",
    ] {
        if !names.contains(name) {
            return Err("incomplete installer file ownership".into());
        }
    }
    Ok(Manifest {
        text: text.clone(),
        version: lines[1].into(),
        target: lines[2].into(),
        files,
    })
}
pub(crate) fn sidecar(
    path: &Path,
    hash: &str,
    exe_hash: &str,
    version: &str,
    target: &str,
) -> Result<Manifest, Box<dyn Error>> {
    crate::install::verify_artifact(path, hash)?;
    let value: Sidecar = serde_json::from_slice(&bounded(path)?)?;
    if value.schema_version != 1 || value.installer_sha256 != exe_hash {
        return Err("installer descriptor does not bind the original EXE".into());
    }
    let result = parse(value.files)?;
    if result.version != version || result.target != target {
        return Err("installer descriptor identity mismatch".into());
    }
    Ok(result)
}
pub(crate) fn inside(root: &Path, file: &Path) -> bool {
    let key = |p: &Path| {
        p.to_string_lossy()
            .replace('/', "\\")
            .trim_start_matches("\\\\?\\")
            .to_lowercase()
    };
    let r = key(root);
    let f = key(file);
    f == r || f.starts_with(&(r.trim_end_matches('\\').to_owned() + "\\"))
}
fn future(path: &Path) -> Result<PathBuf, Box<dyn Error>> {
    let mut p = path;
    let mut rest = Vec::new();
    loop {
        match p.canonicalize() {
            Ok(mut value) => {
                for part in rest.iter().rev() {
                    value.push(part);
                }
                return Ok(value);
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
        rest.push(p.file_name().ok_or("unresolved path")?.to_os_string());
        p = p.parent().ok_or("unresolved path parent")?;
    }
}
pub(crate) fn validate_layout(
    root: &Path,
    old: &Manifest,
    next: &Manifest,
    protected: &[PathBuf],
    installed: bool,
) -> Result<(), Box<dyn Error>> {
    if !crate::windows_installation::same_path(root, &root.canonicalize()?) {
        return Err("installer root is redirected".into());
    }
    let own: BTreeSet<_> = old
        .files
        .iter()
        .map(|f| f.path.to_lowercase())
        .chain(std::iter::once(MARKER.to_owned()))
        .collect();
    let mut protections = protected.to_vec();
    for key in [
        "CODEXHOST_DATA_DIR",
        "CODEXHOST_PLUGIN_DIRECTORY",
        "CODEX_HOME",
    ] {
        if let Some(p) = std::env::var_os(key) {
            protections.push(PathBuf::from(p));
        }
    }
    if let Some(home) = std::env::var_os("USERPROFILE") {
        protections.push(PathBuf::from(home).join(".codexhost"));
    }
    let protections = protections
        .iter()
        .map(|p| {
            if !p.is_absolute() {
                return Err("user data path is not absolute".into());
            }
            future(p)
        })
        .collect::<Result<Vec<_>, Box<dyn Error>>>()?;
    for name in old
        .files
        .iter()
        .chain(&next.files)
        .map(|f| f.path.as_str())
        .chain(std::iter::once(MARKER))
    {
        let file = root.join(name);
        if protections
            .iter()
            .any(|p| inside(p, &file) || inside(&file, p))
        {
            return Err("software overlaps user data/plugin directory".into());
        }
        let mut current = root.to_owned();
        for part in std::iter::once(None).chain(Path::new(name).components().map(Some)) {
            if let Some(part) = part {
                current.push(part);
            }
            match fs::symlink_metadata(&current) {
                Ok(info) => {
                    let linked = info.file_type().is_symlink();
                    #[cfg(target_os = "windows")]
                    let linked = {
                        use std::os::windows::fs::MetadataExt;
                        linked || info.file_attributes() & 0x400 != 0
                    };
                    if linked
                        || (current != file && !info.is_dir())
                        || (current == file && !info.is_file())
                    {
                        return Err("installer path redirected or file/directory transition".into());
                    }
                    if current == file {
                        #[cfg(target_os = "windows")]
                        codexhost_platform::ensure_single_file_link(&current)?;
                        #[cfg(unix)]
                        {
                            use std::os::unix::fs::MetadataExt;
                            if info.nlink() != 1 {
                                return Err("ambiguous software hard link".into());
                            }
                        }
                    }
                    if installed && current == file && !own.contains(&name.to_lowercase()) {
                        return Err("new software collides with user-owned content".into());
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(e.into()),
            }
        }
    }
    if installed {
        for f in &old.files {
            let file = root.join(&f.path);
            if fs::metadata(&file)?.len() != f.bytes {
                return Err(
                    "installed software modified; manual original-directory repair required".into(),
                );
            }
            crate::install::verify_artifact(&file, &f.sha256)?;
        }
    }
    Ok(())
}
