const NATIVE_BACK_SELECTOR = '[data-app-shell-titlebar] button[aria-label="Back"]';
const SETTINGS_BACK_ATTRIBUTE = "data-codexhost-settings-back";

/** Settings has a Back action even when the covered native page has no history. */
export function attachSettingsBackNavigation(
  ownerDocument: Document,
  onBack: () => void,
): { dispose(): void } {
  const ownerWindow = ownerDocument.defaultView;
  let source: HTMLButtonElement | null = null;
  let button: HTMLButtonElement | null = null;
  let disposed = false;

  const onClick = (event: MouseEvent): void => {
    event.preventDefault();
    event.stopPropagation();
    onBack();
  };
  const place = (): void => {
    if (disposed) return;
    const nextSource =
      [...ownerDocument.querySelectorAll<HTMLButtonElement>(NATIVE_BACK_SELECTOR)].find(
        (candidate) => {
          const bounds = candidate.getBoundingClientRect();
          const parent = candidate.parentElement;
          return (
            bounds.width > 0 &&
            bounds.height > 0 &&
            !candidate.closest('[aria-hidden="true"]') &&
            parent !== null &&
            ownerWindow?.getComputedStyle(parent).visibility !== "hidden"
          );
        },
      ) ?? null;
    if (nextSource !== source) {
      button?.removeEventListener("click", onClick);
      button?.remove();
      source = nextSource;
      button = source?.cloneNode(true) as HTMLButtonElement | null;
      if (button) {
        // Copy native styling and its localized label, without native disabled state
        // or React handlers. The original control remains owned by Desktop.
        for (const element of [button, ...button.querySelectorAll("[id]")]) {
          element.removeAttribute("id");
        }
        for (const attribute of [
          "disabled",
          "aria-disabled",
          "data-disabled",
          "tabindex",
          "aria-describedby",
        ]) {
          button.removeAttribute(attribute);
        }
        button.setAttribute(SETTINGS_BACK_ATTRIBUTE, "");
        button.title = source?.getAttribute("aria-label") ?? "Back";
        button.style.position = "fixed";
        button.style.zIndex = "41";
        button.style.margin = "0";
        button.style.setProperty("-webkit-app-region", "no-drag");
        button.addEventListener("click", onClick);
        ownerDocument.body.append(button);
      }
    }
    if (!source || !button) return;
    const bounds = source.getBoundingClientRect();
    Object.assign(button.style, {
      left: `${bounds.left}px`,
      top: `${bounds.top}px`,
      width: `${bounds.width}px`,
      height: `${bounds.height}px`,
    });
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || event.shiftKey) return;
    const macBack = event.metaKey && !event.ctrlKey && !event.altKey && event.key === "[";
    const altBack = event.altKey && !event.metaKey && !event.ctrlKey && event.key === "ArrowLeft";
    if (!macBack && !altBack) return;
    event.preventDefault();
    event.stopPropagation();
    onBack();
  };

  const style = ownerDocument.createElement("style");
  // Visibility preserves geometry but removes the covered control from hit
  // testing and the accessibility tree.
  style.textContent = `${NATIVE_BACK_SELECTOR} { visibility: hidden !important; }`;
  ownerDocument.head.append(style);
  place();
  const observer = ownerWindow
    ? new ownerWindow.MutationObserver((records) => {
        const titlebar = source?.closest("[data-app-shell-titlebar]");
        if (!source?.isConnected || records.some((record) => titlebar?.contains(record.target))) {
          place();
        }
      })
    : null;
  observer?.observe(ownerDocument.body, { childList: true, subtree: true });
  ownerWindow?.addEventListener("resize", place);
  ownerDocument.addEventListener("keydown", onKeyDown, true);

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      observer?.disconnect();
      ownerWindow?.removeEventListener("resize", place);
      ownerDocument.removeEventListener("keydown", onKeyDown, true);
      button?.removeEventListener("click", onClick);
      button?.remove();
      style.remove();
    },
  };
}
