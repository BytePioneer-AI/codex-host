#![forbid(unsafe_code)]
#![cfg_attr(
    all(target_os = "windows", not(debug_assertions)),
    windows_subsystem = "windows"
)]

#[cfg(target_os = "windows")]
fn run() -> Result<i32, Box<dyn std::error::Error>> {
    use codexhost_platform::{
        canonical_existing_file, configure_background_command, desktop_helper_proxy_environment,
        spawn_supervised, validate_proxy_target,
    };
    use std::path::PathBuf;
    use std::process::{Command, Stdio};

    // Desktop supplies this official primary-runtime path with its tool config.
    // Never search PATH or execute a shell to locate the underlying runtime.
    let node = canonical_existing_file(&PathBuf::from(
        std::env::var_os("NODE_REPL_NODE_PATH")
            .ok_or("NODE_REPL_NODE_PATH is required for the Desktop tool proxy")?,
    ))?;
    if !node
        .file_name()
        .is_some_and(|name| name.to_string_lossy().eq_ignore_ascii_case("node.exe"))
    {
        return Err(
            "NODE_REPL_NODE_PATH must identify the official Node runtime executable".into(),
        );
    }
    let runtime = validate_proxy_target(
        &std::env::current_exe()?,
        &node.with_file_name("node_repl.exe"),
    )?;
    let mut command = Command::new(runtime);
    command
        .args(std::env::args_os().skip(1))
        .envs(desktop_helper_proxy_environment())
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    configure_background_command(&mut command);
    let mut child = spawn_supervised(&mut command)?;
    Ok(child.wait()?.code().unwrap_or(1))
}

#[cfg(not(target_os = "windows"))]
fn run() -> Result<i32, Box<dyn std::error::Error>> {
    Err("the Desktop node_repl proxy is only used on Windows".into())
}

fn main() {
    let code = match run() {
        Ok(code) => code,
        Err(error) => {
            eprintln!("codexhost tool proxy: {error}");
            1
        }
    };
    std::process::exit(code);
}
