#![forbid(unsafe_code)]

use std::process;

fn main() {
    let exit_code = match codexhost_shim::run_from_environment() {
        Ok(code) => code,
        Err(error) => {
            eprintln!("codexhost shim: {error}");
            1
        }
    };
    process::exit(exit_code);
}
