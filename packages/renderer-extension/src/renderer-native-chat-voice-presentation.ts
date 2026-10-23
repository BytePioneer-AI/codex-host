/** Match native voice's gap-2 action row without doubling an existing flex gap. */
export function alignNativeChatVoiceButton(
  button: HTMLButtonElement,
  send: HTMLButtonElement,
  doc: Document,
): void {
  const parent = send.parentElement;
  if (!parent) return;
  const layout = doc.defaultView?.getComputedStyle(parent);
  const gap =
    layout && /flex|grid/.test(layout.display) ? Number.parseFloat(layout.columnGap) || 0 : 0;
  const margin = `max(0px, calc(var(--spacing, 0.25rem) * 2 - ${gap}px))`;
  if (button.style.marginInlineEnd !== margin) button.style.marginInlineEnd = margin;
  if (button.style.alignSelf !== "center") button.style.alignSelf = "center";
}

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
