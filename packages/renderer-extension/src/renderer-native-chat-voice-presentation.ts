/** Preserve home layout while the native orb occupies the greeting's space. */
export function hideNativeChatVoiceHomeHeadline(doc: Document): (() => void) | undefined {
  const headlines = [
    ...doc.querySelectorAll<HTMLElement>('[style*="--vt-splash-screen-headline"]'),
  ].filter(
    (element) =>
      element.querySelector("h1 [data-headline]") &&
      element.getBoundingClientRect().width > 0 &&
      !element.closest("[hidden], [inert]"),
  );
  if (headlines.length !== 1) return;
  const headline = headlines[0];
  if (!headline) return;
  const previous = headline.style.getPropertyValue("visibility");
  const priority = headline.style.getPropertyPriority("visibility");
  headline.style.setProperty("visibility", "hidden", "important");
  return () => {
    if (
      headline.style.getPropertyValue("visibility") === "hidden" &&
      headline.style.getPropertyPriority("visibility") === "important"
    )
      headline.style.setProperty("visibility", previous, priority);
  };
}
