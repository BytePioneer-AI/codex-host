/** Focus policy and presentation for automatic entry and restoration. */
import bowser from "bowser";
const releases = new WeakMap<HTMLElement, () => void>();
const navigationKeys = new Set([
  "Tab",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
]);

/**
 * Identify phones and tablets, including desktop-mode iPads, using the shared device policy.
 * @returns true for recognized mobile devices; false for other or unrecognized devices.
 */
export function isMobileDevice(): boolean {
  const platformType = bowser.parse(navigator.userAgent).platform.type;
  const desktopIPad = navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
  return platformType === "mobile" || platformType === "tablet" || desktopIPad;
}

/**
 * Decide whether the current browser device permits automatic text-input focus.
 * This policy does not restrict focus requested by a user gesture or keyboard navigation.
 * Narrow, coarse-pointer browsers without hover also require explicit focus,
 * covering phones that report a desktop or unrecognized user agent.
 * @returns false for mobile devices and narrow touch surfaces; true for other devices.
 */
export function shouldAutoFocusTextInput(): boolean {
  if (isMobileDevice()) return false;
  return !window.matchMedia?.("(width < 640px) and (pointer: coarse) and (hover: none)").matches;
}

/**
 * Focus an automatic destination without a focus outline until keyboard navigation or blur.
 * The theme suppresses outlines while data-dsh-automatic-focus is present; borders and shadows remain intact.
 * Tab and directional navigation restore normal focus styling.
 * @param element - control or container receiving automatic focus.
 * @param options - browser focus options, including scroll preservation.
 */
export function focusWithoutRing(element: HTMLElement, options?: FocusOptions): void {
  releases.get(element)?.();
  const release = (): void => {
    element.removeAttribute("data-dsh-automatic-focus");
    element.removeEventListener("blur", release);
    element.removeEventListener("keydown", navigate, true);
    releases.delete(element);
  };
  const navigate = (event: KeyboardEvent): void => {
    if (
      !event.isComposing &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.metaKey &&
      navigationKeys.has(event.key)
    )
      release();
  };
  releases.set(element, release);
  element.setAttribute("data-dsh-automatic-focus", "");
  element.addEventListener("blur", release);
  element.addEventListener("keydown", navigate, true);
  element.focus(options);
  if (!element.matches(":focus")) release();
}
