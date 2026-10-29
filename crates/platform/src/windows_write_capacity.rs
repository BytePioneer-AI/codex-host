use crate::PlatformError;
use std::fs::{self, OpenOptions};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
use std::path::Path;
use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
use windows::core::PCWSTR;

/// Installer software files must not alias user data through hard links.
pub fn ensure_single_file_link(path: &Path) -> Result<(), PlatformError> {
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::{
        Foundation::HANDLE,
        Storage::FileSystem::{BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle},
    };
    let file = OpenOptions::new()
        .access_mode(0x80)
        .share_mode(7)
        .custom_flags(0x00200000)
        .open(path)?;
    let mut information = BY_HANDLE_FILE_INFORMATION::default();
    unsafe { GetFileInformationByHandle(HANDLE(file.as_raw_handle()), &mut information) }.map_err(
        |e| {
            PlatformError::Invalid(format!(
                "cannot establish software file link ownership: {e}"
            ))
        },
    )?;
    if information.nNumberOfLinks != 1 {
        return Err(PlatformError::Invalid(
            "installer software has ambiguous hard-link ownership".into(),
        ));
    }
    Ok(())
}

/// Asks the kernel for directory mutation rights and available space without
/// creating a probe file, changing an ACL, or writing installation metadata.
pub fn check_directory_mutation_capacity(
    directory: &Path,
    required_bytes: u64,
) -> Result<(), PlatformError> {
    if !directory.is_absolute() {
        return Err(PlatformError::Invalid(
            "capacity path must be absolute".into(),
        ));
    }
    let metadata = fs::symlink_metadata(directory)?;
    if !metadata.is_dir() || metadata.file_attributes() & 0x400 != 0 {
        return Err(PlatformError::Invalid(
            "capacity directory is redirected".into(),
        ));
    }
    // FILE_ADD_FILE | FILE_ADD_SUBDIRECTORY | FILE_DELETE_CHILD, OPEN_EXISTING.
    let _handle = OpenOptions::new()
        .access_mode(0x46)
        .share_mode(7)
        .custom_flags(0x02000000 | 0x00200000)
        .open(directory)?;
    let wide = directory
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let mut available = 0;
    unsafe { GetDiskFreeSpaceExW(PCWSTR(wide.as_ptr()), Some(&mut available), None, None) }
        .map_err(|error| {
            PlatformError::Invalid(format!(
                "cannot inspect available installation space: {error}"
            ))
        })?;
    if available < required_bytes {
        return Err(PlatformError::Invalid(format!(
            "insufficient installation space: need {required_bytes} bytes, available {available}"
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn checks_real_owned_directory_without_writing_a_probe_and_rejects_impossible_space() {
        let directory =
            std::env::temp_dir().join(format!("codexhost-capacity-{}", std::process::id()));
        fs::create_dir_all(&directory).unwrap();
        check_directory_mutation_capacity(&directory, 1).unwrap();
        assert!(check_directory_mutation_capacity(&directory, u64::MAX).is_err());
        assert_eq!(fs::read_dir(&directory).unwrap().count(), 0);
        fs::remove_dir_all(directory).unwrap();
    }
}
