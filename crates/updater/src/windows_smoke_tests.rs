//! Real initial startup only. Subsequent updates are requested through the real
//! Host by tools/update-fixtures/codex-host-smoke.mjs, never through test effects.
use std::{fs, path::PathBuf};
#[test]
#[ignore = "launches pre-existing real Codex; separately authorized disposable interactive Windows only"]
fn initial_protected_real_codex_host() {
    assert_eq!(
        std::env::var("CODEXHOST_DISPOSABLE_WINDOWS_USER").unwrap(),
        "fixture-only"
    );
    let scratch = fs::canonicalize(std::env::var_os("RUNNER_TEMP").unwrap()).unwrap();
    let path = PathBuf::from(std::env::var_os("CODEXHOST_REAL_SMOKE_REQUEST").unwrap());
    assert!(path.canonicalize().unwrap().starts_with(&scratch));
    assert!(fs::metadata(&path).unwrap().len() < 64 * 1024);
    let request: crate::request::UpdateRequest =
        serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
    let installation_root = match &request.installation {
        crate::request::Installation::WindowsInstaller(w) => &w.install_root,
        crate::request::Installation::Npm(npm) => npm.prefix.as_ref().expect("original npm prefix"),
        _ => panic!("Windows original channel required"),
    };
    assert!(
        installation_root
            .canonicalize()
            .unwrap()
            .starts_with(&scratch)
    );
    let data =
        PathBuf::from(std::env::var_os("CODEXHOST_DATA_DIR").expect("private data directory"));
    assert!(
        data.parent()
            .unwrap()
            .canonicalize()
            .unwrap()
            .starts_with(&scratch)
    );
    fs::create_dir_all(&data).unwrap();
    assert!(data.canonicalize().unwrap().starts_with(&scratch));
    // Real capture/CREATE_SUSPENDED/activation/Job/bind/readiness. No production
    // execution policy is changed and no test launch result is substituted.
    crate::windows_launch::launch(&request).expect("real initial protected Codex/Host readiness");
}
