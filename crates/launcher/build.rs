use std::env;
use std::path::PathBuf;

fn main() {
    println!("cargo:rerun-if-changed=assets/codexhost.ico");
    println!("cargo:rerun-if-changed=windows.manifest");
    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }

    let crate_root = PathBuf::from(
        env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR must be available"),
    );
    let icon = crate_root.join("assets/codexhost.ico");
    let manifest = crate_root.join("windows.manifest");
    winresource::WindowsResource::new()
        .set_icon(icon.to_str().expect("icon path must be valid UTF-8"))
        .set_manifest_file(
            manifest
                .to_str()
                .expect("manifest path must be valid UTF-8"),
        )
        .compile()
        .expect("failed to compile Windows launcher resources");
}
