/** Browser-safe contract for an explicit, single primary-desktop screenshot. */
export const DESKTOP_SCREENSHOT_PATH = "/api/desktop/screenshot";
export const DESKTOP_SCREENSHOT_TIME_HEADER = "x-codexhost-captured-at";
export const DESKTOP_SCREENSHOT_ERRORS = [
  "unsupported",
  "permission-denied",
  "display-unavailable",
  "capture-failed",
  "image-too-large",
  "busy",
  "timeout",
  "unavailable",
] as const;
export type DesktopScreenshotErrorCode = (typeof DESKTOP_SCREENSHOT_ERRORS)[number];

export function isDesktopScreenshotError(value: unknown): value is DesktopScreenshotErrorCode {
  return typeof value === "string" && DESKTOP_SCREENSHOT_ERRORS.some((code) => code === value);
}
