import { createHash } from "node:crypto";

import { hostItemIdSchema, type HostItemId } from "@codexhost/shared-contracts";

export type PiMessageIdentity =
  { sessionId: string; timestamp: number; occurrence: number } | { responseId: string };

/** Allocate in active-branch order, including tool-only and failed Assistant messages. */
export function piMessageIdentity(
  sessionId: string,
  message: unknown,
  timestampCounts: Map<number, number>,
): PiMessageIdentity | undefined {
  if (
    typeof message !== "object" ||
    message === null ||
    !("role" in message) ||
    message.role !== "assistant"
  )
    return undefined;
  if (
    "timestamp" in message &&
    typeof message.timestamp === "number" &&
    Number.isSafeInteger(message.timestamp) &&
    message.timestamp >= 0
  ) {
    const occurrence = timestampCounts.get(message.timestamp) ?? 0;
    timestampCounts.set(message.timestamp, occurrence + 1);
    return { sessionId, timestamp: message.timestamp, occurrence };
  }
  if (
    "responseId" in message &&
    typeof message.responseId === "string" &&
    message.responseId.trim().length > 0
  )
    return { responseId: message.responseId };
  return undefined;
}

export function piHistoryMessageIdentities(
  sessionId: string,
  entries: readonly { id: string; message?: unknown }[],
): { identities: Map<string, PiMessageIdentity>; timestampCounts: Map<number, number> } {
  const timestampCounts = new Map<number, number>();
  const identities = new Map<string, PiMessageIdentity>();
  for (const entry of entries) {
    const identity = piMessageIdentity(sessionId, entry.message, timestampCounts);
    if (identity) identities.set(entry.id, identity);
  }
  return { identities, timestampCounts };
}

/** Pi 1.4 streams timestamps but strips responseId from its compact delta frames. */
export function piMessageItemId(
  identity: PiMessageIdentity | undefined,
  kind: "assistant" | "reasoning",
): HostItemId | null {
  if (!identity) return null;
  const timestampIdentity = "timestamp" in identity;
  const value = timestampIdentity
    ? JSON.stringify([identity.sessionId, identity.timestamp, identity.occurrence])
    : identity.responseId;
  const digest = createHash("sha256").update(value).digest("hex");
  return hostItemIdSchema.parse(
    `pi-${timestampIdentity ? "message" : "response"}-v1-${digest}-${kind}`,
  );
}
