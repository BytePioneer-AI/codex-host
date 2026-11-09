/**
 * Optional bandwidth reductions for client channel snapshots. The snapshot stays
 * absolute: a placeholder only stands for a completed Turn whose served form is
 * byte-identical to the copy the client says it holds.
 */
import { createHash } from "node:crypto";
import type {
  ClientItemTruncation,
  ClientSnapshotOptions,
  ClientThreadSnapshot,
} from "@codexhost/shared-contracts";

/** A tool output string longer than this many characters is shortened when the client opts in. */
export const SNAPSHOT_TOOL_OUTPUT_LIMIT = 64 * 1024;
/** Characters kept from the head of a shortened string. */
export const SNAPSHOT_TOOL_OUTPUT_PREVIEW = 8 * 1024;

type Turn = ClientThreadSnapshot["turnsPage"]["data"][number];
type Item = Turn["items"][number];
type Path = Array<string | number>;

/** Tool Item fields that carry output. Messages and Reasoning are never shortened. */
const OUTPUT_FIELDS: Readonly<Record<string, readonly string[]>> = {
  commandExecution: ["aggregatedOutput"],
  fileChange: ["changes"],
  mcpToolCall: ["result", "error"],
  dynamicToolCall: ["contentItems"],
};

/** Only these Turns are served identically by `thread/items/list`, so only they
 * may be shortened or replaced by a placeholder. The live Turn is always full. */
function settled(turn: Turn, activeTurnId: string | null | undefined): boolean {
  return turn.status !== "inProgress" && turn.id !== activeTurnId;
}

function shorten(text: string): string {
  let end = SNAPSHOT_TOOL_OUTPUT_PREVIEW;
  // Never split a UTF-16 surrogate pair.
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

function truncateValue(
  value: unknown,
  path: Path,
  fields: ClientItemTruncation["fields"],
): unknown {
  if (typeof value === "string") {
    if (value.length <= SNAPSHOT_TOOL_OUTPUT_LIMIT) return value;
    fields.push({ path, originalLength: value.length });
    return shorten(value);
  }
  if (Array.isArray(value))
    return value.map((entry, index) => truncateValue(entry, [...path, index], fields));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        truncateValue(entry, [...path, key], fields),
      ]),
    );
  return value;
}

function truncateItem(item: Item): Item {
  const keys = OUTPUT_FIELDS[item.type];
  if (!keys || item.status === "inProgress") return item;
  const fields: ClientItemTruncation["fields"] = [];
  const next: Item = { ...item };
  for (const key of keys) if (key in next) next[key] = truncateValue(next[key], [key], fields);
  return fields.length ? { ...next, codexhostTruncated: { fields } } : item;
}

/** Bound to the epoch, so a fingerprint from a previous Host never matches. */
function fingerprint(epoch: string, turn: Turn): string {
  return createHash("sha256")
    .update(epoch)
    .update("\0")
    .update(JSON.stringify(turn))
    .digest("base64url")
    .slice(0, 32);
}

/**
 * Apply the request's opt-in options to an already captured snapshot. Without
 * options the snapshot is returned unchanged.
 */
export function compactClientSnapshot(
  snapshot: ClientThreadSnapshot,
  options: ClientSnapshotOptions,
): ClientThreadSnapshot {
  const { knownTurns, truncateToolOutput } = options;
  if (!knownTurns && !truncateToolOutput) return snapshot;
  const known = new Map((knownTurns ?? []).map((turn) => [turn.id, turn.fingerprint]));
  const data = snapshot.turnsPage.data.map((turn): Turn => {
    if (!settled(turn, snapshot.activeTurnId)) return turn;
    const served = truncateToolOutput ? { ...turn, items: turn.items.map(truncateItem) } : turn;
    if (!knownTurns) return served;
    const value = fingerprint(snapshot.cursor.epoch, served);
    return known.get(turn.id) === value
      ? { id: turn.id, status: turn.status, items: [], fingerprint: value, unchanged: true }
      : { ...served, fingerprint: value };
  });
  return { ...snapshot, turnsPage: { ...snapshot.turnsPage, data } };
}
