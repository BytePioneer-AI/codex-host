/**
 * iOS/iPadOS focus-zoom guard for the page viewport.
 * @module @deepseek-ai/dsh-client-web/src/ios-focus-zoom
 */

/**
 * Detect WebKit on iPhone, iPad and desktop-mode iPad. Every iOS browser uses
 * WebKit, so this covers Safari and third-party browsers alike.
 * @returns true when the page runs on iOS or iPadOS.
 */
function isAppleTouchDevice(): boolean {
  return (
    /iPhone|iPad|iPod/u.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

/**
 * Keep iOS from zooming the page when an editable element below 16px gains
 * focus. WebKit never zooms back out, and the tab restores that scale when it
 * is reopened. `maximum-scale=1` only suppresses the automatic zoom on iOS:
 * Safari still honors user pinch zoom. Other platforms keep the viewport
 * unchanged because the same token would block pinch zoom there.
 */
export function preventIosFocusZoom(): void {
  if (typeof document === "undefined" || !isAppleTouchDevice()) return;
  const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  if (meta === null || /maximum-scale/u.test(meta.content)) return;
  meta.content = `${meta.content}, maximum-scale=1`;
}
