use std::ffi::OsString;

pub(crate) fn launcher_proxy_environment() -> Vec<(OsString, OsString)> {
    codexhost_platform::proxy_environment()
}

#[cfg(test)]
mod tests {
    #[test]
    fn launcher_uses_shared_proxy_environment_resolution() {
        let _ = super::launcher_proxy_environment();
    }
}
