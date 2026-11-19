//! Runs from the new installer's temporary directory before existing files are replaced.

use std::error::Error;
use std::io;
use std::path::{Path, PathBuf};

const EXECUTABLES: &[&str] = &[
    "bin/codexhost.exe",
    "bin/codexhost-start.exe",
    "runtime/node.exe",
    "libexec/codexhost-shim.exe",
    "libexec/codexhost-node-repl.exe",
    "libexec/codexhost-updater.exe",
];

fn installation_executables(root: &Path) -> Result<Vec<PathBuf>, Box<dyn Error>> {
    if !root.is_absolute() {
        return Err("installation directory must be absolute".into());
    }
    let root = match root.canonicalize() {
        Ok(root) => root,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.into()),
    };
    if !root.is_dir() {
        return Err("installation path is not a directory".into());
    }
    let mut executables = Vec::new();
    for relative in EXECUTABLES {
        let candidate = root.join(relative);
        let executable = match candidate.canonicalize() {
            Ok(executable) => executable,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
        };
        if !executable.starts_with(&root) || !executable.is_file() {
            return Err(format!(
                "installer executable is not a file inside the installation: {}",
                candidate.display()
            )
            .into());
        }
        executables.push(executable);
    }
    Ok(executables)
}

pub(crate) fn prepare(root: &Path) -> Result<(), Box<dyn Error>> {
    let executables = installation_executables(root)?;
    #[cfg(target_os = "windows")]
    {
        codexhost_platform::shutdown_processes_for_executables(&executables)?;
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = executables;
        Err("installer process shutdown is supported on Windows only".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT_DIRECTORY: AtomicUsize = AtomicUsize::new(0);

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "codexhost-prepare-install-{}-{}",
                std::process::id(),
                NEXT_DIRECTORY.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn file(&self, relative: &str) -> PathBuf {
            let file = self.0.join(relative);
            fs::create_dir_all(file.parent().unwrap()).unwrap();
            fs::write(&file, "fixture").unwrap();
            file.canonicalize().unwrap()
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn first_install_has_no_process_targets() {
        let fixture = Fixture::new();
        assert!(
            installation_executables(&fixture.0.join("missing"))
                .unwrap()
                .is_empty()
        );
        assert!(installation_executables(&fixture.0).unwrap().is_empty());
    }

    #[test]
    fn dispatches_the_installer_command_without_requiring_an_existing_installation() {
        let fixture = Fixture::new();
        let result = crate::run(&[
            "prepare-install".into(),
            "--install-root".into(),
            fixture.0.join("new").to_string_lossy().into_owned(),
        ]);
        if cfg!(target_os = "windows") {
            result.unwrap();
        } else {
            assert!(
                result
                    .unwrap_err()
                    .to_string()
                    .contains("supported on Windows only")
            );
        }
    }

    #[test]
    fn selects_only_known_executables_in_the_requested_installation() {
        let fixture = Fixture::new();
        let expected = EXECUTABLES
            .iter()
            .map(|file| fixture.file(&format!("target/{file}")))
            .collect::<Vec<_>>();
        fixture.file("other/runtime/node.exe");
        fixture.file("target/runtime/other.exe");
        fixture.file("target/app/plugins/other/node.exe");
        assert_eq!(
            installation_executables(&fixture.0.join("target")).unwrap(),
            expected
        );
    }

    #[test]
    fn rejects_relative_roots_and_non_directory_roots() {
        assert!(installation_executables(Path::new("relative")).is_err());
        let fixture = Fixture::new();
        assert!(installation_executables(&fixture.file("not-a-directory")).is_err());
    }

    #[test]
    fn rejects_an_executable_path_that_is_a_directory() {
        let fixture = Fixture::new();
        fs::create_dir_all(fixture.0.join("runtime/node.exe")).unwrap();
        assert!(installation_executables(&fixture.0).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_executable_links_outside_the_installation() {
        let fixture = Fixture::new();
        let other = fixture.file("other/node.exe");
        let installation = fixture.0.join("target");
        fs::create_dir_all(installation.join("runtime")).unwrap();
        std::os::unix::fs::symlink(other, installation.join("runtime/node.exe")).unwrap();
        assert!(installation_executables(&installation).is_err());
    }
}
