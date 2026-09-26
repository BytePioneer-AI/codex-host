import type { HostAgentMessageItem, HostItem, HostItemOutcome } from "@codexhost/harness-adapter";

/**
 * Codex Desktop folds a completed Turn's activity only behind an Agent Message
 * whose phase is `final_answer`. An Adapter omits the phase when its Harness
 * cannot distinguish progress from the answer; for a succeeded Turn, an Agent
 * Message that is the last Item Desktop shows is that Turn's final answer.
 * An explicit Adapter phase always wins, so `commentary` opts a message out.
 */
export function inferredFinalAnswer(
  lastVisible: { item: HostItem; outcome: HostItemOutcome | null } | undefined,
  turnSucceeded: boolean,
): HostAgentMessageItem | null {
  if (!turnSucceeded || !lastVisible) return null;
  const { item, outcome } = lastVisible;
  if (item.type !== "agentMessage" || item.phase !== undefined) return null;
  if (outcome?.status !== "succeeded" || item.text.trim().length === 0) return null;
  return { ...item, phase: "final_answer" };
}
