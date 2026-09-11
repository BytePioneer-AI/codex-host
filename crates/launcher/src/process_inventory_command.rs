use std::error::Error;
use std::io::{self, Write};

const MAX_PROCESS_IDS: usize = 10_000;

pub(crate) fn run(arguments: &[String]) -> Result<(), Box<dyn Error>> {
    fn execute(arguments: &[String]) -> Result<(), Box<dyn Error>> {
        let [flag, name] = arguments else {
            return Err("invalid process inventory request".into());
        };
        if flag != "--name" {
            return Err("invalid process inventory request".into());
        }
        let process_ids = codexhost_platform::process_ids_by_executable_name(name)?;
        if process_ids.len() > MAX_PROCESS_IDS {
            return Err("process inventory exceeds its limit".into());
        }
        serde_json::to_writer(
            io::stdout().lock(),
            &serde_json::json!({"pids": process_ids}),
        )?;
        io::stdout().write_all(b"\n")?;
        Ok(())
    }

    execute(arguments).map_err(|_| "native process inventory unavailable".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_argument_shapes_without_echoing_values() {
        let error = run(&["--name".into(), "synthetic-secret/path".into()]).unwrap_err();
        assert_eq!(error.to_string(), "native process inventory unavailable");
    }
}
