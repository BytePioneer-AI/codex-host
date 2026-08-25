import { hostItemIdSchema, type HostItemId } from "@codexhost/shared-contracts";

export type ClaudeTranscriptItemKind = "agentMessage" | "reasoning";

/**
 * Claude preserves the caller-assigned User Message UUID in native history.
 * Derive visible Item identities from that Turn anchor plus a per-kind ordinal so
 * the live stream and a later history projection address the same Renderer Item.
 */
export function claudeTranscriptItemId(
  nativeTurnKey: string,
  kind: ClaudeTranscriptItemKind,
  ordinal: number,
): HostItemId {
  return hostItemIdSchema.parse(`claude-item-v2-${nativeTurnKey}-${kind}-${ordinal}`);
}
