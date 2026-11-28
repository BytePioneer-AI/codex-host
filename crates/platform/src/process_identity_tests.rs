use super::{process_identity, process_instance};

#[test]
fn process_instance_rejects_a_different_start_time() {
    let live = process_identity(std::process::id()).unwrap();
    assert_eq!(live.id, std::process::id());
    assert!(process_instance(live.id, live.started_at_micros).is_some());
    assert!(process_instance(live.id, live.started_at_micros + 1).is_none());
}

#[cfg(target_os = "macos")]
#[test]
fn observation_distinguishes_absent_invalid_and_live_pids() {
    use super::observe_process_identity;
    assert!(observe_process_identity(i32::MAX as u32).unwrap().is_none());
    assert!(observe_process_identity(0).is_err());
    let own = std::process::id();
    assert_eq!(observe_process_identity(own).unwrap().unwrap().id, own);
}

#[cfg(target_os = "linux")]
#[test]
fn an_unreaped_exited_process_is_not_a_running_instance() {
    use std::process::Command;
    use std::time::{Duration, Instant};
    use std::{fs, thread};

    let mut child = Command::new("/bin/sleep").arg("0.1").spawn().unwrap();
    let result = std::panic::catch_unwind(|| {
        let live = process_identity(child.id()).unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let stat = fs::read_to_string(format!("/proc/{}/stat", live.id)).unwrap();
            if stat[stat.rfind(')').unwrap() + 2..].starts_with("Z ") {
                break;
            }
            assert!(Instant::now() < deadline, "fixture did not exit");
            thread::sleep(Duration::from_millis(10));
        }
        assert!(process_instance(live.id, live.started_at_micros).is_none());
    });
    let _ = child.kill();
    child.wait().unwrap();
    result.unwrap();
}

#[cfg(target_os = "macos")]
#[test]
fn observation_treats_an_unreaped_exited_child_as_absent() {
    use nix::libc::timespec;
    use nix::sys::event::{EvFlags, EventFilter, FilterFlag, KEvent, Kqueue};
    use nix::{
        sys::signal::{Signal, kill},
        unistd::Pid,
    };
    use std::process::Command;
    use std::time::{Duration, Instant};

    let mut child = Command::new("/bin/sleep").arg("30").spawn().unwrap();
    let child_id = child.id();
    let pid = Pid::from_raw(child_id as i32);
    let result = std::panic::catch_unwind(|| {
        let queue = Kqueue::new().unwrap();
        let watch = KEvent::new(
            child_id as usize,
            EventFilter::EVFILT_PROC,
            EvFlags::EV_ADD | EvFlags::EV_ONESHOT,
            FilterFlag::NOTE_EXIT,
            0,
            0,
        );
        queue.kevent(&[watch], &mut [], None).unwrap();
        kill(pid, Signal::SIGKILL).unwrap();
        let mut events = [watch];
        assert_eq!(
            queue
                .kevent(
                    &[],
                    &mut events,
                    Some(timespec {
                        tv_sec: 5,
                        tv_nsec: 0
                    })
                )
                .unwrap(),
            1,
            "fixture did not exit",
        );
        assert!(events[0].fflags().contains(FilterFlag::NOTE_EXIT));
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            assert!(kill(pid, None).is_ok());
            if super::observe_process_identity(child_id).unwrap().is_none() {
                break;
            }
            assert!(Instant::now() < deadline, "fixture remained observable");
            std::thread::sleep(Duration::from_millis(10));
        }
    });
    let _ = child.kill();
    child.wait().unwrap();
    result.unwrap();
}
