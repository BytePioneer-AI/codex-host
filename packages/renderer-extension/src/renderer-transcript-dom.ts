export const TRANSCRIPT_ITEM_SELECTOR = "[data-local-conversation-item-target-ids]";
export const TRANSCRIPT_ITEM_IDS_ATTRIBUTE = "data-local-conversation-item-target-ids";
export const TRANSCRIPT_TEXT_BODY_SELECTOR = '[data-testid="exec-shell-body"]';

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
