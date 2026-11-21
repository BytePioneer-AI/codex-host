import {
  reasoningPreviewItemId,
  reasoningSummaryParts,
  type JsonObject,
  type JsonValue,
} from "@codexhost/protocol-core";
import { REASONING_TRANSCRIPT_COMMAND, type HostItemId } from "@codexhost/shared-contracts";

type Item = JsonObject & { id: string };
type Unit = {
  items: readonly Item[];
  evidence: string | null;
  reasoningBase?: string;
};

const previewSuffix = reasoningPreviewItemId("" as HostItemId);
const previewId = (base: string) => reasoningPreviewItemId(base as HostItemId);

function isObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isItem(value: JsonValue | undefined): value is Item {
  return isObject(value) && typeof value.id === "string";
}

function isTranscript(item: Item): boolean {
  return item.type === "commandExecution" && item.command === REASONING_TRANSCRIPT_COMMAND;
}

function reasoningText(value: JsonValue | undefined): string | null {
  return typeof value === "string" ? value.replace(/[\r\n]+$/u, "") || null : null;
}

function reasoningUnit(base: string, summary?: Item, transcript?: Item): Unit {
  const blocks = summary?.summary;
  const preview =
    Array.isArray(blocks) && blocks.every((block) => typeof block === "string")
      ? reasoningText(blocks.join("\n"))
      : null;
  const output = reasoningText(transcript?.aggregatedOutput);
  let text = output ?? preview;
  if (preview && output && preview !== output) {
    // A generated title is presentation, not new text or evidence of a mismatched twin:
    // both sides agree on the titled projection of the transcript when the preview is
    // exactly that projection, and a preview that is neither is a mismatched twin.
    const titled = reasoningSummaryParts(output, true).join("\n");
    text = preview === titled ? titled : null;
  }
  return {
    items: [summary, transcript].filter((item) => item !== undefined),
    evidence: text === null ? null : JSON.stringify(["reasoning", text]),
    reasoningBase: base,
  };
}

function itemEvidence(item: Item): string | null {
  let fields: (JsonValue | undefined)[];
  switch (item.type) {
    case "agentMessage": {
      const text =
        typeof item.codexhostNativeText === "string" ? item.codexhostNativeText : item.text;
      if (typeof text !== "string" || !text.trimEnd()) return null;
      fields = [text.trimEnd()];
      break;
    }
    case "commandExecution":
      fields = [item.command, item.cwd];
      break;
    case "mcpToolCall":
      fields = [item.server, item.tool, item.arguments];
      break;
    case "dynamicToolCall":
      fields = [item.namespace, item.tool, item.arguments];
      break;
    case "webSearch":
      fields = [item.query];
      break;
    case "fileChange":
      fields = [item.changes];
      break;
    case "collabAgentToolCall":
      fields = [item.tool, item.senderThreadId, item.receiverThreadIds, item.prompt];
      break;
    case "contextCompaction":
      // This is a marker with no identifying payload beyond its type and position.
      fields = [];
      break;
    default:
      return null;
  }
  if (fields.some((field) => field === undefined)) return null;
  // JSON objects in tool arguments (or change details) are unordered.
  return JSON.stringify([item.type, ...fields], (_key, value: JsonValue) =>
    isObject(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, value[key]]),
        )
      : value,
  );
}

function units(items: readonly JsonValue[]): Unit[] {
  const result: Unit[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!isItem(item)) continue;
    if (item.type === "reasoning" && item.id.endsWith(previewSuffix)) {
      const base = item.id.slice(0, -previewSuffix.length);
      const next = items[index + 1];
      if (isItem(next) && isTranscript(next) && next.id === base) {
        result.push(reasoningUnit(base, item, next));
        index += 1;
      } else {
        result.push(reasoningUnit(base, item));
      }
    } else if (isTranscript(item)) {
      result.push(reasoningUnit(item.id, undefined, item));
    } else {
      result.push({ items: [item], evidence: itemEvidence(item) });
    }
  }
  return result;
}

function reservedIds(unit: Unit): string[] {
  return unit.reasoningBase === undefined
    ? unit.items.map(({ id }) => id)
    : [unit.reasoningBase, previewId(unit.reasoningBase)];
}

function findAnchors(
  previous: readonly Unit[],
  refreshed: readonly Unit[],
): [number, number][] | null {
  const byId = new Map<string, number>();
  for (const [index, unit] of previous.entries()) {
    for (const { id } of unit.items) {
      if (byId.has(id)) return null;
      byId.set(id, index);
    }
  }
  const anchors: [number, number][] = [];
  const seen = new Set<string>();
  let last = -1;
  for (const [index, unit] of refreshed.entries()) {
    let match: number | undefined;
    for (const { id } of unit.items) {
      if (seen.has(id)) return null;
      seen.add(id);
      const position = byId.get(id);
      if (position === undefined) continue;
      if (match !== undefined && match !== position) return null;
      match = position;
    }
    if (match === undefined) continue;
    if (match <= last) return null;
    anchors.push([match, index]);
    last = match;
  }
  anchors.push([previous.length, refreshed.length]);
  return anchors;
}

function groupByEvidence(units: readonly Unit[]): Map<string, number[]> {
  const byEvidence = new Map<string, number[]>();
  for (const [index, { evidence }] of units.entries()) {
    if (evidence === null) continue;
    const matches = byEvidence.get(evidence);
    if (matches) matches.push(index);
    else byEvidence.set(evidence, [index]);
  }
  return byEvidence;
}

/** Within an exact-ID interval, equal-size groups pair by occurrence. Decline
 * unequal groups and any proposals that would cross another correspondence. */
function* orderedMatches(
  previous: readonly Unit[],
  refreshed: readonly Unit[],
): Generator<[Unit, Unit]> {
  const previousGroups = groupByEvidence(previous);
  const proposals = new Map<number, number>();
  for (const [evidence, indexes] of groupByEvidence(refreshed)) {
    const matches = previousGroups.get(evidence);
    if (matches?.length === indexes.length) {
      for (const [offset, index] of indexes.entries()) {
        const match = matches[offset];
        if (match !== undefined) proposals.set(index, match);
      }
    }
  }
  let leftMax = -1;
  const increasingFromLeft = new Set<number>();
  for (const index of refreshed.keys()) {
    const match = proposals.get(index);
    if (match === undefined) continue;
    if (match > leftMax) increasingFromLeft.add(index);
    leftMax = Math.max(leftMax, match);
  }
  let rightMin = previous.length;
  for (let index = refreshed.length - 1; index >= 0; index -= 1) {
    const match = proposals.get(index);
    if (match === undefined) continue;
    if (match < rightMin && increasingFromLeft.has(index)) {
      const previousUnit = previous[match];
      const refreshedUnit = refreshed[index];
      if (previousUnit && refreshedUnit) yield [previousUnit, refreshedUnit];
    }
    rightMin = Math.min(rightMin, match);
  }
}

function reconcileTurn(previousTurn: JsonObject, refreshedTurn: JsonObject): JsonObject {
  if (!Array.isArray(previousTurn.items) || !Array.isArray(refreshedTurn.items))
    return refreshedTurn;
  const previous = units(previousTurn.items);
  const refreshed = units(refreshedTurn.items);
  const anchors = findAnchors(previous, refreshed);
  if (!anchors) return refreshedTurn;
  // Reserve native IDs (including absent reasoning twins), not just exact matches.
  // Never borrow another unit's identity, even if it could also be remapped.
  const occupied = new Set(refreshed.flatMap(reservedIds));
  const previousIdCounts = new Map<string, number>();
  for (const id of previous.flatMap(reservedIds)) {
    previousIdCounts.set(id, (previousIdCounts.get(id) ?? 0) + 1);
  }
  const remapped = new Map<string, string>();
  let previousStart = 0;
  let refreshedStart = 0;
  for (const [previousEnd, refreshedEnd] of anchors) {
    for (const [live, history] of orderedMatches(
      previous.slice(previousStart, previousEnd),
      refreshed.slice(refreshedStart, refreshedEnd),
    )) {
      const ids = reservedIds(live);
      if (ids.some((id) => occupied.has(id) || previousIdCounts.get(id) !== 1)) continue;
      for (const id of ids) occupied.add(id);
      const liveFirst = live.items[0];
      for (const item of history.items) {
        const targetId =
          live.reasoningBase === undefined
            ? liveFirst?.id
            : item.type === "reasoning"
              ? previewId(live.reasoningBase)
              : live.reasoningBase;
        if (targetId !== undefined) remapped.set(item.id, targetId);
      }
    }
    previousStart = previousEnd + 1;
    refreshedStart = refreshedEnd + 1;
  }
  if (remapped.size === 0) return refreshedTurn;
  const items = refreshedTurn.items.map((item) => {
    if (!isItem(item)) return item;
    const id = remapped.get(item.id);
    return id === undefined ? item : { ...item, id };
  });
  const fileOperations = refreshedTurn.codexhostFileOperations;
  return {
    ...refreshedTurn,
    items,
    // Keep the native file-operation placement attached to the same visible Item.
    ...(Array.isArray(fileOperations) && {
      codexhostFileOperations: fileOperations.map((operation) => {
        if (!isObject(operation) || typeof operation.beforeItemId !== "string") return operation;
        const id = remapped.get(operation.beforeItemId);
        return id === undefined ? operation : { ...operation, beforeItemId: id };
      }),
    }),
  };
}

/** Preserve already-served Item identities without retaining stale native history. */
export function reconcileExternalTurnItemIds(
  previousTurns: readonly JsonObject[],
  refreshedTurns: JsonObject[],
): JsonObject[] {
  const previousById = new Map(previousTurns.map((turn) => [turn.id, turn]));
  return refreshedTurns.map((turn) => {
    const previous = typeof turn.id === "string" ? previousById.get(turn.id) : undefined;
    return previous ? reconcileTurn(previous, turn) : turn;
  });
}
