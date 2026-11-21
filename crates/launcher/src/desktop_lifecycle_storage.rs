//! Private per-user storage for Desktop lifecycle operations (not Web discovery).
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::os::unix::fs::MetadataExt;
use std::path::Path;
use std::thread;
use std::time::{Duration, Instant};

use fs2::FileExt;
use rustix::fs::{AtFlags, Mode, OFlags, mkdirat, open, openat, renameat, unlinkat};

const PRIVATE_DIR: &str = "desktop-lifecycle-v1";
const DIRECTORY_FLAGS: OFlags = OFlags::RDONLY
    .union(OFlags::DIRECTORY)
    .union(OFlags::NOFOLLOW)
    .union(OFlags::CLOEXEC);
const FILE_FLAGS: OFlags = OFlags::NOFOLLOW
    .union(OFlags::CLOEXEC)
    .union(OFlags::NONBLOCK);

fn denied() -> io::Error {
    io::Error::new(
        io::ErrorKind::PermissionDenied,
        "Desktop lifecycle storage is not private and owned",
    )
}

pub(super) struct Store(File);

impl Store {
    pub(super) fn open(runtime: &Path) -> io::Result<Self> {
        fs::create_dir_all(runtime)?;
        let parent = File::from(open(runtime, DIRECTORY_FLAGS, Mode::empty())?);
        let metadata = parent.metadata()?;
        if metadata.uid() != rustix::process::geteuid().as_raw() || metadata.mode() & 0o022 != 0 {
            return Err(denied());
        }
        match mkdirat(&parent, PRIVATE_DIR, Mode::from_raw_mode(0o700)) {
            Ok(()) | Err(rustix::io::Errno::EXIST) => {}
            Err(error) => return Err(error.into()),
        }
        let directory = File::from(openat(parent, PRIVATE_DIR, DIRECTORY_FLAGS, Mode::empty())?);
        let metadata = directory.metadata()?;
        if metadata.uid() != rustix::process::geteuid().as_raw()
            || metadata.mode() & 0o7777 != 0o700
        {
            return Err(denied());
        }
        Ok(Self(directory))
    }

    fn file(&self, name: &str, flags: OFlags) -> io::Result<File> {
        let file = File::from(openat(
            &self.0,
            name,
            flags | FILE_FLAGS,
            Mode::from_raw_mode(0o600),
        )?);
        let metadata = file.metadata()?;
        if !metadata.is_file()
            || metadata.uid() != rustix::process::geteuid().as_raw()
            || metadata.mode() & 0o7777 != 0o600
            || metadata.nlink() != 1
        {
            return Err(denied());
        }
        Ok(file)
    }

    pub(super) fn lock(&self) -> io::Result<File> {
        let file = self.file("operation.lock", OFlags::RDWR | OFlags::CREATE)?;
        let started = Instant::now();
        loop {
            match file.try_lock_exclusive() {
                Ok(()) => return Ok(file),
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    if started.elapsed() >= Duration::from_secs(40) {
                        return Err(io::Error::new(
                            io::ErrorKind::WouldBlock,
                            "Desktop lifecycle operation is busy",
                        ));
                    }
                    thread::sleep(Duration::from_millis(25));
                }
                Err(error) => return Err(error),
            }
        }
    }

    pub(super) fn read(&self, name: &str, limit: usize) -> io::Result<Option<Vec<u8>>> {
        let file = match self.file(name, OFlags::RDONLY) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error),
        };
        let mut bytes = Vec::new();
        file.take((limit + 1) as u64).read_to_end(&mut bytes)?;
        if bytes.len() > limit {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "oversized Desktop lifecycle file",
            ));
        }
        Ok(Some(bytes))
    }

    pub(super) fn publish(&self, name: &str, bytes: &[u8]) -> io::Result<()> {
        let temporary = format!(".{}", crate::runtime_instance::random_nonce()?);
        let mut file = self.file(&temporary, OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL)?;
        let result = (|| {
            file.write_all(bytes)?;
            file.sync_all()?;
            renameat(&self.0, &temporary, &self.0, name)?;
            Ok(())
        })();
        if result.is_err() {
            let _ = self.remove(&temporary);
        }
        result
    }

    pub(super) fn remove(&self, name: &str) -> io::Result<()> {
        match unlinkat(&self.0, name, AtFlags::empty()) {
            Ok(()) | Err(rustix::io::Errno::NOENT) => Ok(()),
            Err(error) => Err(error.into()),
        }
    }
}
