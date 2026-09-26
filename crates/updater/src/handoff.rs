use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

const HANDOFF_FILE: &str = "cleanup-complete-v1";
const TOKEN_BYTES: usize = 32;

/// Authorizes installation only after this Helper's Launcher finished cleanup.
/// A fresh token is required for every Helper launch, including retries.
pub struct UpdateHandoff {
    token: String,
}

impl UpdateHandoff {
    pub fn from_token(token: &str) -> io::Result<Self> {
        if token.len() != TOKEN_BYTES
            || !token
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "update handoff token must contain 32 lowercase hexadecimal characters",
            ));
        }
        Ok(Self {
            token: token.into(),
        })
    }

    pub fn token(&self) -> &str {
        &self.token
    }

    /// Publish only after managed Desktop cleanup has completed successfully.
    pub fn publish(&self, request_path: &Path) -> io::Result<()> {
        let mut options = OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        options.mode(0o600);
        let mut file = options.open(handoff_path(request_path)?)?;
        file.write_all(self.token.as_bytes())?;
        file.sync_all()
    }

    /// Verify only after the Launcher has exited, immediately before installing.
    pub fn verify(&self, request_path: &Path) -> io::Result<()> {
        let path = handoff_path(request_path)?;
        let metadata = fs::symlink_metadata(&path)?;
        if !metadata.is_file()
            || metadata.file_type().is_symlink()
            || metadata.len() != TOKEN_BYTES as u64
        {
            return Err(invalid_handoff());
        }
        let file = File::open(&path)?;
        let metadata = file.metadata()?;
        if !metadata.is_file() || metadata.len() != TOKEN_BYTES as u64 {
            return Err(invalid_handoff());
        }
        // Bound the read even if the file changes after its metadata was read.
        let mut bytes = Vec::with_capacity(TOKEN_BYTES + 1);
        file.take((TOKEN_BYTES + 1) as u64)
            .read_to_end(&mut bytes)?;
        if bytes != self.token.as_bytes() {
            return Err(invalid_handoff());
        }
        Ok(())
    }
}

fn handoff_path(request_path: &Path) -> io::Result<PathBuf> {
    if !request_path.is_absolute() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "update handoff request path must be absolute",
        ));
    }
    request_path
        .parent()
        .map(|parent| parent.join(HANDOFF_FILE))
        .ok_or_else(invalid_handoff)
}

fn invalid_handoff() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        "Launcher did not authorize this update after Desktop cleanup",
    )
}

#[cfg(test)]
mod tests {
    use super::{HANDOFF_FILE, UpdateHandoff};
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    const TOKEN: &str = "0123456789abcdef0123456789abcdef";

    fn fixture() -> (PathBuf, PathBuf, UpdateHandoff) {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root =
            std::env::temp_dir().join(format!("codexhost-handoff-{}-{unique}", std::process::id()));
        fs::create_dir(&root).unwrap();
        let request = root.join("request-v1.json");
        (root, request, UpdateHandoff::from_token(TOKEN).unwrap())
    }

    #[test]
    fn accepts_only_a_32_character_lowercase_hexadecimal_token() {
        assert_eq!(UpdateHandoff::from_token(TOKEN).unwrap().token(), TOKEN);
        for invalid in [
            "",
            "0123456789abcdef0123456789abcde",
            "0123456789abcdef0123456789abcdef0",
            "0123456789ABCDEF0123456789ABCDEF",
            "../../../../../../../../../../..",
            "é123456789abcdef0123456789abcdef",
        ] {
            assert!(UpdateHandoff::from_token(invalid).is_err());
        }
    }

    #[test]
    fn accepts_the_published_token_and_rejects_a_second_publication() {
        let (root, request, handoff) = fixture();
        handoff.publish(&request).unwrap();
        handoff.verify(&request).unwrap();
        assert_eq!(fs::read(root.join(HANDOFF_FILE)).unwrap(), TOKEN.as_bytes());
        assert_eq!(
            handoff.publish(&request).unwrap_err().kind(),
            std::io::ErrorKind::AlreadyExists
        );
        handoff.verify(&request).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_missing_mismatched_truncated_and_oversized_authorization() {
        let (root, request, handoff) = fixture();
        assert!(handoff.verify(&request).is_err());
        for invalid in [
            Vec::new(),
            TOKEN.as_bytes()[..31].to_vec(),
            b"fedcba9876543210fedcba9876543210".to_vec(),
            format!("{TOKEN}\n").into_bytes(),
            vec![b'0'; 8192],
        ] {
            fs::write(root.join(HANDOFF_FILE), invalid).unwrap();
            assert!(handoff.verify(&request).is_err());
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_previous_helpers_token_does_not_authorize_a_retry() {
        let (root, request, previous) = fixture();
        previous.publish(&request).unwrap();
        let retry = UpdateHandoff::from_token("fedcba9876543210fedcba9876543210").unwrap();
        assert!(retry.verify(&request).is_err());
        assert!(retry.publish(&request).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_a_directory_and_relative_request_paths() {
        let (root, request, handoff) = fixture();
        fs::create_dir(root.join(HANDOFF_FILE)).unwrap();
        assert!(handoff.verify(&request).is_err());
        assert!(handoff.publish(Path::new("request-v1.json")).is_err());
        assert!(handoff.verify(Path::new("request-v1.json")).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn rejects_a_symlink_even_when_its_target_has_the_matching_token() {
        let (root, request, handoff) = fixture();
        let target = root.join("target");
        fs::write(&target, TOKEN).unwrap();
        std::os::unix::fs::symlink(target, root.join(HANDOFF_FILE)).unwrap();
        assert!(handoff.verify(&request).is_err());
        assert!(handoff.publish(&request).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn publishes_without_group_or_other_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let (root, request, handoff) = fixture();
        handoff.publish(&request).unwrap();
        assert_eq!(
            fs::metadata(root.join(HANDOFF_FILE))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        fs::remove_dir_all(root).unwrap();
    }
}
