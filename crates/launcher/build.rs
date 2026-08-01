use std::env;
use std::path::PathBuf;

fn main() {
    println!("cargo:rerun-if-changed=windows.manifest");
    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }
    let manifest = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("manifest directory"))
        .join("windows.manifest");
    for binary in ["codexhost", "codexhost-start"] {
        println!("cargo:rustc-link-arg-bin={binary}=/MANIFEST:EMBED");
        println!(
            "cargo:rustc-link-arg-bin={binary}=/MANIFESTINPUT:{}",
            manifest.display()
        );
    }
}
