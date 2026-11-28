use std::env;
use std::path::{Path, PathBuf};
use std::process::Command;

const ENGLISH_US_LANG_ID: u16 = 0x0409;
const COMPANY_NAME: &str = "codexhost";
const PRODUCT_NAME: &str = "codexhost";
const LEGAL_COPYRIGHT: &str = "Copyright (c) codexhost contributors";

fn main() {
    println!("cargo:rerun-if-changed=windows.manifest");
    println!("cargo:rerun-if-env-changed=RC_PATH");
    println!("cargo:rerun-if-env-changed=WINDRES");
    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }

    let crate_root = PathBuf::from(
        env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR must be available"),
    );
    let out_dir = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR must be available"));
    let manifest = crate_root.join("windows.manifest");

    compile_bin_resource(
        &crate_root,
        &out_dir,
        "codexhost-shim",
        "codexhost-shim.exe",
        "codexhost CLI Proxy Shim",
        &manifest,
    );
    compile_bin_resource(
        &crate_root,
        &out_dir,
        "codexhost-node-repl",
        "codexhost-node-repl.exe",
        "codexhost Desktop Tool Proxy",
        &manifest,
    );
}

fn compile_bin_resource(
    crate_root: &Path,
    out_dir: &Path,
    bin_name: &str,
    original_filename: &str,
    file_description: &str,
    manifest: &Path,
) {
    let mut resource = winresource::WindowsResource::new();
    resource
        .set_language(ENGLISH_US_LANG_ID)
        .set("CompanyName", COMPANY_NAME)
        .set("ProductName", PRODUCT_NAME)
        .set("FileDescription", file_description)
        .set("OriginalFilename", original_filename)
        .set("InternalName", bin_name)
        .set("LegalCopyright", LEGAL_COPYRIGHT)
        .set_manifest_file(
            manifest
                .to_str()
                .expect("manifest path must be valid UTF-8"),
        );

    let rc_path = out_dir.join(format!("{bin_name}.rc"));
    resource
        .write_resource_file(&rc_path)
        .expect("failed to write Windows resource script");

    match env::var("CARGO_CFG_TARGET_ENV").as_deref() {
        Ok("msvc") => {
            let res_path = out_dir.join(format!("{bin_name}.res"));
            compile_msvc_rc(crate_root, &rc_path, &res_path);
            println!("cargo:rustc-link-arg-bin={bin_name}={}", res_path.display());
        }
        Ok("gnu") => {
            let obj_path = out_dir.join(format!("{bin_name}.o"));
            compile_gnu_rc(crate_root, &rc_path, &obj_path);
            println!("cargo:rustc-link-arg-bin={bin_name}={}", obj_path.display());
        }
        other => panic!("unsupported Windows target env for resource compilation: {other:?}"),
    }
}

fn compile_msvc_rc(crate_root: &Path, rc_path: &Path, res_path: &Path) {
    let rc_exe = resolve_msvc_rc();
    let mut command = Command::new(&rc_exe);
    command
        .arg(format!("/I{}", crate_root.display()))
        .arg(format!("/fo{}", res_path.display()));
    if cfg!(unix) {
        command.args(["/C", "65001", "--"]);
    }
    let output = command
        .arg(rc_path)
        .output()
        .unwrap_or_else(|error| panic!("failed to run {}: {error}", rc_exe.display()));
    if !output.status.success() {
        panic!(
            "resource compiler {} failed for {}:\nstdout:\n{}\nstderr:\n{}",
            rc_exe.display(),
            rc_path.display(),
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr),
        );
    }
}

fn resolve_msvc_rc() -> PathBuf {
    if let Some(rc_path) = env::var_os("RC_PATH") {
        return PathBuf::from(rc_path);
    }
    #[cfg(unix)]
    {
        PathBuf::from("llvm-rc")
    }
    #[cfg(windows)]
    {
        find_windows_sdk_rc().unwrap_or_else(|| PathBuf::from("rc.exe"))
    }
    #[cfg(not(any(unix, windows)))]
    {
        PathBuf::from("rc.exe")
    }
}

#[cfg(windows)]
fn find_windows_sdk_rc() -> Option<PathBuf> {
    let archs: &[&str] = if cfg!(target_arch = "aarch64") {
        &["arm64", "x64", "x86"]
    } else if cfg!(target_arch = "x86_64") {
        &["x64", "x86"]
    } else {
        &["x86"]
    };

    if let Some(sdk_dir) = env::var_os("WindowsSdkDir") {
        let base = PathBuf::from(sdk_dir).join("bin");
        if let Some(version) = env::var_os("WindowsSDKVersion") {
            let trimmed = version.to_string_lossy();
            let trimmed = trimmed.trim_matches(['\\', '/']);
            for arch in archs {
                let candidate = base.join(trimmed).join(arch).join("rc.exe");
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
    }

    let output = Command::new("reg")
        .args([
            "query",
            r"HKLM\SOFTWARE\Microsoft\Windows Kits\Installed Roots",
            "/reg:32",
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut roots = Vec::new();
    for line in stdout.lines() {
        let trimmed = line.trim();
        if !trimmed.starts_with("KitsRoot") {
            continue;
        }
        let Some(index) = trimmed.find("REG_SZ") else {
            continue;
        };
        roots.push(PathBuf::from(trimmed[index + "REG_SZ".len()..].trim()));
    }
    for root in roots.into_iter().rev() {
        let bin = root.join("bin");
        if let Ok(entries) = std::fs::read_dir(&bin) {
            let mut subdirs: Vec<PathBuf> = entries
                .filter_map(|entry| entry.ok().map(|entry| entry.path()))
                .filter(|path| path.is_dir())
                .collect();
            subdirs.sort();
            for subdir in subdirs.into_iter().rev() {
                for arch in archs {
                    let candidate = subdir.join(arch).join("rc.exe");
                    if candidate.is_file() {
                        return Some(candidate);
                    }
                }
            }
        }
        for arch in archs {
            let candidate = bin.join(arch).join("rc.exe");
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

fn compile_gnu_rc(crate_root: &Path, rc_path: &Path, obj_path: &Path) {
    let windres = env::var("WINDRES").unwrap_or_else(|_| {
        if let Ok(prefix) = env::var("CROSS_COMPILE") {
            format!("{prefix}windres")
        } else if env::var_os("HOST") != env::var_os("TARGET") {
            match env::var("TARGET").as_deref() {
                Ok("x86_64-pc-windows-gnu") => "x86_64-w64-mingw32-windres".to_string(),
                Ok("i686-pc-windows-gnu") => "i686-w64-mingw32-windres".to_string(),
                Ok("aarch64-pc-windows-gnu")
                | Ok("x86_64-pc-windows-gnullvm")
                | Ok("aarch64-pc-windows-gnullvm") => "llvm-windres".to_string(),
                _ => "windres".to_string(),
            }
        } else {
            "windres".to_string()
        }
    });
    let bfd_target: &[&str] = match env::var("CARGO_CFG_TARGET_ARCH").as_deref() {
        Ok("x86_64") => &["--target", "pe-x86-64"],
        Ok("x86") => &["--target", "pe-i386"],
        _ => &[],
    };
    let output = Command::new(&windres)
        .arg(format!("-I{}", crate_root.display()))
        .args(bfd_target)
        .arg(rc_path)
        .arg(obj_path)
        .output()
        .unwrap_or_else(|error| panic!("failed to run {windres}: {error}"));
    if !output.status.success() {
        panic!(
            "resource compiler {windres} failed for {}:\nstdout:\n{}\nstderr:\n{}",
            rc_path.display(),
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr),
        );
    }
}
