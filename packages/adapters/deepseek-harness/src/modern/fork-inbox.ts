import { isDeepStrictEqual } from "node:util";

import { hasExactKeys, isRecord } from "../profiles/journal-format.js";
import { ModernJournalError, type ModernJournal, type ModernJournalRemote } from "./journal.js";
import { ModernRemoteConnectionError } from "./remote-connection.js";
import type { ModernRemoteResult } from "./wire.js";

/** Read native V3 pending input, refusing any item not owned by the verified fork seed. */
export function pendingForkInboxIds(journal: ModernJournal): readonly string[] {
  const inheritedCount = journal.inheritedEventCount;
  if (
    inheritedCount === undefined ||
    !Number.isSafeInteger(inheritedCount) ||
    inheritedCount < 0 ||
    inheritedCount > journal.events.length
  )
    throw invalidInbox();
  const inherited = new Map<string, Record<string, unknown>>();
  const ownIds = new Set<string>();
  let inheritedSplice = false;
  for (const event of journal.events) {
    if (event.type !== "agent/inbox/spliced") continue;
    if (!isRecord(event.data) || !Array.isArray(event.data.inserted)) throw invalidInbox();
    const isInherited = event.seq < inheritedCount;
    inheritedSplice ||= isInherited;
    for (const message of event.data.inserted) {
      const parsed = inboxMessage(message);
      if (isInherited) inherited.set(parsed.id, parsed.value);
      else ownIds.add(parsed.id);
    }
  }
  const inbox = journal.projections.values.inbox;
  if (inbox === undefined && !inheritedSplice && ownIds.size === 0) return [];
  if (
    !isRecord(inbox) ||
    !hasExactKeys(inbox, ["next-turn", "next-step"]) ||
    !Array.isArray(inbox["next-turn"]) ||
    !Array.isArray(inbox["next-step"])
  )
    throw invalidInbox();
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const message of [...inbox["next-turn"], ...inbox["next-step"]]) {
    const parsed = inboxMessage(message);
    if (
      seen.has(parsed.id) ||
      ownIds.has(parsed.id) ||
      !isDeepStrictEqual(inherited.get(parsed.id), parsed.value)
    )
      throw invalidInbox();
    seen.add(parsed.id);
    ids.push(parsed.id);
  }
  return ids;
}

/** Remove inherited input without retries; the caller must verify the fresh journal and flush it. */
export async function clearInheritedForkInbox(
  remote: ModernJournalRemote,
  journal: ModernJournal,
  signal: AbortSignal,
): Promise<boolean> {
  const ids = pendingForkInboxIds(journal);
  for (const itemId of ids) {
    if (signal.aborted)
      throw new ModernJournalError(
        "cancelled",
        "DeepSeek Harness fork inbox cleanup was cancelled",
      );
    let result: ModernRemoteResult<unknown>;
    try {
      result = await remote.call<unknown>(
        "session/updateQueue",
        {
          request: { sessionId: journal.header.id, itemId, action: { kind: "remove" } },
        },
        signal,
      );
    } catch (error) {
      if (signal.aborted)
        throw new ModernJournalError(
          "cancelled",
          "DeepSeek Harness fork inbox cleanup was cancelled",
        );
      if (error instanceof ModernRemoteConnectionError)
        throw new ModernJournalError(error.code, error.message, error.nativeCode);
      throw new ModernJournalError("unavailable", "DeepSeek Harness fork inbox cleanup failed");
    }
    if (!result.ok)
      throw new ModernJournalError("remoteError", result.error.message, result.error.code);
    if (
      !isRecord(result.value) ||
      !hasExactKeys(result.value, ["accepted"]) ||
      result.value.accepted !== true
    )
      throw invalidInbox();
  }
  return ids.length > 0;
}

function inboxMessage(value: unknown): {
  readonly id: string;
  readonly value: Record<string, unknown>;
} {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["id", "role", "content", "source"]) ||
    typeof value.id !== "string" ||
    value.id.trim() === "" ||
    value.role !== "user" ||
    !Array.isArray(value.content) ||
    !isRecord(value.source) ||
    typeof value.source.kind !== "string" ||
    value.source.kind.trim() === ""
  )
    throw invalidInbox();
  return { id: value.id, value };
}

function invalidInbox(): ModernJournalError {
  return new ModernJournalError(
    "protocolError",
    "DeepSeek Harness fork inbox is malformed or contains input outside the inherited prefix",
  );
}
