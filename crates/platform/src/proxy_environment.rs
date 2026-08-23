use std::collections::{HashMap, HashSet};
use std::env;
use std::ffi::{OsStr, OsString};

#[cfg(target_os = "macos")]
use crate::{SystemProxySettings, system_proxy_settings};

#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct ProxySettings {
    http_proxy: Option<String>,
    https_proxy: Option<String>,
    all_proxy: Option<String>,
    exceptions: Vec<String>,
}

/// Returns the proxy environment that should be passed to a codexhost child.
///
/// Explicit environment variables always win. On macOS, missing variables are
/// filled from the operating system's static proxy configuration. Linux does
/// not have one portable system-proxy API, so its environment and TUN-based
/// proxy configurations remain authoritative.
pub fn proxy_environment() -> Vec<(OsString, OsString)> {
    let inherited = env::vars_os().collect::<Vec<_>>();
    #[cfg(target_os = "macos")]
    let system = match system_proxy_settings() {
        Ok(settings) => {
            if settings.automatic_configuration {
                eprintln!(
                    "codexhost: automatic macOS proxy configuration cannot be represented in child-process environment variables"
                );
            }
            Some(proxy_settings(&settings))
        }
        Err(error) => {
            eprintln!("codexhost: could not read macOS system proxy settings: {error}");
            None
        }
    };
    #[cfg(not(target_os = "macos"))]
    let system = None;

    proxy_environment_from(inherited, system.as_ref())
}

#[cfg(target_os = "macos")]
fn proxy_settings(settings: &SystemProxySettings) -> ProxySettings {
    ProxySettings {
        http_proxy: settings.http_proxy.clone(),
        https_proxy: settings.https_proxy.clone(),
        all_proxy: settings.all_proxy.clone(),
        exceptions: settings.exceptions.clone(),
    }
}

fn proxy_environment_from(
    inherited: impl IntoIterator<Item = (OsString, OsString)>,
    system: Option<&ProxySettings>,
) -> Vec<(OsString, OsString)> {
    let inherited = inherited.into_iter().collect::<HashMap<_, _>>();
    let mut environment = Vec::new();
    append_proxy_pair(
        &mut environment,
        &inherited,
        "HTTP_PROXY",
        "http_proxy",
        system.and_then(|settings| settings.http_proxy.as_deref()),
    );
    append_proxy_pair(
        &mut environment,
        &inherited,
        "HTTPS_PROXY",
        "https_proxy",
        system.and_then(|settings| settings.https_proxy.as_deref()),
    );
    append_proxy_pair(
        &mut environment,
        &inherited,
        "ALL_PROXY",
        "all_proxy",
        system.and_then(|settings| settings.all_proxy.as_deref()),
    );

    let proxy_active = environment.iter().any(|(name, value)| {
        matches!(
            name.to_str(),
            Some("HTTP_PROXY" | "HTTPS_PROXY" | "ALL_PROXY")
        ) && !value.is_empty()
    });
    let inherited_no_proxy = ["NO_PROXY", "no_proxy"]
        .into_iter()
        .filter_map(|name| inherited.get(OsStr::new(name)));
    let mut exceptions = inherited_no_proxy
        .flat_map(|value| {
            value
                .to_string_lossy()
                .split(',')
                .map(str::to_owned)
                .collect::<Vec<_>>()
        })
        .chain(
            system
                .into_iter()
                .flat_map(|settings| settings.exceptions.iter().cloned()),
        )
        .chain(["localhost".into(), "127.0.0.1".into(), "::1".into()])
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();
    let mut seen = HashSet::new();
    exceptions.retain(|value| seen.insert(value.to_ascii_lowercase()));
    if proxy_active
        || inherited.contains_key(OsStr::new("NO_PROXY"))
        || inherited.contains_key(OsStr::new("no_proxy"))
    {
        let value = OsString::from(exceptions.join(","));
        environment.push((OsString::from("NO_PROXY"), value.clone()));
        environment.push((OsString::from("no_proxy"), value));
    }

    if let Some(value) = inherited.get(OsStr::new("NODE_USE_ENV_PROXY")) {
        environment.push((OsString::from("NODE_USE_ENV_PROXY"), value.clone()));
    } else if proxy_active {
        environment.push((OsString::from("NODE_USE_ENV_PROXY"), OsString::from("1")));
    }
    environment
}

fn append_proxy_pair(
    environment: &mut Vec<(OsString, OsString)>,
    inherited: &HashMap<OsString, OsString>,
    uppercase: &str,
    lowercase: &str,
    system_value: Option<&str>,
) {
    match (
        inherited.get(OsStr::new(uppercase)),
        inherited.get(OsStr::new(lowercase)),
    ) {
        (Some(uppercase_value), Some(lowercase_value)) => {
            environment.push((OsString::from(uppercase), uppercase_value.clone()));
            environment.push((OsString::from(lowercase), lowercase_value.clone()));
        }
        (Some(value), None) | (None, Some(value)) => {
            environment.push((OsString::from(uppercase), value.clone()));
            environment.push((OsString::from(lowercase), value.clone()));
        }
        (None, None) => {
            if let Some(value) = system_value {
                environment.push((OsString::from(uppercase), OsString::from(value)));
                environment.push((OsString::from(lowercase), OsString::from(value)));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{ProxySettings, proxy_environment_from};
    use std::ffi::OsString;

    #[test]
    fn normalizes_inherited_proxy_variables_without_overriding_them() {
        let environment = proxy_environment_from(
            [
                (
                    OsString::from("HTTP_PROXY"),
                    OsString::from("http://explicit-proxy:3128"),
                ),
                (
                    OsString::from("NO_PROXY"),
                    OsString::from("internal.example,localhost"),
                ),
            ],
            Some(&ProxySettings {
                http_proxy: Some("http://system-proxy:8080".into()),
                https_proxy: Some("http://secure-system-proxy:8443".into()),
                all_proxy: Some("socks5://system-proxy:1080".into()),
                exceptions: vec![".local".into(), "10.0.0.0/8".into()],
            }),
        );
        let value = |name: &str| {
            environment
                .iter()
                .find(|(candidate, _)| candidate == name)
                .map(|(_, value)| value.to_string_lossy().into_owned())
        };

        assert_eq!(
            value("HTTP_PROXY").as_deref(),
            Some("http://explicit-proxy:3128")
        );
        assert_eq!(
            value("http_proxy").as_deref(),
            Some("http://explicit-proxy:3128")
        );
        assert_eq!(
            value("HTTPS_PROXY").as_deref(),
            Some("http://secure-system-proxy:8443")
        );
        assert_eq!(
            value("ALL_PROXY").as_deref(),
            Some("socks5://system-proxy:1080")
        );
        assert_eq!(value("NODE_USE_ENV_PROXY").as_deref(), Some("1"));
        assert_eq!(
            value("NO_PROXY").as_deref(),
            Some("internal.example,localhost,.local,10.0.0.0/8,127.0.0.1,::1")
        );
        assert_eq!(value("no_proxy"), value("NO_PROXY"));
    }

    #[test]
    fn omits_proxy_variables_when_neither_source_has_one() {
        assert!(proxy_environment_from([], None).is_empty());
    }

    #[test]
    fn preserves_an_explicit_node_proxy_switch() {
        let environment = proxy_environment_from(
            [
                (
                    OsString::from("HTTPS_PROXY"),
                    OsString::from("http://proxy:8443"),
                ),
                (OsString::from("NODE_USE_ENV_PROXY"), OsString::from("0")),
            ],
            None,
        );

        assert!(
            environment.contains(&(OsString::from("NODE_USE_ENV_PROXY"), OsString::from("0"),))
        );
    }
}
