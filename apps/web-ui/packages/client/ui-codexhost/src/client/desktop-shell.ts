export function isDesktopShell(): boolean {
  return (
    typeof window !== "undefined" &&
    (window as { __CODEXHOST_DESKTOP_SHELL__?: boolean }).__CODEXHOST_DESKTOP_SHELL__ === true
  );
}
