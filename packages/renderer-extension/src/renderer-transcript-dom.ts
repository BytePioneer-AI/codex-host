import { REASONING_TRANSCRIPT_COMMAND } from "@codexhost/shared-contracts";
import { committedReactAncestors } from "@codexhost/desktop-control/renderer-bindings";

export const TRANSCRIPT_ITEM_SELECTOR = "[data-local-conversation-item-target-ids]";
export const TRANSCRIPT_ITEM_IDS_ATTRIBUTE = "data-local-conversation-item-target-ids";
export const TRANSCRIPT_TEXT_BODY_SELECTOR = '[data-testid="exec-shell-body"]';
export const REASONING_SOFT_WRAP_STORAGE_KEY = "codexhost.reasoning-soft-wrap.v1";
export const REASONING_SOFT_WRAP_CHANGE_EVENT = "codexhost:reasoning-soft-wrap-changed";

const RECOVERED_ERROR_ATTRIBUTE = "data-codexhost-recovered-turn-error";
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
const errorKey = (hostId: string, conversationId: string, turnId: string): string =>
  JSON.stringify([hostId, conversationId, turnId]);

/** Native error notifications become persistent transcript Items. A later
 * successful Turn resolves their presentation, not their historical outcome. */
export function recoveredTurnErrorKeys(entries: readonly unknown[]): ReadonlySet<string> {
  const external = new Set<string>();
  for (const entry of entries) {
    if (!record(entry) || !record(entry.turn) || !record(entry.turn.params)) continue;
    if (
      typeof entry.hostId === "string" &&
      typeof entry.conversationId === "string" &&
      typeof entry.turn.params.model === "string" &&
      entry.turn.params.model.startsWith("codexhost/")
    ) {
      external.add(errorKey(entry.hostId, entry.conversationId, ""));
    }
  }
  const recovered = new Set<string>();
  const successful = new Set<string>();
  const seen = new Set<string>();
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (
      !record(entry) ||
      !record(entry.turn) ||
      typeof entry.hostId !== "string" ||
      typeof entry.conversationId !== "string" ||
      typeof entry.turnId !== "string"
    )
      continue;
    const scope = errorKey(entry.hostId, entry.conversationId, "");
    const key = errorKey(entry.hostId, entry.conversationId, entry.turnId);
    if (!external.has(scope) || seen.has(key)) continue;
    seen.add(key);
    if (entry.turn.status === "completed" && entry.turn.error == null) successful.add(scope);
    if (successful.has(scope)) recovered.add(key);
  }
  return recovered;
}

export function installRecoveredTurnErrors(ownerDocument: Document): () => void {
  const ownerWindow = ownerDocument.defaultView;
  if (!ownerWindow) return () => {};
  const style = ownerDocument.createElement("style");
  style.textContent = `[${RECOVERED_ERROR_ATTRIBUTE}] { display: none !important; }`;
  ownerDocument.head.append(style);
  let frame: number | null = null;
  const refresh = (): void => {
    frame = null;
    const cache = new Map<readonly unknown[], ReadonlySet<string>>();
    for (const notice of ownerDocument.querySelectorAll("aside[aria-live]")) {
      const fiberKey = Object.getOwnPropertyNames(notice).find((key) =>
        key.startsWith("__reactFiber$"),
      );
      const fiber = fiberKey ? Object.getOwnPropertyDescriptor(notice, fiberKey)?.value : null;
      let key: string | null = null;
      let entries: readonly unknown[] | null = null;
      for (const ancestor of committedReactAncestors(fiber)) {
        const props = ancestor.memoizedProps;
        if (!record(props)) continue;
        if (
          key === null &&
          record(props.item) &&
          props.item.type === "system-error" &&
          typeof props.item.turnId === "string" &&
          typeof props.hostId === "string" &&
          typeof props.conversationId === "string"
        ) {
          key = errorKey(props.hostId, props.conversationId, props.item.turnId);
        }
        if (entries === null && Array.isArray(props.entries)) entries = props.entries;
        if (key !== null && entries !== null) break;
      }
      if (entries && !cache.has(entries)) cache.set(entries, recoveredTurnErrorKeys(entries));
      const hide = key !== null && entries !== null && cache.get(entries)?.has(key) === true;
      if (hide && !notice.hasAttribute(RECOVERED_ERROR_ATTRIBUTE))
        notice.setAttribute(RECOVERED_ERROR_ATTRIBUTE, "");
      else if (!hide && notice.hasAttribute(RECOVERED_ERROR_ATTRIBUTE))
        notice.removeAttribute(RECOVERED_ERROR_ATTRIBUTE);
    }
  };
  const observer = new ownerWindow.MutationObserver(() => {
    if (frame === null) frame = ownerWindow.requestAnimationFrame(refresh);
  });
  observer.observe(ownerDocument.body, { childList: true, subtree: true });
  refresh();
  return () => {
    observer.disconnect();
    if (frame !== null) ownerWindow.cancelAnimationFrame(frame);
    for (const notice of ownerDocument.querySelectorAll(`[${RECOVERED_ERROR_ATTRIBUTE}]`))
      notice.removeAttribute(RECOVERED_ERROR_ATTRIBUTE);
    style.remove();
  };
}

export function readReasoningTranscriptSoftWrap(ownerWindow: Window): boolean {
  return ownerWindow.localStorage.getItem(REASONING_SOFT_WRAP_STORAGE_KEY) === "true";
}

export function setReasoningTranscriptSoftWrap(ownerWindow: Window, enabled: boolean): void {
  ownerWindow.localStorage.setItem(REASONING_SOFT_WRAP_STORAGE_KEY, String(enabled));
  ownerWindow.dispatchEvent(new Event(REASONING_SOFT_WRAP_CHANGE_EVENT));
}

export function installReasoningTranscriptSoftWrap(ownerDocument: Document): () => void {
  const ownerWindow = ownerDocument.defaultView;
  if (!ownerWindow) return () => {};
  const style = ownerDocument.createElement("style");
  style.setAttribute("data-codexhost-reasoning-soft-wrap", "true");
  // Scope to the sentinel command, not ordinary terminal output. The native
  // output scroller's w-max child must also shrink for wrapping to take effect.
  const body = `${TRANSCRIPT_TEXT_BODY_SELECTOR}:has([aria-label="$ ${REASONING_TRANSCRIPT_COMMAND}"])`;
  style.textContent = `
    ${body} .whitespace-pre {
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    ${body} .whitespace-pre > .w-max {
      width: 100%;
      min-width: 0;
    }
  `;
  ownerDocument.head.append(style);
  const refresh = (): void => {
    style.disabled = !readReasoningTranscriptSoftWrap(ownerWindow);
  };
  const onStorage = (event: StorageEvent): void => {
    if (event.key === REASONING_SOFT_WRAP_STORAGE_KEY || event.key === null) refresh();
  };
  refresh();
  ownerWindow.addEventListener(REASONING_SOFT_WRAP_CHANGE_EVENT, refresh);
  ownerWindow.addEventListener("storage", onStorage);
  return () => {
    ownerWindow.removeEventListener(REASONING_SOFT_WRAP_CHANGE_EVENT, refresh);
    ownerWindow.removeEventListener("storage", onStorage);
    style.remove();
  };
}

export interface RendererTranscriptContractInspection {
  /** Rendered Turn containers, used to tell an empty Thread from a missing contract. */
  turnCount: number;
  /** Transcript nodes that publish the Host Item ids they render. */
  itemNodeCount: number;
  /** Host Item ids referenced by those nodes. */
  identifiedItemCount: number;
  /** Command Execution text bodies, the only transcript surface that retains text. */
  textBodyCount: number;
  /** Item nodes that own at least one text body. */
  textBodyOwnerCount: number;
}

function itemIdCount(node: Element): number {
  const value = node.getAttribute(TRANSCRIPT_ITEM_IDS_ATTRIBUTE);
  if (!value) return 0;
  return value.split(/\s+/).filter((entry) => entry.length > 0).length;
}

/**
 * Codex renders transcript text for the Command Execution lane only, and it is
 * the lane codexhost projects external Harness Reasoning through. This records
 * bounded structural counts so a Desktop update that drops the lane, or stops
 * publishing Item ids, is detected instead of silently hiding projected text.
 */
export function inspectRendererTranscriptContract(
  root: ParentNode = document,
): RendererTranscriptContractInspection {
  const itemNodes = [...root.querySelectorAll(TRANSCRIPT_ITEM_SELECTOR)];
  let identifiedItemCount = 0;
  let textBodyOwnerCount = 0;
  for (const node of itemNodes) {
    identifiedItemCount += itemIdCount(node);
    if (node.querySelector(TRANSCRIPT_TEXT_BODY_SELECTOR)) textBodyOwnerCount += 1;
  }
  return {
    turnCount: root.querySelectorAll("[data-turn-key]").length,
    itemNodeCount: itemNodes.length,
    identifiedItemCount,
    textBodyCount: root.querySelectorAll(TRANSCRIPT_TEXT_BODY_SELECTOR).length,
    textBodyOwnerCount,
  };
}
