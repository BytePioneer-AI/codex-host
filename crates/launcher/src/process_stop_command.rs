use std::error::Error;
use std::io::{self, Write};

pub(crate) fn run(arguments: &[String]) -> Result<(), Box<dyn Error>> {
    fn execute(arguments: &[String]) -> Result<(), Box<dyn Error>> {
        if arguments.is_empty() || arguments.len() > 16 || !arguments.len().is_multiple_of(2) {
            return Err("invalid process stop request".into());
        }
        let names = arguments
            .chunks_exact(2)
            .map(|pair| {
                if pair[0] != "--name" {
                    return Err("invalid process stop request");
                }
                Ok(pair[1].clone())
            })
            .collect::<Result<Vec<_>, _>>()?;
        let stopped = codexhost_platform::stop_processes_by_executable_names(&names)?;
        serde_json::to_writer(
            io::stdout().lock(),
            &serde_json::json!({ "stopped": stopped }),
        )?;
        io::stdout().write_all(b"\n")?;
        Ok(())
    }
    execute(arguments).map_err(|_| "native process stop could not be confirmed".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_invalid_requests_without_echoing_input() {
        for arguments in [
            vec![],
            vec!["secret".into()],
            vec!["--name".into(), "secret/path".into()],
        ] {
            assert_eq!(
                run(&arguments).unwrap_err().to_string(),
                "native process stop could not be confirmed"
            );
        }
    }
}
