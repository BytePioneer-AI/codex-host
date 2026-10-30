import type { HarnessCommandCatalog, HarnessCommandDescriptor } from "@codexhost/shared-contracts";

import { rendererHarnessMessages } from "./renderer-harness-localization.js";
import type { RendererSettingsLocale } from "./settings/localization.js";

/**
 * Composer entry for the `#` menu of the active external Harness.
 *
 * The button no longer owns a command popover: commands, skills and delegation
 * targets all live in the `#` menu. Clicking it types `#` into the Composer so
 * the feature stays discoverable, and the control keeps the Harness command
 * catalog that the `#` menu reads.
 */
const CONTROL_ATTRIBUTE = "data-codexhost-harness-command-control";
const SVG_NS = "http://www.w3.org/2000/svg";
const COMMAND_ICON_PATHS = [
  "M409.6 377.6h204.8a32 32 0 0 1 32 32v204.8a32 32 0 0 1-32 32H409.6a32 32 0 0 1-32-32V409.6a32 32 0 0 1 32-32z m172.8 64h-140.8v140.8h140.8z",
  "M332.8 800a108.8 108.8 0 0 1 0-217.6h76.8a32 32 0 0 1 32 32v76.8a108.928 108.928 0 0 1-108.8 108.8z m0-153.6a44.8 44.8 0 1 0 44.8 44.8v-44.8zM409.6 441.6H332.8a108.8 108.8 0 1 1 108.8-108.8v76.8a32 32 0 0 1-32 32z m-76.8-153.6a44.8 44.8 0 0 0 0 89.6h44.8V332.8A44.842667 44.842667 0 0 0 332.8 288zM691.2 441.6h-76.8a32 32 0 0 1-32-32V332.8a108.8 108.8 0 1 1 108.8 108.8z m-44.8-64h44.8a44.8 44.8 0 1 0-44.8-44.8zM691.2 800a108.928 108.928 0 0 1-108.8-108.8v-76.8a32 32 0 0 1 32-32h76.8a108.8 108.8 0 0 1 0 217.6z m-44.8-153.6v44.8a44.8 44.8 0 1 0 44.8-44.8z",
  "M640 970.666667H384c-118.186667 0-198.272-25.002667-251.946667-78.72S53.333333 758.186667 53.333333 640V384c0-118.186667 25.002667-198.272 78.72-251.946667S265.813333 53.333333 384 53.333333h256c118.186667 0 198.272 25.002667 251.946667 78.72S970.666667 265.813333 970.666667 384v256c0 118.186667-25.002667 198.272-78.72 251.946667S758.186667 970.666667 640 970.666667z m-256-853.333334c-100.096 0-165.802667 19.2-206.72 59.946667S117.333333 283.904 117.333333 384v256c0 100.096 19.072 165.802667 59.946667 206.72S283.904 906.666667 384 906.666667h256c100.096 0 165.802667-19.072 206.72-59.946667S906.666667 740.096 906.666667 640V384c0-100.096-19.072-165.802667-59.946667-206.72S740.096 117.333333 640 117.333333z",
];

export function createHarnessCommandIcon(ownerDocument: Document): SVGSVGElement {
  const svg = ownerDocument.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 1024 1024");
  svg.setAttribute("width", "15");
  svg.setAttribute("height", "15");
  svg.setAttribute("fill", "currentColor");
  svg.setAttribute("aria-hidden", "true");
  for (const path of COMMAND_ICON_PATHS) {
    const element = ownerDocument.createElementNS(SVG_NS, "path");
    element.setAttribute("d", path);
    svg.append(element);
  }
  return svg;
}

export interface RendererHarnessCommandSnapshot {
  commands: readonly HarnessCommandDescriptor[];
  hasSession: boolean;
  executingCommandId: string | null;
  /** Host catalog source; `static` means live commands exist but are not loaded yet. */
  source: HarnessCommandCatalog["source"];
}

export interface RendererHarnessCommandControl {
  root: HTMLElement;
  trigger: HTMLButtonElement;
  setCommands(
    commands: readonly HarnessCommandDescriptor[],
    hasSession?: boolean,
    source?: HarnessCommandCatalog["source"],
  ): void;
  /** Current catalog state, read by the `#` Composer menu. */
  snapshot(): RendererHarnessCommandSnapshot;
  setExecuting(commandId: string | null): void;
  setLocale(locale: RendererSettingsLocale): void;
  placeBefore(reference: Element | null): boolean;
  dispose(): void;
}

function styleButton(button: HTMLButtonElement): void {
  Object.assign(button.style, {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "28px",
    height: "28px",
    padding: "0",
    border: "0",
    borderRadius: "8px",
    background: "transparent",
    color: "inherit",
    cursor: "pointer",
  } satisfies Partial<CSSStyleDeclaration>);
}

export function mountRendererHarnessCommandControl(
  parent: Element,
  insertBefore: Element | null,
  onOpenMenu: () => void,
  initialLocale: RendererSettingsLocale = "en",
): RendererHarnessCommandControl {
  const ownerDocument = parent.ownerDocument;
  let messages = rendererHarnessMessages(initialLocale);
  let locale = initialLocale;
  const root = ownerDocument.createElement("div");
  root.setAttribute(CONTROL_ATTRIBUTE, "true");
  root.style.display = "inline-flex";
  root.style.alignItems = "center";
  root.style.minWidth = "0";

  const trigger = ownerDocument.createElement("button");
  trigger.type = "button";
  styleButton(trigger);
  trigger.append(createHarnessCommandIcon(ownerDocument));
  root.append(trigger);

  let commands: readonly HarnessCommandDescriptor[] = [];
  let hasSession = true;
  let source: HarnessCommandCatalog["source"];
  let executingCommandId: string | null = null;
  let hovered = false;

  const syncTrigger = (): void => {
    trigger.setAttribute("aria-label", messages.commandMenuHint);
    trigger.title = messages.commandMenuHint;
    trigger.style.background = hovered ? "rgba(127, 127, 127, 0.16)" : "transparent";
  };
  // Keep editor focus and selection so `#` lands at the caret.
  const onMouseDown = (event: MouseEvent): void => event.preventDefault();
  const onClick = (): void => onOpenMenu();
  const onEnter = (): void => {
    hovered = true;
    syncTrigger();
  };
  const onLeave = (): void => {
    hovered = false;
    syncTrigger();
  };
  trigger.addEventListener("mousedown", onMouseDown);
  trigger.addEventListener("click", onClick);
  trigger.addEventListener("pointerenter", onEnter);
  trigger.addEventListener("pointerleave", onLeave);

  if (insertBefore?.parentElement === parent) parent.insertBefore(root, insertBefore);
  else parent.append(root);
  syncTrigger();

  return {
    root,
    trigger,
    placeBefore(reference) {
      if (!reference?.parentElement) return false;
      if (root.parentElement === reference.parentElement && root.nextElementSibling === reference) {
        return true;
      }
      reference.parentElement.insertBefore(root, reference);
      return true;
    },
    setCommands(nextCommands, nextHasSession = true, nextSource) {
      commands = [...nextCommands];
      hasSession = nextHasSession;
      source = nextSource;
    },
    snapshot() {
      return { commands, hasSession, executingCommandId, source };
    },
    setExecuting(commandId) {
      executingCommandId = commandId;
    },
    setLocale(nextLocale) {
      if (locale === nextLocale) return;
      locale = nextLocale;
      messages = rendererHarnessMessages(locale);
      syncTrigger();
    },
    dispose() {
      trigger.removeEventListener("mousedown", onMouseDown);
      trigger.removeEventListener("click", onClick);
      trigger.removeEventListener("pointerenter", onEnter);
      trigger.removeEventListener("pointerleave", onLeave);
      root.remove();
    },
  };
}
