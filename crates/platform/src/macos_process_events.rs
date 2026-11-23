//! Decides when a supervisor's ownership ledger needs another process-tree scan.
//! A new owned process is forked by an owned process, so an idle tree raises no
//! event and is not rescanned on every lifecycle tick. Ownership is still decided
//! only by the scan itself.

use std::time::{Duration, Instant};

use nix::libc::timespec;
use nix::sys::event::{EvFlags, EventFilter, FilterFlag, KEvent, Kqueue};

use super::{PlatformError, ProcessSnapshot};

/// Bounds how long a change that no watched process announces stays unseen, such
/// as a process that joins the root's process group without being forked into it.
const FALLBACK_SCAN_INTERVAL: Duration = Duration::from_secs(2);

pub(super) struct ProcessEvents {
    queue: Kqueue,
    /// Owned process instances as (PID, start time).
    watched: Vec<(u32, u64)>,
    rescan: bool,
    scanned_at: Option<Instant>,
}

impl ProcessEvents {
    pub(super) fn new() -> Result<Self, PlatformError> {
        Ok(Self {
            queue: Kqueue::new().map_err(std::io::Error::from)?,
            watched: Vec::new(),
            rescan: false,
            scanned_at: None,
        })
    }

    /// Consumes pending events, so a `true` result must be followed by a scan.
    pub(super) fn scan_due(&mut self, now: Instant) -> Result<bool, PlatformError> {
        let mut events = [KEvent::new(
            0,
            EventFilter::EVFILT_PROC,
            EvFlags::empty(),
            FilterFlag::empty(),
            0,
            0,
        ); 16];
        let changed = self
            .queue
            .kevent(
                &[],
                &mut events,
                Some(timespec {
                    tv_sec: 0,
                    tv_nsec: 0,
                }),
            )
            .map_err(std::io::Error::from)?
            > 0;
        Ok(changed
            || self.rescan
            || self.scanned_at.is_none_or(|scanned_at| {
                now.saturating_duration_since(scanned_at) >= FALLBACK_SCAN_INTERVAL
            }))
    }

    /// Watches the owned processes a scan returned.
    pub(super) fn record_scan(&mut self, owned: &[ProcessSnapshot], now: Instant) {
        self.scanned_at = Some(now);
        self.watched.retain(|&(id, started_at_micros)| {
            owned
                .iter()
                .any(|process| process.id == id && process.started_at_micros == started_at_micros)
        });
        self.rescan = false;
        for process in owned {
            let instance = (process.id, process.started_at_micros);
            if self.watched.contains(&instance) {
                continue;
            }
            // A process can fork between the scan that found it and this
            // registration, and one that cannot be watched announces nothing.
            // Either way the next call must scan again.
            self.rescan = true;
            let watch = KEvent::new(
                process.id as usize,
                EventFilter::EVFILT_PROC,
                EvFlags::EV_ADD | EvFlags::EV_CLEAR,
                FilterFlag::NOTE_FORK | FilterFlag::NOTE_EXIT | FilterFlag::NOTE_EXEC,
                0,
                0,
            );
            if self.queue.kevent(&[watch], &mut [], None).is_ok() {
                self.watched.push(instance);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::io::{BufRead, BufReader, Write};
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    use super::{FALLBACK_SCAN_INTERVAL, ProcessEvents};
    use crate::process_snapshot;

    #[test]
    fn scans_after_a_watched_process_forks_and_otherwise_only_at_the_fallback_interval() {
        // The shell stays in `read` until released, forks once, then reads again.
        let mut child = Command::new("/bin/sh")
            .args([
                "-c",
                "printf 'ready\\n'; read -r token; /bin/sleep 0 & wait; read -r token",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .expect("spawn watched fixture");
        let mut ready = String::new();
        BufReader::new(child.stdout.take().expect("fixture stdout"))
            .read_line(&mut ready)
            .expect("read fixture readiness");
        assert_eq!(ready, "ready\n");
        let owned = [process_snapshot(child.id()).expect("snapshot watched fixture")];
        let mut events = ProcessEvents::new().expect("create process events");
        // A fixed clock keeps the fallback out of every assertion that does not name it.
        let now = Instant::now();

        assert!(events.scan_due(now).expect("before the first scan"));
        events.record_scan(&owned, now);
        assert!(events.scan_due(now).expect("after watching a new process"));
        events.record_scan(&owned, now);
        assert!(!events.scan_due(now).expect("idle tree"));
        assert!(
            !events
                .scan_due(now + FALLBACK_SCAN_INTERVAL - Duration::from_millis(1))
                .expect("before the fallback interval")
        );
        assert!(
            events
                .scan_due(now + FALLBACK_SCAN_INTERVAL)
                .expect("at the fallback interval")
        );

        let mut stdin = child.stdin.take().expect("fixture stdin");
        stdin.write_all(b"fork\n").expect("release the fork");
        let deadline = Instant::now() + Duration::from_secs(5);
        while !events.scan_due(now).expect("after a fork") {
            assert!(
                Instant::now() < deadline,
                "a fork by a watched process did not request a scan"
            );
            std::thread::sleep(Duration::from_millis(10));
        }

        drop(stdin);
        child.wait().expect("reap watched fixture");
    }
}
