import { decodeHarnessPluginRoute } from "@codexhost/shared-contracts";

export function isNativeModelCarrierLoadingButton(button: HTMLButtonElement): boolean {
  if (
    !button.disabled ||
    button.getAttribute("data-composer-navigation-target") !== "reasoning" ||
    button.getAttribute("aria-busy") !== "true" ||
    button.hasAttribute("aria-haspopup")
  )
    return false;

  // Desktop renders the Model label as the span's first text node, followed by optional Thinking.
  for (const label of button.children) {
    const text = label.firstChild;
    if (label.localName !== "span" || text?.nodeName !== "#text") continue;
    try {
      if (decodeHarnessPluginRoute(text.nodeValue)) return true;
    } catch {
      // Malformed labels are not route carriers.
    }
  }
  return false;
}
