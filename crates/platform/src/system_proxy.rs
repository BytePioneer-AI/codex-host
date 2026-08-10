use std::io::Cursor;

use plist::{Dictionary, Value};
use system_configuration::core_foundation::{
    base::TCFType,
    propertylist::{create_data, kCFPropertyListXMLFormat_v1_0},
};
use system_configuration::dynamic_store::SCDynamicStoreBuilder;

use crate::PlatformError;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SystemProxySettings {
    pub http_proxy: Option<String>,
    pub https_proxy: Option<String>,
    pub all_proxy: Option<String>,
    pub exceptions: Vec<String>,
    pub automatic_configuration: bool,
}

pub fn system_proxy_settings() -> Result<SystemProxySettings, PlatformError> {
    let store = SCDynamicStoreBuilder::new("codexhost")
        .build()
        .ok_or_else(|| {
            PlatformError::Invalid("could not open the macOS system configuration store".into())
        })?;
    let Some(proxies) = store.get_proxies() else {
        return Ok(SystemProxySettings::default());
    };
    let data =
        create_data(proxies.as_CFTypeRef(), kCFPropertyListXMLFormat_v1_0).map_err(|error| {
            PlatformError::Invalid(format!(
                "could not serialize the macOS system proxy settings: {error:?}"
            ))
        })?;
    let value = Value::from_reader_xml(Cursor::new(data.bytes())).map_err(|error| {
        PlatformError::Invalid(format!(
            "could not parse the macOS system proxy settings: {error}"
        ))
    })?;
    let dictionary = value.as_dictionary().ok_or_else(|| {
        PlatformError::Invalid("macOS returned non-dictionary system proxy settings".into())
    })?;
    Ok(settings_from_dictionary(dictionary))
}

fn settings_from_dictionary(dictionary: &Dictionary) -> SystemProxySettings {
    let automatic_configuration = enabled(dictionary, "ProxyAutoConfigEnable")
        || enabled(dictionary, "ProxyAutoDiscoveryEnable");
    let (http_proxy, https_proxy, all_proxy) = if automatic_configuration {
        (None, None, None)
    } else {
        (
            proxy_url(dictionary, "HTTP", "http"),
            proxy_url(dictionary, "HTTPS", "http"),
            proxy_url(dictionary, "SOCKS", "socks5"),
        )
    };
    let exceptions = dictionary
        .get("ExceptionsList")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_string)
        .filter_map(normalize_exception)
        .collect();
    SystemProxySettings {
        http_proxy,
        https_proxy,
        all_proxy,
        exceptions,
        automatic_configuration,
    }
}

fn enabled(dictionary: &Dictionary, key: &str) -> bool {
    dictionary
        .get(key)
        .and_then(integer)
        .is_some_and(|value| value != 0)
}

fn integer(value: &Value) -> Option<i64> {
    value.as_signed_integer().or_else(|| {
        value
            .as_unsigned_integer()
            .and_then(|value| value.try_into().ok())
    })
}

fn proxy_url(dictionary: &Dictionary, prefix: &str, scheme: &str) -> Option<String> {
    if !enabled(dictionary, &format!("{prefix}Enable")) {
        return None;
    }
    let host = dictionary
        .get(&format!("{prefix}Proxy"))?
        .as_string()?
        .trim();
    let port = integer(dictionary.get(&format!("{prefix}Port"))?)?;
    if host.is_empty() || !(1..=i64::from(u16::MAX)).contains(&port) {
        return None;
    }
    let authority = if host.contains(':') && !(host.starts_with('[') && host.ends_with(']')) {
        format!("[{host}]")
    } else {
        host.to_owned()
    };
    Some(format!("{scheme}://{authority}:{port}"))
}

fn normalize_exception(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() || value == "<local>" {
        return None;
    }
    Some(
        value
            .strip_prefix("*.")
            .map_or_else(|| value.to_owned(), |suffix| format!(".{suffix}")),
    )
}

#[cfg(test)]
mod tests {
    use plist::{Dictionary, Value};

    use super::{SystemProxySettings, settings_from_dictionary, system_proxy_settings};

    fn dictionary(entries: &[(&str, Value)]) -> Dictionary {
        entries
            .iter()
            .map(|(key, value)| ((*key).to_owned(), value.clone()))
            .collect()
    }

    #[test]
    fn reads_enabled_static_proxies_and_normalizes_exceptions() {
        let settings = settings_from_dictionary(&dictionary(&[
            ("HTTPEnable", 1_i64.into()),
            ("HTTPProxy", "127.0.0.1".into()),
            ("HTTPPort", 7897_i64.into()),
            ("HTTPSEnable", 1_i64.into()),
            ("HTTPSProxy", "proxy.example.com".into()),
            ("HTTPSPort", 8443_i64.into()),
            ("SOCKSEnable", 1_i64.into()),
            ("SOCKSProxy", "::1".into()),
            ("SOCKSPort", 1080_i64.into()),
            (
                "ExceptionsList",
                Value::Array(vec![
                    "localhost".into(),
                    "*.local".into(),
                    "10.0.0.0/8".into(),
                    "<local>".into(),
                ]),
            ),
        ]));

        assert_eq!(
            settings,
            SystemProxySettings {
                http_proxy: Some("http://127.0.0.1:7897".into()),
                https_proxy: Some("http://proxy.example.com:8443".into()),
                all_proxy: Some("socks5://[::1]:1080".into()),
                exceptions: vec!["localhost".into(), ".local".into(), "10.0.0.0/8".into()],
                automatic_configuration: false,
            }
        );
    }

    #[test]
    fn automatic_configuration_does_not_publish_stale_static_proxies() {
        let settings = settings_from_dictionary(&dictionary(&[
            ("ProxyAutoConfigEnable", 1_i64.into()),
            ("HTTPEnable", 1_i64.into()),
            ("HTTPProxy", "stale.proxy".into()),
            ("HTTPPort", 8080_i64.into()),
        ]));

        assert!(settings.automatic_configuration);
        assert!(settings.http_proxy.is_none());
        assert!(settings.https_proxy.is_none());
        assert!(settings.all_proxy.is_none());
    }

    #[test]
    fn reads_the_running_macos_system_configuration() {
        system_proxy_settings().expect("read system proxy settings");
    }
}
