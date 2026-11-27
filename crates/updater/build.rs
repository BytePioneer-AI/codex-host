use std::env;
use std::path::PathBuf;

const ENGLISH_US_LANG_ID: u16 = 0x0409;

fn main() {
    println!("cargo:rerun-if-changed=windows.manifest");
    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }

    let crate_root = PathBuf::from(
        env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR must be available"),
    );
    let manifest = crate_root.join("windows.manifest");
    winresource::WindowsResource::new()
        .set_language(ENGLISH_US_LANG_ID)
        .set("CompanyName", "codexhost")
        .set("ProductName", "codexhost")
        .set("FileDescription", "codexhost Background Updater")
        .set("OriginalFilename", "codexhost-updater.exe")
        .set("InternalName", "codexhost-updater")
        .set("LegalCopyright", "Copyright (c) codexhost contributors")
        .set_manifest_file(
            manifest
                .to_str()
                .expect("manifest path must be valid UTF-8"),
        )
        .compile()
        .expect("failed to compile Windows updater resources");
}
