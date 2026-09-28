type Child = Node | string | null | undefined | false;

/** Minimal element builder; text is always set as text, never as markup. */
export function h<K extends keyof HTMLElementTagNameMap>(
  document: Document,
  tag: K,
  attributes: Record<string, string | boolean | undefined> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value === undefined || value === false) continue;
    if (name === "className") element.className = String(value);
    else element.setAttribute(name, value === true ? "" : value);
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    element.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return element;
}

export function button(
  document: Document,
  label: Child | Child[],
  onClick: () => void,
  variant: "primary" | "secondary" = "secondary",
): HTMLButtonElement {
  const element = h(document, "button", {
    type: "button",
    className:
      variant === "primary"
        ? "settings-command-button"
        : "settings-command-button settings-command-button--secondary",
  });
  element.append(
    ...(Array.isArray(label) ? label : [label]).filter((part): part is Node | string => !!part),
  );
  element.addEventListener("click", onClick);
  return element;
}

export function formatTime(ms: number | null | undefined, locale: string): string {
  return typeof ms === "number" && ms > 0 ? new Date(ms).toLocaleString(locale) : "—";
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
