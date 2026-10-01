import { REASONING_TRANSCRIPT_COMMAND } from "@codexhost/shared-contracts";

export const TRANSCRIPT_ITEM_SELECTOR = "[data-local-conversation-item-target-ids]";
export const TRANSCRIPT_ITEM_IDS_ATTRIBUTE = "data-local-conversation-item-target-ids";
export const TRANSCRIPT_TEXT_BODY_SELECTOR = '[data-testid="exec-shell-body"]';
export const REASONING_SOFT_WRAP_STORAGE_KEY = "codexhost.reasoning-soft-wrap.v1";
export const REASONING_SOFT_WRAP_CHANGE_EVENT = "codexhost:reasoning-soft-wrap-changed";

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
