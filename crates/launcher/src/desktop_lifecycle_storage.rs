use std::fs::{self, File};
use std::io;
use std::path::Path;
use std::thread;
use std::time::{Duration, Instant};

use fs2::FileExt;
use rustix::fs::OFlags;

use crate::secure_storage::{
    open_child, open_directory, open_private_at, publish_private_at, read_bounded,
    unlink_private_at, verify_directory,
};

pub(super) struct Store(File);

impl Store {
    pub(super) fn open(runtime: &Path, create: bool) -> io::Result<Self> {
        if create {
            fs::create_dir_all(runtime)?;
        }
        let parent = open_directory(runtime)?;
        verify_directory(&parent, 0o022)?;
        let directory = open_child(&parent, "desktop-lifecycle-v1", create)?;
        verify_directory(&directory, 0o7077)?;
        Ok(Self(directory))
    }

    pub(super) fn lock(&self, deadline: Instant) -> io::Result<File> {
        let file = open_private_at(&self.0, "operation.lock", OFlags::RDWR | OFlags::CREATE)?;
        loop {
            match file.try_lock_exclusive() {
                Ok(()) => return Ok(file),
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    let remaining = deadline.saturating_duration_since(Instant::now());
                    if remaining.is_zero() {
                        return Err(io::Error::new(
                            error.kind(),
                            "Desktop lifecycle operation is busy",
                        ));
                    }
                    thread::sleep(Duration::from_millis(25).min(remaining));
                }
                Err(error) => return Err(error),
            }
        }
    }

    pub(super) fn read(&self, name: &str, limit: usize) -> io::Result<Option<Vec<u8>>> {
        match open_private_at(&self.0, name, OFlags::RDONLY) {
            Ok(file) => read_bounded(&file, limit).map(Some),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error),
        }
    }

    pub(super) fn publish(&self, name: &str, bytes: &[u8]) -> io::Result<()> {
        publish_private_at(&self.0, name, bytes)
    }

    pub(super) fn remove(&self, name: &str) -> io::Result<()> {
        unlink_private_at(&self.0, name)
    }
}
