import type { HarnessCommandDescriptor } from "@codexhost/shared-contracts";

import codexhostIconUrl from "./assets/codexhost-command-icon.png";

const COMMAND_ATTRIBUTE = "data-codexhost-command-id";
const COMMAND_CONTAINER_ATTRIBUTE = "data-codexhost-command-container";
const nativeMenuSelectors = [
  '[role="listbox"]',
  '[role="menu"]',
  '[role="dialog"]',
  '[data-composer-overlay-floating-ui="true"]',
  "[cmdk-list]",
  "[data-cmdk-list]",
  "[data-radix-popper-content-wrapper]",
] as const;
const nativeRowSelector = [
  '[role="option"]',
  '[role="menuitem"]',
  'button[data-list-navigation-item="true"]',
  "[cmdk-item]",
  "[data-cmdk-item]",
].join(",");

function editorText(editor: HTMLElement): string {
  if (editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement) {
    return editor.value;
  }
  return editor.textContent ?? "";
}

function replaceEditorText(editor: HTMLElement, value: string): void {
  if (editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement) {
    const prototype =
      editor instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (setter) setter.call(editor, value);
    else editor.value = value;
  } else {
    editor.focus();
    const selection = editor.ownerDocument.getSelection();
    const range = editor.ownerDocument.createRange();
    range.selectNodeContents(editor);
    selection?.removeAllRanges();
    selection?.addRange(range);
    if (!editor.ownerDocument.execCommand("insertText", false, value)) {
      editor.textContent = value;
    }
    selection?.removeAllRanges();
  }
  editor.dispatchEvent(
    new InputEvent("input", {
      bubbles: true,
      composed: true,
      inputType: "deleteContentBackward",
      data: null,
    }),
  );
}

export function matchingHarnessCommands(
  commands: readonly HarnessCommandDescriptor[],
  editorValue: string,
): HarnessCommandDescriptor[] {
  if (!editorValue.startsWith("/") || /\s/u.test(editorValue)) return [];
  const query = editorValue.toLowerCase();
  return commands.filter((command) => command.invocation.toLowerCase().startsWith(query));
}

function elementVisible(element: HTMLElement): boolean {
  if (element.hidden || element.getAttribute("aria-hidden") === "true") return false;
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  if (style?.display === "none" || style?.visibility === "hidden") return false;
  const rect = element.getBoundingClientRect();
  const view = element.ownerDocument.defaultView;
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    rect.right > 0 &&
    rect.bottom > 0 &&
    rect.left < (view?.innerWidth ?? Number.POSITIVE_INFINITY) &&
    rect.top < (view?.innerHeight ?? Number.POSITIVE_INFINITY)
  );
}

interface NativeCommandSurface {
  surface: HTMLElement;
  rowContainer: HTMLElement;
  templateRow: HTMLElement;
  score: number;
}

function rowContainerWithin(surface: HTMLElement): {
  rowContainer: HTMLElement;
  templateRow: HTMLElement;
  count: number;
} | null {
  const rows = [...surface.querySelectorAll<HTMLElement>(nativeRowSelector)].filter(
    (row) =>
      !row.hasAttribute(COMMAND_ATTRIBUTE) &&
      !row.closest(`[${COMMAND_CONTAINER_ATTRIBUTE}]`) &&
      elementVisible(row),
  );
  const byParent = new Map<HTMLElement, HTMLElement[]>();
  for (const row of rows) {
    const parent = row.parentElement;
    if (!parent) continue;
    const siblings = byParent.get(parent) ?? [];
    siblings.push(row);
    byParent.set(parent, siblings);
  }
  const candidate = [...byParent.entries()].toSorted(
    (left, right) => right[1].length - left[1].length,
  )[0];
  const templateRow = candidate?.[1][0];
  return candidate && templateRow && candidate[1].length >= 2
    ? { rowContainer: candidate[0], templateRow, count: candidate[1].length }
    : null;
}

function nativeCommandSurface(
  ownerDocument: Document,
  editor: HTMLElement,
): NativeCommandSurface | null {
  const editorRect = editor.getBoundingClientRect();
  const surfaces = new Set<HTMLElement>();
  for (const selector of nativeMenuSelectors) {
    for (const element of ownerDocument.querySelectorAll<HTMLElement>(selector)) {
      if (!element.closest(`[${COMMAND_CONTAINER_ATTRIBUTE}]`)) surfaces.add(element);
    }
  }
  const candidates: NativeCommandSurface[] = [];
  for (const surface of surfaces) {
    if (!elementVisible(surface) || surface.contains(editor)) continue;
    const rows = rowContainerWithin(surface);
    if (!rows) continue;
    const rect = surface.getBoundingClientRect();
    const opensAbove = rect.bottom <= editorRect.top + 40;
    const opensBelow = rect.top >= editorRect.bottom - 40;
    const verticalDistance = opensAbove
      ? editorRect.top - rect.bottom
      : opensBelow
        ? rect.top - editorRect.bottom
        : Number.POSITIVE_INFINITY;
    const horizontalOverlap = Math.max(
      0,
      Math.min(rect.right, editorRect.right) - Math.max(rect.left, editorRect.left),
    );
    if (horizontalOverlap === 0 || verticalDistance > Math.max(160, editorRect.height * 3))
      continue;
    candidates.push({
      surface,
      rowContainer: rows.rowContainer,
      templateRow: rows.templateRow,
      score: rows.count * 100 + horizontalOverlap - verticalDistance,
    });
  }
  return candidates.toSorted((left, right) => right.score - left.score)[0] ?? null;
}

function copyNativeRowAttributes(source: HTMLElement, target: HTMLElement): void {
  target.className = source.className;
  const role = source.getAttribute("role");
  if (role) target.setAttribute("role", role);
  for (const name of ["data-orientation", "data-variant"]) {
    const value = source.getAttribute(name);
    if (value !== null) target.setAttribute(name, value);
  }
  target.tabIndex = -1;
}

function commandItem(
  ownerDocument: Document,
  templateRow: HTMLElement,
  command: HarnessCommandDescriptor,
  select: () => void,
): HTMLElement {
  const item = ownerDocument.createElement(templateRow.tagName.toLowerCase());
  copyNativeRowAttributes(templateRow, item);
  item.setAttribute(COMMAND_ATTRIBUTE, command.id);
  item.setAttribute("aria-label", `${command.invocation} ${command.label}`);
  if (item instanceof HTMLButtonElement) item.type = "button";
  item.style.display = "flex";
  item.style.alignItems = "center";
  item.style.width = "100%";
  item.style.gap = "10px";

  const icon = ownerDocument.createElement("img");
  icon.src = codexhostIconUrl;
  icon.alt = "";
  icon.width = 20;
  icon.height = 20;
  icon.draggable = false;
  icon.setAttribute("aria-hidden", "true");
  icon.style.width = "20px";
  icon.style.height = "20px";
  icon.style.flex = "0 0 20px";
  icon.style.objectFit = "contain";

  const invocation = ownerDocument.createElement("span");
  invocation.textContent = command.invocation;
  invocation.style.flex = "0 0 auto";
  invocation.style.fontFamily = "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";

  const label = ownerDocument.createElement("span");
  label.textContent = command.label;
  label.style.flex = "0 0 auto";

  const description = ownerDocument.createElement("span");
  description.textContent = command.description ?? "";
  description.style.minWidth = "0";
  description.style.marginLeft = "auto";
  description.style.overflow = "hidden";
  description.style.textOverflow = "ellipsis";
  description.style.whiteSpace = "nowrap";
  description.style.opacity = "0.58";

  item.append(icon, invocation, label, description);
  item.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  item.addEventListener("mousedown", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  item.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    select();
  });
  return item;
}

export interface RendererCommandPickerControl {
  root: HTMLElement;
  setCommands(commands: readonly HarnessCommandDescriptor[]): void;
  dispose(): void;
}

export function mountRendererCommandPicker(
  composer: Element,
  editor: HTMLElement,
  onCommandSelected: (command: HarnessCommandDescriptor) => void,
): RendererCommandPickerControl {
  const ownerDocument = composer.ownerDocument;
  const root = ownerDocument.createElement("span");
  root.hidden = true;
  root.dataset.codexhostCommandPicker = "true";
  composer.append(root);

  let commands: readonly HarnessCommandDescriptor[] = [];
  let disposed = false;
  let reconcileScheduled = false;
  let injectedContainer: HTMLElement | null = null;
  let reservedRowContainer: HTMLElement | null = null;
  let originalRowContainerPaddingTop: string | null = null;

  const restoreNativeLayout = (): void => {
    if (reservedRowContainer && originalRowContainerPaddingTop !== null) {
      reservedRowContainer.style.paddingTop = originalRowContainerPaddingTop;
    }
    reservedRowContainer = null;
    originalRowContainerPaddingTop = null;
  };

  const removeInjected = (): void => {
    restoreNativeLayout();
    injectedContainer?.remove();
    injectedContainer = null;
  };

  const positionInjectedContainer = (
    container: HTMLElement,
    native: NativeCommandSurface,
  ): void => {
    const rowRect = native.templateRow.getBoundingClientRect();
    const surfaceStyle = ownerDocument.defaultView?.getComputedStyle(native.surface);
    container.style.position = "fixed";
    container.style.left = `${rowRect.left}px`;
    container.style.top = `${rowRect.top}px`;
    container.style.width = `${rowRect.width}px`;
    container.style.zIndex =
      surfaceStyle?.zIndex === "auto"
        ? "2147483646"
        : (surfaceStyle?.zIndex ?? "2147483646");
    container.style.display = "flex";
    container.style.flexDirection = "column";
    container.style.pointerEvents = "auto";
    container.style.backgroundColor = surfaceStyle?.backgroundColor ?? "Canvas";
    container.style.borderRadius = "0.5rem";
  };

  const reserveNativeLayout = (native: NativeCommandSurface, height: number): void => {
    restoreNativeLayout();
    reservedRowContainer = native.rowContainer;
    originalRowContainerPaddingTop = native.rowContainer.style.paddingTop;
    const computedPaddingTop = ownerDocument.defaultView?.getComputedStyle(
      native.rowContainer,
    ).paddingTop;
    native.rowContainer.style.paddingTop = `calc(${computedPaddingTop ?? "0px"} + ${height}px)`;
  };

  const reconcile = (): void => {
    reconcileScheduled = false;
    if (disposed) return;
    const matching = matchingHarnessCommands(commands, editorText(editor));
    if (matching.length === 0 || ownerDocument.activeElement !== editor) {
      removeInjected();
      return;
    }
    const native = nativeCommandSurface(ownerDocument, editor);
    if (!native) {
      removeInjected();
      return;
    }
    if (
      injectedContainer?.parentElement === ownerDocument.body &&
      matching.every((command) =>
        injectedContainer?.querySelector(`[${COMMAND_ATTRIBUTE}="${CSS.escape(command.id)}"]`),
      )
    ) {
      restoreNativeLayout();
      positionInjectedContainer(injectedContainer, native);
      reserveNativeLayout(native, injectedContainer.getBoundingClientRect().height);
      return;
    }
    removeInjected();
    // Keep foreign nodes out of the React-owned list. React can otherwise
    // reconcile around our child and crash the Desktop renderer.
    const container = ownerDocument.createElement("div");
    container.setAttribute(COMMAND_CONTAINER_ATTRIBUTE, "true");
    for (const command of matching) {
      container.append(
        commandItem(ownerDocument, native.templateRow, command, () => {
          replaceEditorText(editor, "");
          removeInjected();
          onCommandSelected(command);
          editor.focus();
        }),
      );
    }
    ownerDocument.body.append(container);
    positionInjectedContainer(container, native);
    reserveNativeLayout(native, container.getBoundingClientRect().height);
    injectedContainer = container;
  };

  const scheduleReconcile = (): void => {
    if (disposed || reconcileScheduled) return;
    reconcileScheduled = true;
    queueMicrotask(reconcile);
  };
  const onInput = (): void => scheduleReconcile();
  const onFocus = (): void => scheduleReconcile();
  const onBlur = (): void => {
    ownerDocument.defaultView?.setTimeout(scheduleReconcile, 0);
  };
  const onViewportChange = (): void => scheduleReconcile();
  const observer = new MutationObserver(() => scheduleReconcile());
  observer.observe(ownerDocument.body ?? ownerDocument.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["hidden", "aria-hidden", "data-state"],
  });
  editor.addEventListener("input", onInput);
  editor.addEventListener("focus", onFocus);
  editor.addEventListener("blur", onBlur);
  ownerDocument.defaultView?.addEventListener("resize", onViewportChange);
  ownerDocument.defaultView?.addEventListener("scroll", onViewportChange, true);

  return {
    root,
    setCommands(nextCommands) {
      commands = [...nextCommands];
      scheduleReconcile();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      observer.disconnect();
      editor.removeEventListener("input", onInput);
      editor.removeEventListener("focus", onFocus);
      editor.removeEventListener("blur", onBlur);
      ownerDocument.defaultView?.removeEventListener("resize", onViewportChange);
      ownerDocument.defaultView?.removeEventListener("scroll", onViewportChange, true);
      removeInjected();
      root.remove();
    },
  };
}
