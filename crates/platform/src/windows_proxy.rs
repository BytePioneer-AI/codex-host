use windows::Win32::Foundation::{GlobalFree, HGLOBAL};
use windows::Win32::Networking::WinHttp::{
    WINHTTP_CURRENT_USER_IE_PROXY_CONFIG, WinHttpGetIEProxyConfigForCurrentUser,
};

use crate::proxy_environment::ProxySettings;

struct OwnedProxyConfig(WINHTTP_CURRENT_USER_IE_PROXY_CONFIG);

impl Drop for OwnedProxyConfig {
    fn drop(&mut self) {
        for value in [
            self.0.lpszProxy,
            self.0.lpszProxyBypass,
            self.0.lpszAutoConfigUrl,
        ] {
            if !value.is_null() {
                // WinHTTP allocates each returned string with GlobalAlloc.
                unsafe {
                    let _ = GlobalFree(Some(HGLOBAL(value.0.cast())));
                }
            }
        }
    }
}

pub(crate) fn static_proxy_settings() -> windows::core::Result<Option<ProxySettings>> {
    let mut config = OwnedProxyConfig(WINHTTP_CURRENT_USER_IE_PROXY_CONFIG::default());
    // Read the current user's configuration; this never changes Windows settings.
    unsafe {
        WinHttpGetIEProxyConfigForCurrentUser(&mut config.0)?;
    }
    if config.0.fAutoDetect.as_bool() || !config.0.lpszAutoConfigUrl.is_null() {
        // PAC/WPAD requires per-URL evaluation. Do not approximate it as a global proxy.
        return Ok(None);
    }
    if config.0.lpszProxy.is_null() {
        return Ok(None);
    }
    // Pointers are owned by config and remain valid until its Drop.
    let proxy = unsafe { config.0.lpszProxy.to_string()? };
    let bypass = if config.0.lpszProxyBypass.is_null() {
        String::new()
    } else {
        unsafe { config.0.lpszProxyBypass.to_string()? }
    };
    Ok(Some(parse_static_proxy(&proxy, &bypass)))
}

fn parse_static_proxy(proxy: &str, bypass: &str) -> ProxySettings {
    let mut settings = ProxySettings::default();
    for entry in proxy
        .split(';')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
    {
        let (protocol, address) = entry
            .split_once('=')
            .map_or((None, entry), |(protocol, address)| {
                (Some(protocol.trim().to_ascii_lowercase()), address.trim())
            });
        if address.is_empty() || address.chars().any(char::is_whitespace) {
            continue;
        }
        let scheme = if protocol.as_deref() == Some("socks") {
            "socks5"
        } else {
            "http"
        };
        let url = if address.contains("://") {
            address.to_owned()
        } else {
            format!("{scheme}://{address}")
        };
        match protocol.as_deref() {
            None => {
                settings.http_proxy = Some(url.clone());
                settings.https_proxy = Some(url);
            }
            Some("http") => settings.http_proxy = Some(url),
            Some("https") => settings.https_proxy = Some(url),
            Some("socks") => settings.all_proxy = Some(url),
            _ => {}
        }
    }
    settings.exceptions = bypass
        .split(';')
        .map(str::trim)
        .filter(|value| !value.is_empty() && !value.eq_ignore_ascii_case("<local>"))
        .map(|value| {
            value
                .strip_prefix("*.")
                .map_or_else(|| value.to_owned(), |suffix| format!(".{suffix}"))
        })
        .collect();
    settings
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_protocol_specific_proxies_and_bypasses() {
        let settings = parse_static_proxy(
            "http=127.0.0.1:3128;https=[::1]:8443;socks=proxy:1080;ftp=ignored:21",
            "localhost;*.example.test;<local>;;10.0.0.0/8",
        );
        assert_eq!(
            settings.http_proxy.as_deref(),
            Some("http://127.0.0.1:3128")
        );
        assert_eq!(settings.https_proxy.as_deref(), Some("http://[::1]:8443"));
        assert_eq!(settings.all_proxy.as_deref(), Some("socks5://proxy:1080"));
        assert_eq!(
            settings.exceptions,
            ["localhost", ".example.test", "10.0.0.0/8"]
        );
    }

    #[test]
    fn supports_single_proxy_without_inventing_disabled_values() {
        let settings = parse_static_proxy("https://proxy.example:443", "");
        assert_eq!(settings.http_proxy, settings.https_proxy);
        assert_eq!(
            settings.http_proxy.as_deref(),
            Some("https://proxy.example:443")
        );
        assert!(settings.all_proxy.is_none());
        assert_eq!(
            parse_static_proxy("http=;https=bad address;ftp=ignored", ""),
            ProxySettings::default()
        );
    }
}
