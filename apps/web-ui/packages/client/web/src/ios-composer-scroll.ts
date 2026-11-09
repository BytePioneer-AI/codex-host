/**
 * iOS composer page-scroll guard.
 * @module @deepseek-ai/dsh-client-web/src/ios-composer-scroll
 */

/**
 * Detect WebKit on iPhone, iPad and desktop-mode iPad.
 * @returns true when the page runs on iOS or iPadOS.
 */
function isAppleTouchDevice(): boolean {
  return (
    /iPhone|iPad|iPod/u.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

/**
 * Stop the composer editor from scrolling the page itself on iOS. Lexical reveals the caret
 * with `window.scrollBy()` from `visualViewport` numbers, which Safari reports stale while
 * the soft keyboard is open; the extra scroll leaves the composer floating above the
 * keyboard. While focus is inside the composer, `window.scrollBy` is ignored. Safari's own
 * focus scroll and the draft's internal scrolling are unaffected.
 */
export function guardIosComposerPageScroll(): void {
  if (typeof window === "undefined" || !isAppleTouchDevice()) return;
  const original = window.scrollBy.bind(window) as (...args: unknown[]) => void;
  window.scrollBy = ((...args: unknown[]): void => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.closest("[data-composer-input]") !== null) return;
    original(...args);
  }) as typeof window.scrollBy;
}
