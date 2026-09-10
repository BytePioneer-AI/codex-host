use std::fs::File;
use std::io;
use std::mem::size_of;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::path::{Component, Path, PathBuf, Prefix};

use windows::Win32::Foundation::{HANDLE, HLOCAL, LocalFree};
use windows::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, GetSecurityInfo,
    SE_FILE_OBJECT,
};
use windows::Win32::Security::{
    ACCESS_ALLOWED_ACE, ACL, DACL_SECURITY_INFORMATION, GetAce, GetTokenInformation,
    OWNER_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID, SECURITY_ATTRIBUTES, TOKEN_QUERY,
    TOKEN_USER, TokenUser,
};
use windows::Win32::Storage::FileSystem::{
    BY_HANDLE_FILE_INFORMATION, CREATE_NEW, CreateDirectoryW, CreateFileW,
    FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS,
    FILE_FLAG_OPEN_REPARSE_POINT, FILE_GENERIC_READ, FILE_GENERIC_WRITE, FILE_SHARE_READ,
    FILE_SHARE_WRITE, GetFileInformationByHandle, OPEN_ALWAYS, OPEN_EXISTING, READ_CONTROL,
};
use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
use windows::core::{PCWSTR, PWSTR};

use super::denied;

#[link(name = "advapi32")]
unsafe extern "system" {
    fn LookupAccountNameW(
        system_name: *const u16,
        account_name: *const u16,
        sid: *mut core::ffi::c_void,
        sid_size: *mut u32,
        domain_name: *mut u16,
        domain_size: *mut u32,
        sid_use: *mut u32,
    ) -> i32;
}

fn win(error: windows::core::Error) -> io::Error {
    match error.code().0 as u32 & 0xffff {
        2 | 3 => io::Error::new(io::ErrorKind::NotFound, "private file missing"),
        80 | 183 => io::Error::new(io::ErrorKind::AlreadyExists, "private file exists"),
        _ => denied(),
    }
}

struct LocalMemory(*mut core::ffi::c_void);
impl Drop for LocalMemory {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                let _ = LocalFree(Some(HLOCAL(self.0)));
            }
        }
    }
}
fn sid_text(sid: PSID) -> io::Result<String> {
    if sid.0.is_null() {
        return Err(denied());
    }
    let mut text = PWSTR::null();
    unsafe {
        ConvertSidToStringSidW(sid, &mut text).map_err(win)?;
    }
    let _memory = LocalMemory(text.0.cast());
    unsafe { text.to_string().map_err(|_| denied()) }
}
fn current_sid() -> io::Result<String> {
    let mut token = HANDLE::default();
    unsafe {
        OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).map_err(win)?;
    }
    let _token = unsafe { OwnedHandle::from_raw_handle(token.0) };
    let mut size = 0;
    unsafe {
        let _ = GetTokenInformation(token, TokenUser, None, 0, &mut size);
    }
    if size == 0 || size > 16_384 {
        return Err(denied());
    }
    // u64 storage satisfies TOKEN_USER alignment; the SID lives in this buffer.
    let mut storage = vec![0u64; (size as usize).div_ceil(8)];
    unsafe {
        GetTokenInformation(
            token,
            TokenUser,
            Some(storage.as_mut_ptr().cast()),
            size,
            &mut size,
        )
        .map_err(win)?;
        sid_text((*(storage.as_ptr().cast::<TOKEN_USER>())).User.Sid)
    }
}
fn wide(path: &Path) -> Vec<u16> {
    path.as_os_str().encode_wide().chain(Some(0)).collect()
}
fn handle(file: &File) -> HANDLE {
    HANDLE(file.as_raw_handle())
}

pub(super) struct Directory {
    path: PathBuf,
    sid: String,
    security: LocalMemory,
    allow_read_only_access: bool,
    // Deny delete sharing on all ancestors, preventing pathname redirection while open.
    _directories: Vec<File>,
}

impl Directory {
    pub(super) fn open(
        path: &Path,
        create: bool,
        allow_read_only_directory_access: bool,
    ) -> io::Result<Self> {
        if path.as_os_str().encode_wide().any(|unit| unit == 0) {
            return Err(denied());
        }
        let sid = current_sid()?;
        let sddl = format!("O:{sid}D:P(A;OICI;FA;;;{sid})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)");
        let sddl = sddl.encode_utf16().chain(Some(0)).collect::<Vec<_>>();
        let mut descriptor = PSECURITY_DESCRIPTOR::default();
        unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                PCWSTR(sddl.as_ptr()),
                1,
                &mut descriptor,
                None,
            )
            .map_err(win)?;
        }
        let security = LocalMemory(descriptor.0);
        let attributes = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: security.0,
            bInheritHandle: false.into(),
        };
        let components = path.components().collect::<Vec<_>>();
        if !matches!(components.first(), Some(Component::Prefix(p)) if matches!(p.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_)))
        {
            return Err(denied());
        }
        let mut current = PathBuf::new();
        let mut directories = Vec::new();
        for (index, component) in components.iter().enumerate() {
            current.push(component.as_os_str());
            if matches!(component, Component::Prefix(_)) {
                continue;
            }
            let encoded = wide(&current);
            let open = || unsafe {
                CreateFileW(
                    PCWSTR(encoded.as_ptr()),
                    READ_CONTROL.0,
                    FILE_SHARE_READ | FILE_SHARE_WRITE,
                    None,
                    OPEN_EXISTING,
                    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                    None,
                )
                .map_err(win)
            };
            let h = match open() {
                Err(error)
                    if error.kind() == io::ErrorKind::NotFound
                        && create
                        && index == components.len() - 1 =>
                {
                    match unsafe {
                        CreateDirectoryW(PCWSTR(encoded.as_ptr()), Some(&attributes)).map_err(win)
                    } {
                        Ok(()) => {}
                        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
                        Err(error) => return Err(error),
                    }
                    open()?
                }
                other => other?,
            };
            let file = unsafe { File::from_raw_handle(h.0) };
            verify_kind(&file, true)?;
            directories.push(file);
        }
        let directory = directories.last().ok_or_else(denied)?;
        verify_security(directory, &sid, allow_read_only_directory_access)?;
        Ok(Self {
            path: path.to_path_buf(),
            sid,
            security,
            allow_read_only_access: allow_read_only_directory_access,
            _directories: directories,
        })
    }

    fn file(
        &self,
        name: &str,
        disposition: windows::Win32::Storage::FileSystem::FILE_CREATION_DISPOSITION,
        write: bool,
    ) -> io::Result<File> {
        let encoded = wide(&self.path.join(name));
        let attributes = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: self.security.0,
            bInheritHandle: false.into(),
        };
        let h = unsafe {
            CreateFileW(
                PCWSTR(encoded.as_ptr()),
                FILE_GENERIC_READ.0 | if write { FILE_GENERIC_WRITE.0 } else { 0 },
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                Some(&attributes),
                disposition,
                FILE_FLAG_OPEN_REPARSE_POINT,
                None,
            )
            .map_err(win)?
        };
        let file = unsafe { File::from_raw_handle(h.0) };
        verify_kind(&file, false)?;
        verify_security(&file, &self.sid, self.allow_read_only_access)?;
        Ok(file)
    }
    pub(super) fn read(&self, name: &str) -> io::Result<Option<File>> {
        match self.file(name, OPEN_EXISTING, false) {
            Ok(file) => Ok(Some(file)),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error),
        }
    }
    pub(super) fn create(&self, name: &str) -> io::Result<File> {
        self.file(name, CREATE_NEW, true)
    }
    pub(super) fn lock_file(&self, name: &str) -> io::Result<File> {
        self.file(name, OPEN_ALWAYS, true)
    }
    pub(super) fn replace(&self, source: &str, target: &str) -> io::Result<()> {
        crate::atomic_replace_file(&self.path.join(source), &self.path.join(target))
            .map_err(|_| denied())
    }
    pub(super) fn remove(&self, name: &str) -> io::Result<()> {
        std::fs::remove_file(self.path.join(name))
    }
    pub(super) fn sync(&self) -> io::Result<()> {
        // atomic_replace_file uses MOVEFILE_WRITE_THROUGH on Windows.
        Ok(())
    }
}
fn verify_kind(file: &File, directory: bool) -> io::Result<()> {
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    unsafe {
        GetFileInformationByHandle(handle(file), &mut info).map_err(win)?;
    }
    if info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0
        || (info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY.0 != 0) != directory
        || (!directory && info.nNumberOfLinks != 1)
    {
        return Err(denied());
    }
    Ok(())
}
fn trusted(sid: &str, current: &str) -> bool {
    // SYSTEM and local Administrators are the OS privileged boundary, not unrelated users.
    sid == current || sid == "S-1-5-18" || sid == "S-1-5-32-544"
}

fn codex_sandbox_sid() -> io::Result<Option<String>> {
    let account = "CodexSandboxUsers"
        .encode_utf16()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let mut sid_size = 0_u32;
    let mut domain_size = 0_u32;
    let mut sid_use = 0_u32;
    unsafe {
        LookupAccountNameW(
            std::ptr::null(),
            account.as_ptr(),
            std::ptr::null_mut(),
            &mut sid_size,
            std::ptr::null_mut(),
            &mut domain_size,
            &mut sid_use,
        );
    }
    let error = io::Error::last_os_error();
    if error.raw_os_error() == Some(1332) {
        return Ok(None);
    }
    if error.raw_os_error() != Some(122) || sid_size == 0 {
        return Err(denied());
    }
    let mut sid = vec![0_usize; (sid_size as usize).div_ceil(size_of::<usize>())];
    let mut domain = vec![0_u16; domain_size as usize];
    let succeeded = unsafe {
        LookupAccountNameW(
            std::ptr::null(),
            account.as_ptr(),
            sid.as_mut_ptr().cast(),
            &mut sid_size,
            domain.as_mut_ptr(),
            &mut domain_size,
            &mut sid_use,
        )
    };
    if succeeded == 0 {
        return Err(denied());
    }
    sid_text(PSID(sid.as_mut_ptr().cast())).map(Some)
}
fn verify_security(
    file: &File,
    current: &str,
    allow_read_only_directory_access: bool,
) -> io::Result<()> {
    let mut owner = PSID::default();
    let mut dacl: *mut ACL = std::ptr::null_mut();
    let mut descriptor = PSECURITY_DESCRIPTOR::default();
    unsafe {
        GetSecurityInfo(
            handle(file),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            Some(&mut owner),
            None,
            Some(&mut dacl),
            None,
            Some(&mut descriptor),
        )
        .ok()
        .map_err(win)?;
    }
    let _memory = LocalMemory(descriptor.0);
    if dacl.is_null() || !trusted(&sid_text(owner)?, current) {
        return Err(denied());
    }
    let sandbox_sid = allow_read_only_directory_access
        .then(codex_sandbox_sid)
        .transpose()?
        .flatten();
    for index in 0..unsafe { (*dacl).AceCount } {
        let mut ace = std::ptr::null_mut();
        unsafe {
            GetAce(dacl, u32::from(index), &mut ace).map_err(win)?;
        }
        if ace.is_null() {
            return Err(denied());
        }
        let allowed = unsafe { &*ace.cast::<ACCESS_ALLOWED_ACE>() };
        // Only basic allow ACEs are supported, no callback/object/conditional guesswork.
        if allowed.Header.AceType != 0 {
            return Err(denied());
        }
        let sid = PSID(std::ptr::addr_of!(allowed.SidStart).cast_mut().cast());
        let principal = sid_text(sid)?;
        if !trusted(&principal, current) {
            const WRITE_OR_DELETE: u32 = 0x0000_0002
                | 0x0000_0004
                | 0x0000_0010
                | 0x0000_0040
                | 0x0000_0100
                | 0x0001_0000
                | 0x0004_0000
                | 0x0008_0000;
            if sandbox_sid.as_deref() != Some(&principal) || allowed.Mask & WRITE_OR_DELETE != 0 {
                return Err(denied());
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn create_directory_with_sddl(root: &Path, name: &str, sddl: &str) -> PathBuf {
        let encoded = sddl.encode_utf16().chain(Some(0)).collect::<Vec<_>>();
        let mut descriptor = PSECURITY_DESCRIPTOR::default();
        unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                PCWSTR(encoded.as_ptr()),
                1,
                &mut descriptor,
                None,
            )
            .unwrap();
        }
        let memory = LocalMemory(descriptor.0);
        let attributes = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: memory.0,
            bInheritHandle: false.into(),
        };
        let target = root.join(name);
        let encoded = wide(&target);
        unsafe {
            CreateDirectoryW(PCWSTR(encoded.as_ptr()), Some(&attributes)).unwrap();
        }
        target
    }

    #[test]
    fn refuses_a_broad_dacl_before_writing() {
        let root = crate::temporary_directory("private-windows-acl");
        let sid = current_sid().unwrap();
        let sddl = format!("O:{sid}D:P(A;OICI;FA;;;{sid})(A;OICI;GR;;;WD)");
        let target = create_directory_with_sddl(&root, "broad", &sddl);
        assert!(Directory::open(&target, false, false).is_err());
        assert!(Directory::open(&target, false, true).is_err());
        assert_eq!(std::fs::read_dir(&target).unwrap().count(), 0);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn permits_a_codex_sandbox_style_read_only_ace_only_when_requested() {
        let root = crate::temporary_directory("private-windows-codex-acl");
        let sid = current_sid().unwrap();
        let Some(sandbox_sid) = codex_sandbox_sid().unwrap() else {
            return;
        };
        let sddl = format!("O:{sid}D:P(A;OICI;FA;;;{sid})(A;OICI;GR;;;{sandbox_sid})");
        let target = create_directory_with_sddl(&root, "native-home", &sddl);
        std::fs::write(target.join("auth.json"), b"fixture").unwrap();

        assert!(Directory::open(&target, false, false).is_err());
        let relaxed = Directory::open(&target, false, true).unwrap();
        assert!(relaxed.read("auth.json").unwrap().is_some());
        std::fs::remove_dir_all(root).unwrap();
    }
}
