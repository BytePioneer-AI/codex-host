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
 * Decide whether the current browser device permits automatic text-input focus.
 * Bowser identifies phones and tablets from the UA; MacIntel with multiple touch points identifies desktop-mode iPads.
 * This policy does not restrict focus requested by a user gesture or keyboard navigation.
 * @returns false for identified phones and tablets; true for other devices, including unrecognized UAs.
 */
export function shouldAutoFocusTextInput(): boolean {
  const platformType = bowser.parse(navigator.userAgent).platform.type;
  const desktopIPad = navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
  return platformType !== "mobile" && platformType !== "tablet" && !desktopIPad;
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
