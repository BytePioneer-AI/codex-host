use std::error::Error;
use std::io::{self, Read, Write};

pub(crate) fn run() -> Result<(), Box<dyn Error>> {
    fn execute() -> Result<(), Box<dyn Error>> {
        let mut input = String::new();
        io::stdin().take(65).read_to_string(&mut input)?;
        if input.len() > 64 {
            return Err("invalid process identity request".into());
        }
        let pid: u32 = serde_json::from_str(&input)?;
        let identity = codexhost_platform::process_identity(pid)?;
        serde_json::to_writer(
            io::stdout().lock(),
            &serde_json::json!({"identity": identity}),
        )?;
        io::stdout().write_all(b"\n")?;
        Ok(())
    }
    execute().map_err(|_| "native process identity unavailable".into())
}
