//! Keep a complete, same-volume copy until Windows finishes activation.
use std::error::Error;
use std::fs;
use std::io;
use std::os::windows::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::install::{installed_version, verify_installation};
use crate::request::{UpdateRequest, WindowsInstallation};

pub(crate) struct WindowsUpdate {
    root: PathBuf,
    backup: PathBuf,
    failed: PathBuf,
    pub(crate) previous_version: String,
}

impl WindowsUpdate {
    pub(crate) fn inspect(
        request: &UpdateRequest,
        windows: &WindowsInstallation,
    ) -> Result<Self, Box<dyn Error>> {
        let root = windows.install_root.canonicalize()?;
        let parent = root
            .parent()
            .ok_or("Windows installation has no parent directory")?;
        let updater = std::env::current_exe()?;
        for path in [
            Some(windows.installer_path.as_path()),
            Some(request.status_path.as_path()),
            Some(request.runtime_descriptor_path.as_path()),
            request.data_directory.as_deref(),
            Some(updater.as_path()),
        ]
        .into_iter()
        .flatten()
        {
            if crate::request::path_is_within(path, &root) {
                return Err(format!(
                    "Update state must be outside Windows installation: {}",
                    path.display()
                )
                .into());
            }
        }
        let previous_version = installed_version(&root, "installer")?;
        verify_installation(&root, &previous_version, "installer")?;
        for name in [
            "bin/codexhost.exe",
            "runtime/node.exe",
            "app/host-runtime.mjs",
            "app/web-server.mjs",
        ] {
            if !root.join(name).is_file() {
                return Err(format!(
                    "Previous installation is missing {}",
                    root.join(name).display()
                )
                .into());
            }
        }
        let id = format!(
            "{}-{}",
            std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos()
        );
        let backup = parent.join(format!(".codexhost-backup-{id}"));
        let failed = parent.join(format!(".codexhost-failed-{id}"));
        Ok(Self {
            root,
            backup,
            failed,
            previous_version,
        })
    }

    pub(crate) fn backup(&self) -> Result<(), Box<dyn Error>> {
        crate::prepare_install::prepare(&self.root)?;
        fs::create_dir(&self.backup)?;
        let result = copy_contents(&self.root, &self.backup)
            .map_err(|error| -> Box<dyn Error> { Box::new(error) })
            .and_then(|()| verify_installation(&self.backup, &self.previous_version, "installer"));
        if result.is_err() {
            self.cleanup(&self.backup);
        }
        result
    }

    pub(crate) fn rollback(&self) -> Result<(), Box<dyn Error>> {
        verify_installation(&self.backup, &self.previous_version, "installer")?;
        match fs::symlink_metadata(&self.root) {
            Ok(_) => rename_with_retry(&self.root, &self.failed)?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        rename_with_retry(&self.backup, &self.root)?;
        if let Err(error) = verify_installation(&self.root, &self.previous_version, "installer") {
            rename_with_retry(&self.root, &self.backup).map_err(|rename| {
                format!("Restored installation failed verification: {error}; could not preserve it separately: {rename}")
            })?;
            return Err(error);
        }
        self.cleanup(&self.failed);
        Ok(())
    }

    pub(crate) fn backup_path(&self) -> &Path {
        &self.backup
    }

    pub(crate) fn discard_backup(&self) {
        self.cleanup(&self.backup);
    }

    fn cleanup(&self, path: &Path) {
        if let Err(error) = fs::remove_dir_all(path)
            && error.kind() != io::ErrorKind::NotFound
        {
            eprintln!(
                "codexhost updater: could not clean up {}: {error}",
                path.display()
            );
        }
    }
}

fn copy_contents(source: &Path, destination: &Path) -> io::Result<()> {
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let from = entry.path();
        let to = destination.join(entry.file_name());
        let metadata = fs::symlink_metadata(&from)?;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(io::Error::other(format!(
                "Cannot back up a reparse point: {}",
                from.display()
            )));
        }
        if metadata.is_dir() {
            fs::create_dir(&to)?;
            copy_contents(&from, &to)?;
        } else {
            fs::copy(&from, &to)
                .map_err(|error| io::Error::other(format!("Copy {}: {error}", from.display())))?;
        }
    }
    Ok(())
}

fn rename_with_retry(source: &Path, destination: &Path) -> io::Result<()> {
    let mut delays = [25, 50, 100, 200, 400, 800, 1000].into_iter();
    loop {
        match fs::rename(source, destination) {
            Ok(()) => return Ok(()),
            Err(error) => {
                if matches!(error.raw_os_error(), Some(5 | 32 | 33))
                    && let Some(delay) = delays.next()
                {
                    thread::sleep(Duration::from_millis(delay));
                    continue;
                }
                return Err(io::Error::other(format!(
                    "Rename {} to {}: {error}",
                    source.display(),
                    destination.display()
                )));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restores_the_complete_old_tree_after_partial_installation() {
        let parent =
            std::env::temp_dir().join(format!("codexhost-backup-test-{}", std::process::id()));
        fs::create_dir(&parent).unwrap();
        let root = parent.join("install");
        let backup = parent.join("backup");
        let failed = parent.join("failed");
        let transaction = WindowsUpdate {
            root: root.clone(),
            backup: backup.clone(),
            failed: failed.clone(),
            previous_version: "0.28.0".into(),
        };
        fs::create_dir_all(root.join("app")).unwrap();
        fs::write(root.join("app/codexhost-distribution.json"), r#"{"schemaVersion":1,"version":"0.28.0","distribution":"installer","target":"windows-x64"}"#).unwrap();
        fs::write(root.join("old-only"), "old").unwrap();
        transaction.backup().unwrap();
        fs::write(root.join("app/codexhost-distribution.json"), r#"{"schemaVersion":1,"version":"0.29.0","distribution":"installer","target":"windows-x64"}"#).unwrap();
        fs::remove_file(root.join("old-only")).unwrap();
        fs::write(root.join("new-only"), "new").unwrap();
        let backup_metadata = backup.join("app/codexhost-distribution.json");
        let previous_metadata = fs::read(&backup_metadata).unwrap();
        fs::write(&backup_metadata, b"{}").unwrap();
        assert!(transaction.rollback().is_err());
        assert!(root.join("new-only").exists());
        assert!(backup.join("old-only").exists());
        fs::write(backup_metadata, previous_metadata).unwrap();
        transaction.rollback().unwrap();
        assert_eq!(fs::read_to_string(root.join("old-only")).unwrap(), "old");
        assert!(!root.join("new-only").exists());
        assert!(!backup.exists());
        assert!(!failed.exists());
        fs::remove_dir_all(parent).unwrap();
    }
}
