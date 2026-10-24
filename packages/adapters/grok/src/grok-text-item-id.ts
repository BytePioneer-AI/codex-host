import { createHash } from "node:crypto";
import { hostItemIdSchema } from "@codexhost/shared-contracts";

/** Live and replay text Items share identity independently of chunk boundaries and text. */
export function grokTextItemId(
  sessionId: string,
  turnIndex: number,
  kind: "agentMessage" | "reasoning",
  ordinal: number,
): ReturnType<typeof hostItemIdSchema.parse> {
  const identity = JSON.stringify([sessionId, turnIndex, kind, ordinal]);
  return hostItemIdSchema.parse(`grok-text-${createHash("sha256").update(identity).digest("hex")}`);
}
