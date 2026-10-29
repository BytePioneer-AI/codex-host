//! Activation arguments, unlike package-wide debugging environment, identify
//! one caller. They are verified before the AppX initial thread is resumed.
use crate::PlatformError;
use std::ffi::OsString;
const PREFIX: &str = "--codexhost-activation=";

pub(crate) fn valid_key(key: &str) -> bool {
    key.len() == 32
        && key
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}
pub(crate) fn marker(key: &str) -> Result<OsString, PlatformError> {
    if !valid_key(key) {
        return Err(PlatformError::Invalid("invalid activation nonce".into()));
    }
    Ok(format!("{PREFIX}{key}").into())
}
pub(crate) fn binding(arguments: &[OsString]) -> Result<Option<String>, PlatformError> {
    let mut key = None;
    for argument in arguments.iter().skip(1) {
        let Some(argument) = argument.to_str() else {
            continue;
        };
        if let Some(value) = argument.strip_prefix(PREFIX) {
            if key.is_some() || !valid_key(value) {
                return Err(PlatformError::Invalid(
                    "ambiguous activation binding".into(),
                ));
            }
            key = Some(value.to_owned());
        }
    }
    Ok(key)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_an_exact_unique_argument_binds_an_activation() {
        let key = "ab".repeat(16);
        let token = marker(&key).unwrap();
        assert_eq!(
            binding(&["Codex.exe".into(), token.clone()]).unwrap(),
            Some(key)
        );
        assert_eq!(
            binding(&[
                "Codex.exe".into(),
                "--url=--codexhost-activation=abc".into()
            ])
            .unwrap(),
            None
        );
        assert!(binding(&["Codex.exe".into(), token.clone(), token]).is_err());
        assert!(marker("../job").is_err());
    }
    #[test]
    fn actual_subprocess_arguments_not_package_environment_select_the_binding() {
        let key = "cd".repeat(16);
        for bound in [false, true] {
            let mut command = std::process::Command::new("node");
            command
                .args(["-e", "process.stdout.write(process.argv.join('\\n'))", "--"])
                .env("CODEXHOST_RUNTIME_NONCE", &key);
            if bound {
                command.arg(marker(&key).unwrap());
            }
            let output = command.output().unwrap();
            assert!(output.status.success());
            let text = String::from_utf8(output.stdout).unwrap();
            let args: Vec<OsString> = text.split('\n').map(OsString::from).collect();
            assert_eq!(binding(&args).unwrap().is_some(), bound);
        }
    }
    #[test]
    fn package_environment_and_another_callers_arguments_do_not_bind() {
        let own = "aa".repeat(16);
        let foreign = "bb".repeat(16);
        let foreign_arguments = vec!["Codex.exe".into(), marker(&foreign).unwrap()];
        assert_ne!(
            binding(&foreign_arguments).unwrap().as_deref(),
            Some(own.as_str())
        );
        assert_eq!(binding(&["Codex.exe".into()]).unwrap(), None);
    }
}
