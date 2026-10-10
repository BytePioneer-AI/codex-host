//! Test-only executable with Codex's argument layout; never invokes a real CLI.
use std::{env, process::Command};

fn main() {
    let script = env::current_exe().unwrap().with_file_name("native-codex.mjs");
    let mut command = Command::new(env::var_os("NATIVE_FIXTURE_NODE").unwrap());
    command.arg(script).args(env::args_os().skip(1));
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        panic!("fixture exec failed: {}", command.exec());
    }
    #[cfg(windows)]
    std::process::exit(command.status().unwrap().code().unwrap_or(1));
}
