use std::error::Error;

/// The protected update path cannot activate or attach until ownership and
/// whole-tree isolation can be established before any application code runs.
pub(crate) fn enter_desktop_launch<T>(
    preserve_external_desktop: bool,
    ordinary_launch: impl FnOnce() -> Result<T, Box<dyn Error>>,
) -> Result<T, Box<dyn Error>> {
    if preserve_external_desktop {
        return Err("Windows update/recovery launch blocked: activation ownership and pre-execution whole-tree isolation are unverified; existing Desktop processes preserved".into());
    }
    ordinary_launch()
}
