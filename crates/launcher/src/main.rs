#![forbid(unsafe_code)]

use std::env;
use std::error::Error;
use std::process::ExitCode;

use codexhost_platform::{
    DesktopIdentity, DesktopInstallation, desktop_process_ids, discover_codex_desktop,
};

fn usage() {
    eprintln!("usage:\n  codexhost inspect");
}

fn print_installation(installation: &DesktopInstallation, process_ids: &[u32]) {
    match &installation.identity {
        DesktopIdentity::WindowsPackage {
            package_name,
            package_family_name,
        } => {
            println!("platform=windows");
            println!("package_name={package_name}");
            println!("package_family_name={package_family_name}");
        }
        DesktopIdentity::MacOsBundle { bundle_identifier } => {
            println!("platform=macos");
            println!("bundle_identifier={bundle_identifier}");
        }
    }
    println!("desktop_version={}", installation.version);
    println!("install_root={}", installation.install_root.display());
    println!(
        "desktop_executable={}",
        installation.desktop_executable.display()
    );
    println!(
        "packaged_codex_cli={}",
        installation.packaged_codex_cli.display()
    );
    println!(
        "executable_codex_cli={}",
        installation.executable_codex_cli.display()
    );
    let process_list = process_ids
        .iter()
        .map(u32::to_string)
        .collect::<Vec<_>>()
        .join(",");
    println!("desktop_process_ids={process_list}");
}

fn inspect() -> Result<(), Box<dyn Error>> {
    let installation = discover_codex_desktop()?;
    let process_ids = desktop_process_ids()?;
    print_installation(&installation, &process_ids);
    Ok(())
}

fn run() -> Result<(), Box<dyn Error>> {
    let arguments = env::args().skip(1).collect::<Vec<_>>();
    match arguments.first().map(String::as_str) {
        Some("inspect") if arguments.len() == 1 => inspect(),
        _ => {
            usage();
            Err("invalid launcher arguments".into())
        }
    }
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("codexhost launcher: {error}");
            ExitCode::FAILURE
        }
    }
}
