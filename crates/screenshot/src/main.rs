#![deny(unsafe_code)]

//! One-shot Windows primary-display capture helper spawned on demand by `codexhost desktop-screenshot`.

use std::env;
use std::io::Write;
use std::process::ExitCode;

use codexhost_platform::DesktopScreenshotError;

#[cfg(target_os = "windows")]
fn capture_primary_desktop() -> Result<Vec<u8>, DesktopScreenshotError> {
    use codexhost_platform::{
        LimitedDesktopImage, check_desktop_screenshot_dimensions, select_primary_desktop_index,
    };
    use xcap::image::{ExtendedColorType, ImageEncoder, codecs::png::PngEncoder};

    windows::check_session()?;

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

#[cfg(not(target_os = "windows"))]
fn capture_primary_desktop() -> Result<Vec<u8>, DesktopScreenshotError> {
    Err(DesktopScreenshotError::Unsupported)
}

#[cfg(target_os = "windows")]
#[allow(unsafe_code)]
mod windows {
    use ::windows::Win32::{
        Foundation::HANDLE,
        System::{
            StationsAndDesktops::{
                CloseDesktop, DESKTOP_CONTROL_FLAGS, DESKTOP_READOBJECTS, GetThreadDesktop,
                GetUserObjectInformationW, HDESK, OpenInputDesktop, UOI_NAME,
            },
            Threading::GetCurrentThreadId,
        },
        UI::HiDpi::{DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, SetProcessDpiAwarenessContext},
    };
    use codexhost_platform::DesktopScreenshotError;

    /// Do not capture a stale thread desktop while the input desktop is locked or secure.
    pub(super) fn check_session() -> Result<(), DesktopScreenshotError> {
        unsafe {
            let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
            let input = OpenInputDesktop(DESKTOP_CONTROL_FLAGS(0), false, DESKTOP_READOBJECTS)
                .map_err(|_| DesktopScreenshotError::DisplayUnavailable)?;
            let result = (|| {
                let current = GetThreadDesktop(GetCurrentThreadId())
                    .map_err(|_| DesktopScreenshotError::DisplayUnavailable)?;
                let name = |desktop: HDESK| {
                    let mut buffer = [0_u16; 256];
                    let mut length = 0_u32;
                    GetUserObjectInformationW(
                        HANDLE(desktop.0),
                        UOI_NAME,
                        Some(buffer.as_mut_ptr().cast()),
                        std::mem::size_of_val(&buffer) as u32,
                        Some(&mut length),
                    )
                    .map_err(|_| DesktopScreenshotError::DisplayUnavailable)?;
                    Ok::<_, DesktopScreenshotError>(buffer)
                };
                if name(input)? != name(current)? {
                    return Err(DesktopScreenshotError::DisplayUnavailable);
                }
                Ok(())
            })();
            let _ = CloseDesktop(input);
            result
        }
    }
}

fn run(arguments: &[String]) -> Result<Vec<u8>, String> {
    if !arguments.is_empty() {
        return Err("desktop-screenshot accepts no arguments".into());
    }
    capture_primary_desktop().map_err(|error| error.to_string())
}

fn main() -> ExitCode {
    let arguments = env::args().skip(1).collect::<Vec<_>>();
    match run(&arguments) {
        Ok(image) => match std::io::stdout().lock().write_all(&image) {
            Ok(()) => ExitCode::SUCCESS,
            Err(error) => {
                eprintln!("{error}");
                ExitCode::FAILURE
            }
        },
        Err(error) => {
            eprintln!("{error}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::run;

    #[test]
    fn rejects_unexpected_arguments() {
        let error = run(&["--output".into(), "untrusted.png".into()])
            .expect_err("arguments must be rejected");
        assert!(error.contains("desktop-screenshot accepts no arguments"));
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn reports_unsupported_off_windows() {
        assert_eq!(run(&[]), Err("desktop-screenshot/unsupported".into()));
    }
}
