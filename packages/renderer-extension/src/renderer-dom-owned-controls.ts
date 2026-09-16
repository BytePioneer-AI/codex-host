/**
 * DOM attribute markers applied to controls and popovers owned by CodexHost.
 * Used by MutationObservers in probe and versioned adapter to filter out internal mutations.
 */
export const OWNED_EXTENSION_CONTROL_ATTRIBUTES = [
  "data-codexhost-agent-control",
  "data-codexhost-model-control",
  "data-codexhost-model-menu",
  "data-codexhost-permission-mode-control",
  "data-codexhost-usage-control",
  "data-codexhost-usage-popover",
  "data-codexhost-credits-control",
  "data-codexhost-credits-popover",
  "data-codexhost-harness-command-control",
  "data-codexhost-harness-command-menu",
  "data-codexhost-sidebar-agent-icon",
  "data-codexhost-settings-trigger",
  "data-codexhost-settings-shell",
] as const;

export const OWNED_CONTROL_SELECTORS = OWNED_EXTENSION_CONTROL_ATTRIBUTES.map(
  (attr) => `[${attr}]`,
).join(", ");

export function isOwnedExtensionControl(element: Element): boolean {
  if (typeof element?.hasAttribute !== "function") return false;
  for (const attr of OWNED_EXTENSION_CONTROL_ATTRIBUTES) {
    if (element.hasAttribute(attr)) return true;
  }
  return false;
}

export function isInternalExtensionMutation(mutation: MutationRecord): boolean {
  const target = mutation.target as unknown as {
    nodeType?: number;
    parentElement?: Element | null;
  };
  const targetElement =
    (typeof Element !== "undefined" && mutation.target instanceof Element) || target?.nodeType === 1
      ? (mutation.target as unknown as Element)
      : (target?.parentElement ?? null);
  if (targetElement?.closest(OWNED_CONTROL_SELECTORS)) {
    return true;
  }
  if (mutation.type === "childList") {
    const nodes = [...mutation.addedNodes, ...mutation.removedNodes];
    if (
      nodes.length > 0 &&
      nodes.every((node) => node.nodeType === 1 && isOwnedExtensionControl(node as Element))
    ) {
      return true;
    }
  }
  return false;
}
