import { createHash } from "node:crypto";
import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import type { HarnessError } from "@codexhost/harness-adapter";
import { projectReplayedEventsToTurns } from "./acp-projection.js";
import type { NativeReplayEvent } from "./native-replay.js";

export function nativeConversationDbPath(id: string, home = os.homedir()): string {
  return path.join(home, ".gemini", "antigravity-cli", "conversations", `${id}.db`);
}

/** Read native user-input boundaries without creating or repairing a missing store. */
export async function readNativeTurnCount(dbPath: string): Promise<number> {
  await access(dbPath);
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db.prepare("SELECT count(*) AS n FROM steps WHERE step_type = 14").get();
    return Number(row?.n ?? 0);
  } finally {
    db.close();
  }
}

const COMMIT_RECHECK_MS = [25, 75, 175];
const COMMIT_BUDGET_MS = 250;

/** A fresh read for each probe; an ACP response need not follow the SQLite commit. */
export async function observeNativeTurnCount(
  readCount: () => Promise<number>,
  before: number,
  retry: boolean,
  signal: AbortSignal,
): Promise<number | undefined> {
  const started = performance.now();
  let count: number | undefined;
  for (const at of retry ? [0, ...COMMIT_RECHECK_MS] : [0]) {
    if (at > 0) {
      const elapsed = performance.now() - started;
      if (elapsed >= COMMIT_BUDGET_MS) break;
      if (elapsed < at) await delay(at - elapsed, undefined, { signal }).catch(() => undefined);
      if (performance.now() - started >= COMMIT_BUDGET_MS) break;
    }
    // A cancelled prompt can still have a committed input. Take the immediate
    // snapshot, but do not wait for any more snapshots after cancellation.
    if (at > 0 && signal.aborted) break;
    try {
      count = await readCount();
      if (count > before) break;
    } catch (error) {
      const { code } = nativeHistoryError(error);
      if (code !== "sessionBusy" && code !== "sessionNotFound") break;
    }
  }
  return count;
}

export function nativeInputFingerprint(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Confirm an ambiguous suffix against the existing logical history grouping. */
export function matchNativeTurnSuffix(input: {
  nativeSessionId: string;
  cwd: string;
  events: readonly NativeReplayEvent[];
  turnCount: number;
  before: number;
  expected: readonly string[];
}): number | undefined {
  const { nativeSessionId, cwd, events, turnCount, before, expected } = input;
  if (turnCount <= before) return undefined;
  const first = events.findIndex(
    (event) => event.type === "user.text" && event.nativeTurnIndex === before,
  );
  // Refuse a suffix that would extend an already mapped group or hide native inputs.
  if (first < 0 || events[first - 1]?.type === "user.text") return undefined;
  const suffixEvents = events.slice(first);
  if (suffixEvents.filter((event) => event.type === "user.text").length !== turnCount - before)
    return undefined;
  const suffix = projectReplayedEventsToTurns({
    nativeSessionId,
    cwd,
    events: suffixEvents,
  }).filter(({ checkpoint }) => checkpoint?.checkpointId.startsWith("turn-"));
  // A single visible boundary cannot settle two outstanding prompt identities.
  if (
    suffix.length === expected.length &&
    suffix.at(-1)?.checkpoint?.checkpointId === `turn-${turnCount - 1}` &&
    suffix.every(
      ({ input, items }, index) =>
        input[0] !== undefined &&
        nativeInputFingerprint(input[0].text) === expected[index] &&
        items.some(({ item }) => item.type === "agentMessage" && item.text.trim()),
    )
  )
    return turnCount;
  return undefined;
}

export function nativeHistoryError(error: unknown): HarnessError {
  const sqlite = error as { code?: string; errcode?: number } | undefined;
  if (sqlite?.code === "ERR_SQLITE_ERROR" && sqlite.errcode !== undefined) {
    const primary = sqlite.errcode & 0xff;
    if (primary === 5 || primary === 6)
      // SQLITE_BUSY / SQLITE_LOCKED, including extended codes
      return {
        code: "sessionBusy",
        message: "Antigravity native history database is locked; retry shortly",
        retryable: true,
      };
  }
  const missing = sqlite?.code === "ENOENT";
  return {
    code: missing ? "sessionNotFound" : "nativeFailure",
    message: missing
      ? "Antigravity native conversation database was not found"
      : "Cannot read or derive Antigravity native history",
    retryable: false,
  };
}
