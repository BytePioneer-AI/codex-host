use std::collections::BTreeMap;
use std::error::Error;
use std::ffi::OsString;

pub(crate) fn launcher_proxy_environment() -> Vec<(OsString, OsString)> {
    codexhost_platform::proxy_environment()
}

/// Private launcher-to-Node bridge; proxy credentials must not be logged by the caller.
pub(crate) fn print_proxy_environment() -> Result<(), Box<dyn Error>> {
    let environment = launcher_proxy_environment()
        .into_iter()
        .map(|(name, value)| {
            (
                name.to_string_lossy().into_owned(),
                value.to_string_lossy().into_owned(),
            )
        })
        .collect::<BTreeMap<_, _>>();
    println!("{}", serde_json::to_string(&environment)?);
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn launcher_uses_shared_proxy_environment_resolution() {
        let _ = super::launcher_proxy_environment();
    }
}
