use super::{publish_status, readiness, wait_for_shutdown};
use fs2::FileExt;
use std::fs::OpenOptions;
use std::time::Duration;
use std::time::{SystemTime, UNIX_EPOCH};
use std::{env, fs, thread};

#[test]
fn publishes_complete_private_status_before_readiness() {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = env::temp_dir().join(format!("codexhost-ready-{}-{nonce}", std::process::id()));
    fs::create_dir_all(&root).unwrap();
    let file = root.join("status.ready");
    let target = file.clone();
    let writer = thread::spawn(move || {
        for index in 0..100 {
            publish_status(
                &target,
                if index % 2 == 0 {
                    "ready\n"
                } else {
                    "startup rejected\n"
                },
            )
            .unwrap();
        }
    });
    while !writer.is_finished() {
        if let Some(Err(error)) = readiness(&file) {
            assert_eq!(error.to_string(), "startup rejected\n");
        }
    }
    writer.join().unwrap();
    assert_eq!(fs::read_to_string(&file).unwrap(), "startup rejected\n");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(fs::metadata(&file).unwrap().permissions().mode() & 0o077, 0);
    }
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn shutdown_requires_supervised_tree_admission_to_be_released() {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = env::temp_dir().join(format!("codexhost-stop-{}-{nonce}", std::process::id()));
    fs::create_dir_all(&root).unwrap();
    let owner = OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .open(root.join("shared-host-process.lock"))
        .unwrap();
    owner.lock_exclusive().unwrap();
    assert_eq!(
        wait_for_shutdown(&root, Duration::from_millis(1))
            .unwrap_err()
            .to_string(),
        "Shared Host process tree exit was not confirmed"
    );
    FileExt::unlock(&owner).unwrap();
    wait_for_shutdown(&root, Duration::from_secs(1)).unwrap();
    drop(owner);
    fs::remove_dir_all(&root).unwrap();
    wait_for_shutdown(&root, Duration::from_secs(1)).unwrap();
}
