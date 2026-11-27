//! One explicitly requested primary-display image, without input control or persistent files.
//!
//! macOS captures in-process so TCC Screen Recording permission stays attached to the signed
//! launcher bundle. Windows captures in the dedicated `codexhost-screenshot` helper binary.

use std::fmt;
use std::io::{self, Write};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DesktopScreenshotError {
    Unsupported,
    PermissionDenied,
    DisplayUnavailable,
    CaptureFailed,
    ImageTooLarge,
}

impl fmt::Display for DesktopScreenshotError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let code = match self {
            Self::Unsupported => "unsupported",
            Self::PermissionDenied => "permission-denied",
            Self::DisplayUnavailable => "display-unavailable",
            Self::CaptureFailed => "capture-failed",
            Self::ImageTooLarge => "image-too-large",
        };
        write!(formatter, "desktop-screenshot/{code}")
    }
}

impl std::error::Error for DesktopScreenshotError {}

/// Capture only the primary display. Callers own timeout and concurrent-request limits.
#[cfg(target_os = "macos")]
pub fn capture_primary_desktop() -> Result<Vec<u8>, DesktopScreenshotError> {
    use xcap::image::{ExtendedColorType, ImageEncoder, codecs::png::PngEncoder};

    macos_capture_permission(
        objc2_core_graphics::CGPreflightScreenCaptureAccess(),
        || objc2_core_graphics::CGRequestScreenCaptureAccess(),
        || {
            let _ = super::open_external_url(
                "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
            );
        },
    )?;

    let monitors = xcap::Monitor::all().map_err(|_| DesktopScreenshotError::DisplayUnavailable)?;
    let index = select_primary_desktop_index(monitors.iter().map(|monitor| {
        monitor
            .is_primary()
            .map_err(|_| DesktopScreenshotError::DisplayUnavailable)
    }))?;
    let monitor = &monitors[index];
    check_desktop_screenshot_dimensions(
        monitor
            .width()
            .map_err(|_| DesktopScreenshotError::CaptureFailed)?,
        monitor
            .height()
            .map_err(|_| DesktopScreenshotError::CaptureFailed)?,
    )?;
    let image = monitor
        .capture_image()
        .map_err(|_| DesktopScreenshotError::CaptureFailed)?;
    check_desktop_screenshot_dimensions(image.width(), image.height())?;
    let mut output = LimitedDesktopImage::new();
    PngEncoder::new(&mut output)
        .write_image(
            image.as_raw(),
            image.width(),
            image.height(),
            ExtendedColorType::Rgba8,
        )
        .map_err(|_| DesktopScreenshotError::ImageTooLarge)?;
    Ok(output.into_inner())
}

#[cfg(not(target_os = "macos"))]
pub fn capture_primary_desktop() -> Result<Vec<u8>, DesktopScreenshotError> {
    Err(DesktopScreenshotError::Unsupported)
}

#[cfg(any(target_os = "macos", test))]
fn macos_capture_permission(
    granted: bool,
    request: impl FnOnce() -> bool,
    open_settings: impl FnOnce(),
) -> Result<(), DesktopScreenshotError> {
    if granted || request() {
        return Ok(());
    }
    // macOS may suppress the permission prompt; opening settings does not grant access.
    open_settings();
    Err(DesktopScreenshotError::PermissionDenied)
}

pub fn select_primary_desktop_index(
    flags: impl IntoIterator<Item = Result<bool, DesktopScreenshotError>>,
) -> Result<usize, DesktopScreenshotError> {
    let mut primary = None;
    for (index, flag) in flags.into_iter().enumerate() {
        if flag? {
            if primary.is_some() {
                return Err(DesktopScreenshotError::DisplayUnavailable);
            }
            primary = Some(index);
        }
    }
    primary.ok_or(DesktopScreenshotError::DisplayUnavailable)
}

pub fn check_desktop_screenshot_dimensions(
    width: u32,
    height: u32,
) -> Result<(), DesktopScreenshotError> {
    if width == 0 || height == 0 {
        return Err(DesktopScreenshotError::CaptureFailed);
    }
    if u64::from(width) * u64::from(height) > 64_000_000 {
        return Err(DesktopScreenshotError::ImageTooLarge);
    }
    Ok(())
}

// Matches the Web image limit; encoding aborts before growing an oversized output buffer.
pub const MAX_DESKTOP_SCREENSHOT_BYTES: usize = 50 * 1024 * 1024;

#[derive(Default)]
pub struct LimitedDesktopImage(Vec<u8>);

impl LimitedDesktopImage {
    #[must_use]
    pub fn new() -> Self {
        Self(Vec::new())
    }

    #[must_use]
    pub fn into_inner(self) -> Vec<u8> {
        self.0
    }
}

impl Write for LimitedDesktopImage {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() > MAX_DESKTOP_SCREENSHOT_BYTES.saturating_sub(self.0.len()) {
            return Err(io::Error::other("desktop image exceeds its byte limit"));
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn macos_permission_requests_once_and_opens_settings_only_when_still_denied() {
        for (granted, request_grants) in [(true, false), (false, true), (false, false)] {
            let mut requested = false;
            let mut opened = false;
            let result = macos_capture_permission(
                granted,
                || {
                    requested = true;
                    request_grants
                },
                || opened = true,
            );
            assert_eq!(requested, !granted);
            assert_eq!(opened, !granted && !request_grants);
            assert_eq!(
                result,
                if granted || request_grants {
                    Ok(())
                } else {
                    Err(DesktopScreenshotError::PermissionDenied)
                }
            );
        }
    }

    #[test]
    fn primary_selection_never_falls_back_to_an_arbitrary_monitor() {
        assert_eq!(select_primary_desktop_index([Ok(false), Ok(true)]), Ok(1));
        for flags in [vec![], vec![Ok(false)], vec![Ok(true), Ok(true)]] {
            assert_eq!(
                select_primary_desktop_index(flags),
                Err(DesktopScreenshotError::DisplayUnavailable)
            );
        }
        assert_eq!(
            select_primary_desktop_index([
                Ok(true),
                Err(DesktopScreenshotError::DisplayUnavailable)
            ]),
            Err(DesktopScreenshotError::DisplayUnavailable)
        );
    }

    #[test]
    fn image_limits_bound_dimensions_and_encoded_bytes() {
        assert!(check_desktop_screenshot_dimensions(3840, 2160).is_ok());
        assert_eq!(
            check_desktop_screenshot_dimensions(0, 100),
            Err(DesktopScreenshotError::CaptureFailed)
        );
        assert!(check_desktop_screenshot_dimensions(9000, 100).is_ok());
        assert_eq!(
            check_desktop_screenshot_dimensions(8192, 8192),
            Err(DesktopScreenshotError::ImageTooLarge)
        );
        let mut output = LimitedDesktopImage(vec![0; MAX_DESKTOP_SCREENSHOT_BYTES - 1]);
        assert!(output.write_all(&[1]).is_ok());
        assert!(output.write_all(&[2]).is_err());
        assert_eq!(output.into_inner().len(), MAX_DESKTOP_SCREENSHOT_BYTES);
    }

    #[test]
    fn errors_have_stable_codes_without_native_diagnostics() {
        assert_eq!(
            DesktopScreenshotError::PermissionDenied.to_string(),
            "desktop-screenshot/permission-denied"
        );
        assert_eq!(
            DesktopScreenshotError::Unsupported.to_string(),
            "desktop-screenshot/unsupported"
        );
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn non_macos_in_process_capture_is_unsupported() {
        assert_eq!(
            capture_primary_desktop(),
            Err(DesktopScreenshotError::Unsupported)
        );
    }
}
