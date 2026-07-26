#![forbid(unsafe_code)]

use std::env;
use std::error::Error;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::thread;
use std::time::{Duration, Instant};

use codexhost_gate_a_native::{
    DESKTOP_VERSION_ENV, INSTALL_ROOT_ENV, LAUNCH_MODE_ENV, PROBE_OUTPUT_ENV,
};
#[cfg(not(target_os = "macos"))]
use codexhost_platform::launch_desktop;
#[cfg(target_os = "macos")]
use codexhost_platform::launch_desktop_session;
use codexhost_platform::{
    DesktopInstallation, DesktopLaunchMode, desktop_process_ids, discover_codex_desktop,
};

const DEFAULT_CAPTURE_TIMEOUT: Duration = Duration::from_secs(30);

fn usage() {
    eprintln!(
        "usage: codexhost-probe --shim <absolute-path> [--launch-mode <launch-services|direct-executable>] [--output <directory>] [--wait-seconds <seconds>] [--exit-after-capture]"
    );
}

#[derive(Debug)]
struct ProbeOptions {
    shim_path: PathBuf,
    launch_mode: DesktopLaunchMode,
    output_directory: PathBuf,
    wait_timeout: Duration,
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    exit_after_capture: bool,
}

fn parse_options(arguments: &[String]) -> Result<ProbeOptions, String> {
    let mut shim_path = None;
    let mut launch_mode = if cfg!(target_os = "macos") {
        None
    } else {
        Some(DesktopLaunchMode::DirectExecutable)
    };
    let mut output_directory = PathBuf::from(".codexhost/probes");
    let mut wait_timeout = DEFAULT_CAPTURE_TIMEOUT;
    let mut exit_after_capture = false;
    let mut index = 0;

    while index < arguments.len() {
        match arguments[index].as_str() {
            "--shim" => {
                index += 1;
                shim_path = arguments.get(index).map(PathBuf::from);
                if shim_path.is_none() {
                    return Err("--shim requires a path".into());
                }
            }
            "--launch-mode" => {
                index += 1;
                launch_mode = Some(match arguments.get(index).map(String::as_str) {
                    Some("launch-services") => DesktopLaunchMode::LaunchServices,
                    Some("direct-executable") => DesktopLaunchMode::DirectExecutable,
                    Some(value) => return Err(format!("invalid --launch-mode value: {value}")),
                    None => return Err("--launch-mode requires a value".into()),
                });
            }
            "--output" => {
                index += 1;
                output_directory = arguments
                    .get(index)
                    .map(PathBuf::from)
                    .ok_or_else(|| "--output requires a directory".to_owned())?;
            }
            "--wait-seconds" => {
                index += 1;
                let seconds = arguments
                    .get(index)
                    .ok_or_else(|| "--wait-seconds requires an integer".to_owned())?
                    .parse::<u64>()
                    .map_err(|error| format!("invalid --wait-seconds value: {error}"))?;
                wait_timeout = Duration::from_secs(seconds);
            }
            "--exit-after-capture" => exit_after_capture = true,
            unknown => return Err(format!("unknown probe argument: {unknown}")),
        }
        index += 1;
    }

    let shim_path = shim_path.ok_or_else(|| "probe requires --shim".to_owned())?;
    if !shim_path.is_absolute() {
        return Err("--shim must be an absolute path".into());
    }
    let launch_mode = launch_mode.ok_or_else(|| {
        "macOS probe requires --launch-mode <launch-services|direct-executable>".to_owned()
    })?;

    Ok(ProbeOptions {
        shim_path,
        launch_mode,
        output_directory,
        wait_timeout,
        exit_after_capture,
    })
}

fn capture_files(directory: &Path) -> Result<Vec<PathBuf>, std::io::Error> {
    let mut files = directory
        .read_dir()?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension == "json")
        })
        .collect::<Vec<_>>();
    files.sort();
    Ok(files)
}

fn capture_environment(
    installation: &DesktopInstallation,
    options: &ProbeOptions,
    output_directory: &Path,
) -> [(OsString, OsString); 4] {
    [
        (
            OsString::from(PROBE_OUTPUT_ENV),
            output_directory.as_os_str().to_owned(),
        ),
        (
            OsString::from(DESKTOP_VERSION_ENV),
            OsString::from(&installation.version),
        ),
        (
            OsString::from(INSTALL_ROOT_ENV),
            installation.install_root.as_os_str().to_owned(),
        ),
        (
            OsString::from(LAUNCH_MODE_ENV),
            OsString::from(options.launch_mode.as_str()),
        ),
    ]
}

fn probe(options: ProbeOptions) -> Result<(), Box<dyn Error>> {
    let installation = discover_codex_desktop()?;
    let process_ids = desktop_process_ids()?;
    if !process_ids.is_empty() {
        return Err(format!(
            "Codex Desktop is already running (PIDs: {}); close it normally before starting an isolated probe",
            process_ids
                .iter()
                .map(u32::to_string)
                .collect::<Vec<_>>()
                .join(", ")
        )
        .into());
    }

    let output_directory = if options.output_directory.is_absolute() {
        options.output_directory.clone()
    } else {
        env::current_dir()?.join(&options.output_directory)
    };
    std::fs::create_dir_all(&output_directory)?;
    let before = capture_files(&output_directory)?;
    let environment = capture_environment(&installation, &options, &output_directory);

    #[cfg(target_os = "macos")]
    return probe_macos(
        &installation,
        &options,
        &output_directory,
        &before,
        &environment,
    );

    #[cfg(not(target_os = "macos"))]
    {
        let mut desktop = launch_desktop(
            &installation,
            &options.shim_path,
            options.launch_mode,
            &environment,
        )?;
        eprintln!(
            "started Codex Desktop {} as PID {}; waiting for Shim capture",
            installation.version,
            desktop.id()
        );
        let started = Instant::now();
        loop {
            let captures = capture_files(&output_directory)?;
            if let Some(capture) = captures.iter().find(|capture| !before.contains(capture)) {
                println!("capture={}", capture.display());
                println!("desktop_version={}", installation.version);
                return Ok(());
            }
            if started.elapsed() >= options.wait_timeout {
                let status = desktop.try_wait()?;
                return Err(format!(
                    "Desktop did not invoke the Shim within {:?}; launcher_status={status:?}",
                    options.wait_timeout
                )
                .into());
            }
            thread::sleep(Duration::from_millis(200));
        }
    }
}

#[cfg(target_os = "macos")]
fn probe_macos(
    installation: &DesktopInstallation,
    options: &ProbeOptions,
    output_directory: &Path,
    before: &[PathBuf],
    environment: &[(OsString, OsString)],
) -> Result<(), Box<dyn Error>> {
    let mut desktop = launch_desktop_session(
        installation,
        &options.shim_path,
        options.launch_mode,
        environment,
        options.wait_timeout,
    )?;
    let root = desktop.root_snapshot();
    eprintln!(
        "started Codex Desktop {} as PID {} (PPID {}, PGID {}); waiting for Shim capture",
        installation.version, root.id, root.parent_id, root.process_group_id
    );

    let started = Instant::now();
    let capture = loop {
        let _ = desktop.observe()?;
        let captures = capture_files(output_directory)?;
        if let Some(capture) = captures.iter().find(|capture| !before.contains(capture)) {
            break capture.clone();
        }
        if !desktop.is_running()? {
            return Err("Desktop exited before invoking the Shim".into());
        }
        if started.elapsed() >= options.wait_timeout {
            return Err(format!(
                "Desktop did not invoke the Shim within {:?}",
                options.wait_timeout
            )
            .into());
        }
        thread::sleep(Duration::from_millis(100));
    };
    println!("capture={}", capture.display());
    println!("desktop_version={}", installation.version);
    println!("desktop_process_id={}", desktop.root_snapshot().id);

    if options.exit_after_capture {
        desktop.disarm_cleanup();
        return Ok(());
    }

    eprintln!("Shim invocation captured; supervising Desktop until it exits");
    while desktop.is_running()? {
        let escaped = desktop.cleanup_escaped(Duration::from_secs(2))?;
        if !escaped.is_empty() {
            eprintln!(
                "cleaned escaped Desktop descendants: {}",
                escaped
                    .iter()
                    .map(u32::to_string)
                    .collect::<Vec<_>>()
                    .join(",")
            );
        }
        thread::sleep(Duration::from_millis(100));
    }
    let escaped = desktop.cleanup_escaped(Duration::from_secs(2))?;
    if !escaped.is_empty() {
        eprintln!(
            "cleaned escaped Desktop descendants after root exit: {}",
            escaped
                .iter()
                .map(u32::to_string)
                .collect::<Vec<_>>()
                .join(",")
        );
    }
    if !desktop.wait_for_exit(Duration::from_secs(5))? {
        desktop.force_terminate()?;
        if !desktop.wait_for_exit(Duration::from_secs(5))? {
            return Err("Desktop descendants remained after bounded cleanup".into());
        }
    }
    Ok(())
}

fn run() -> Result<(), Box<dyn Error>> {
    probe(parse_options(&env::args().skip(1).collect::<Vec<_>>())?)
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("codexhost Gate Probe: {error}");
            usage();
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::{DesktopLaunchMode, parse_options};

    #[test]
    fn requires_absolute_shim_path() {
        let error = parse_options(&["--shim".into(), "shim.exe".into()])
            .expect_err("relative paths must fail");
        assert!(error.contains("absolute"));
    }

    #[test]
    fn parses_probe_options() {
        let absolute = if cfg!(target_os = "windows") {
            r"C:\probe\codexhost-shim-probe.exe"
        } else {
            "/probe/codexhost-shim-probe"
        };
        let options = parse_options(&[
            "--shim".into(),
            absolute.into(),
            "--launch-mode".into(),
            "direct-executable".into(),
            "--output".into(),
            "captures".into(),
            "--wait-seconds".into(),
            "5".into(),
        ])
        .expect("valid options");
        assert_eq!(options.shim_path, PathBuf::from(absolute));
        assert_eq!(options.launch_mode, DesktopLaunchMode::DirectExecutable);
        assert_eq!(options.wait_timeout.as_secs(), 5);
    }
}
