import type { StoredSectionPlacementV1, StoredThreadSection } from "@codexhost/mapping-store";
import {
  encodeSectionThreadListCursor,
  type DecodedThreadListRequest,
  type DecodedThreadSectionMoveRequest,
  type JsonObject,
} from "@codexhost/protocol-core";

import {
  OfficialThreadListError,
  officialThreadListPageFromResponse,
} from "./thread-list-aggregator.js";

/**
 * Thread sections (Codex Desktop's "Pinned" section and custom sections) across Thread owners.
 *
 * The official app-server owns section definitions and the order of official Threads. External
 * Threads are stored by the Host as placements anchored to the Thread they precede. After every
 * move, each External placement in an affected section is re-anchored to its immediate successor
 * in the intended order, so merging the official order with the anchors reproduces that order.
 */

const MAX_OFFICIAL_PAGES = 256;
const OFFICIAL_PAGE_SIZE = 100;

export class ThreadSectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ThreadSectionError";
  }
}

/** Merges External placements into one section's official order (ascending positions). */
export function mergeSectionOrder(
  officialIds: readonly string[],
  placements: readonly StoredSectionPlacementV1[],
): string[] {
  const externalIds = new Set<string>(placements.map((placement) => placement.hostThreadId));
  const order = officialIds.filter((id) => !externalIds.has(id));
  let pending = [...placements];
  while (pending.length > 0) {
    const waiting = new Set<string>(pending.map((placement) => placement.hostThreadId));
    const deferred: StoredSectionPlacementV1[] = [];
    for (const placement of pending) {
      const before = placement.beforeThreadId;
      const index = before === null ? -1 : order.indexOf(before);
      if (index >= 0) {
        order.splice(index, 0, placement.hostThreadId);
      } else if (before !== null && before !== placement.hostThreadId && waiting.has(before)) {
        deferred.push(placement);
        continue;
      } else {
        // Last in the section, or its anchor left the section: keep it rather than drop it.
        order.push(placement.hostThreadId);
      }
      waiting.delete(placement.hostThreadId);
    }
    if (deferred.length === pending.length) {
      for (const placement of deferred) order.push(placement.hostThreadId);
      break;
    }
    pending = deferred;
  }
  return order;
}

export interface SectionMovePlan {
  placements: StoredSectionPlacementV1[];
  /** For an official Thread: the official Thread it must precede in the official order. */
  officialBeforeThreadId: string | null;
}

/**
 * Plans one `thread/section/move`. `orders` holds the current merged order of the Thread's
 * current section and of the destination section.
 */
export function planSectionMove(input: {
  move: DecodedThreadSectionMoveRequest;
  movingExternal: boolean;
  currentSectionId: string | null;
  destination: StoredThreadSection | null;
  orders: ReadonlyMap<string, readonly string[]>;
  placements: readonly StoredSectionPlacementV1[];
  isExternal(threadId: string): boolean;
  now: Date;
}): SectionMovePlan {
  const { threadId, beforeThreadId } = input.move;
  const previous = input.placements.find((placement) => placement.hostThreadId === threadId);
  const placements = input.placements
    .filter((placement) => placement.hostThreadId !== threadId)
    .map((placement) => ({ ...placement }));
  const reanchor = (sectionId: string, order: readonly string[]) => {
    for (const placement of placements) {
      if (placement.section.id !== sectionId) continue;
      const index = order.indexOf(placement.hostThreadId);
      if (index >= 0) placement.beforeThreadId = order[index + 1] ?? null;
    }
  };
  const without = (sectionId: string) =>
    (input.orders.get(sectionId) ?? []).filter((id) => id !== threadId);

  if (input.currentSectionId !== null && input.currentSectionId !== input.destination?.id) {
    reanchor(input.currentSectionId, without(input.currentSectionId));
  }
  if (!input.destination) return { placements, officialBeforeThreadId: null };

  const base = without(input.destination.id);
  if (beforeThreadId !== null && !base.includes(beforeThreadId)) {
    throw new ThreadSectionError(
      `before thread ${beforeThreadId} is not in section ${input.destination.id}`,
    );
  }
  const index = beforeThreadId === null ? base.length : base.indexOf(beforeThreadId);
  const intended = [...base.slice(0, index), threadId, ...base.slice(index)];
  if (input.movingExternal) {
    placements.push({
      hostThreadId: threadId as StoredSectionPlacementV1["hostThreadId"],
      section: input.destination,
      enteredAt:
        previous && previous.section.id === input.destination.id
          ? previous.enteredAt
          : input.now.toISOString(),
      beforeThreadId: null,
    });
  }
  reanchor(input.destination.id, intended);
  return {
    placements,
    officialBeforeThreadId: intended.slice(index + 1).find((id) => !input.isExternal(id)) ?? null,
  };
}

type OfficialRequest = (method: string, params: JsonObject) => Promise<JsonObject>;

/** Every official Thread row of one query, following official pagination to its end. */
export async function listAllOfficialRows(
  requestOfficial: OfficialRequest,
  params: JsonObject,
): Promise<JsonObject[]> {
  const rows: JsonObject[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_OFFICIAL_PAGES; page += 1) {
    const result = officialThreadListPageFromResponse(
      await requestOfficial("thread/list", { ...params, cursor, limit: OFFICIAL_PAGE_SIZE }),
    );
    rows.push(...result.data);
    if (result.nextCursor === null || result.nextCursor === cursor) return rows;
    cursor = result.nextCursor;
  }
  throw new Error("Official thread/list pagination exceeded its request bound");
}

/** Current merged order of one section, as Codex Desktop lists it. */
export async function sectionOrder(input: {
  sectionId: string;
  placements: readonly StoredSectionPlacementV1[];
  requestOfficial: OfficialRequest;
}): Promise<string[]> {
  const rows = await listAllOfficialRows(input.requestOfficial, {
    sectionId: input.sectionId,
    sortKey: "section_position",
    modelProviders: [],
    useStateDbOnly: true,
  });
  return mergeSectionOrder(
    rows.map((row) => String(row.id)),
    input.placements.filter((placement) => placement.section.id === input.sectionId),
  );
}

/** The official definition of a section, which External placements copy. */
export async function findOfficialSection(
  requestOfficial: OfficialRequest,
  sectionId: string,
): Promise<StoredThreadSection> {
  let cursor: string | null = null;
  for (let page = 0; page < MAX_OFFICIAL_PAGES; page += 1) {
    const response = await requestOfficial("threadSection/list", {
      cursor,
      limit: OFFICIAL_PAGE_SIZE,
    });
    const result = response.result;
    if (typeof result !== "object" || result === null || Array.isArray(result)) {
      throw new Error("Official threadSection/list failed");
    }
    const data = Array.isArray(result.data) ? result.data : [];
    for (const entry of data) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
      if (entry.id !== sectionId) continue;
      const appearance = entry.appearance;
      return {
        id: sectionId,
        name: typeof entry.name === "string" ? entry.name : "",
        appearance:
          typeof appearance === "object" && appearance !== null && !Array.isArray(appearance)
            ? {
                icon: typeof appearance.icon === "string" ? appearance.icon : null,
                color: typeof appearance.color === "string" ? appearance.color : null,
              }
            : null,
      };
    }
    const next = typeof result.nextCursor === "string" ? result.nextCursor : null;
    if (next === null || next === cursor) break;
    cursor = next;
  }
  throw new ThreadSectionError(`section ${sectionId} does not exist`);
}

export interface SectionThreadListPage extends JsonObject {
  data: JsonObject[];
  nextCursor: string | null;
  backwardsCursor: null;
}

/**
 * A `section_position` page with External Threads merged in, or null when the section holds no
 * listed External Thread and the official response can be returned unchanged.
 */
export async function listSectionThreads(input: {
  query: DecodedThreadListRequest;
  placements: readonly StoredSectionPlacementV1[];
  externalRows: ReadonlyMap<string, JsonObject>;
  requestOfficial: OfficialRequest;
}): Promise<SectionThreadListPage | null> {
  const { query } = input;
  if (typeof query.sectionId !== "string") return null;
  const inSection = input.placements.filter(
    (placement) => placement.section.id === query.sectionId,
  );
  if (
    query.sectionOffset === null &&
    !inSection.some((p) => input.externalRows.has(p.hostThreadId))
  )
    return null;
  // Pagination and direction apply to the merged order, not to the official pages.
  const params: JsonObject = { ...query.params, sortDirection: "asc" };
  delete params.cursor;
  delete params.limit;
  const officialRows = await listAllOfficialRows(input.requestOfficial, params);
  const rows = new Map<string, JsonObject>(input.externalRows);
  for (const row of officialRows) rows.set(String(row.id), row);
  const order = mergeSectionOrder(
    officialRows.map((row) => String(row.id)),
    inSection,
  ).filter((id) => rows.has(id));
  if (query.sortDirection === "desc") order.reverse();
  const offset = query.sectionOffset ?? 0;
  const end = offset + query.limit;
  return {
    data: order.slice(offset, end).flatMap((id) => {
      const row = rows.get(id);
      return row ? [row] : [];
    }),
    nextCursor:
      end < order.length && query.limit > 0
        ? encodeSectionThreadListCursor(query.queryFingerprint, end)
        : null,
    backwardsCursor: null,
  };
}

export type SectionMoveOutcome =
  { kind: "forward" } | { kind: "moved" } | { kind: "error"; error: JsonObject };

function officialError(response: JsonObject): JsonObject | null {
  const error = response.error;
  return typeof error === "object" && error !== null && !Array.isArray(error) ? error : null;
}

/**
 * Applies one `thread/section/move`. An official move that touches no External placement is
 * forwarded unchanged; otherwise the official order and the External anchors change together.
 */
export async function moveThreadSection(input: {
  move: DecodedThreadSectionMoveRequest;
  movingExternal: boolean;
  externalThreadIds: ReadonlySet<string>;
  placements: readonly StoredSectionPlacementV1[];
  requestOfficial: OfficialRequest;
  savePlacements(placements: StoredSectionPlacementV1[]): Promise<unknown>;
  now: Date;
}): Promise<SectionMoveOutcome> {
  const { move, requestOfficial } = input;
  const isExternal = (threadId: string) => input.externalThreadIds.has(threadId);
  if (
    !input.movingExternal &&
    input.placements.length === 0 &&
    !(move.beforeThreadId !== null && isExternal(move.beforeThreadId))
  ) {
    return { kind: "forward" };
  }
  try {
    let currentSectionId: string | null;
    let destination: StoredThreadSection | null = null;
    if (input.movingExternal) {
      currentSectionId =
        input.placements.find((placement) => placement.hostThreadId === move.threadId)?.section
          .id ?? null;
      if (move.sectionId !== null)
        destination = await findOfficialSection(requestOfficial, move.sectionId);
    } else {
      const read = await requestOfficial("thread/read", { threadId: move.threadId });
      const error = officialError(read);
      if (error) return { kind: "error", error };
      const result = read.result as JsonObject | undefined;
      const thread = result?.thread as JsonObject | undefined;
      const section = thread?.section as JsonObject | null | undefined;
      currentSectionId = typeof section?.id === "string" ? section.id : null;
      // The official app-server validates its own section on the forwarded move.
      if (move.sectionId !== null) destination = { id: move.sectionId, name: "", appearance: null };
    }
    const orders = new Map<string, string[]>();
    for (const sectionId of new Set([currentSectionId, move.sectionId])) {
      if (sectionId === null) continue;
      orders.set(
        sectionId,
        await sectionOrder({ sectionId, placements: input.placements, requestOfficial }),
      );
    }
    const plan = planSectionMove({
      move,
      movingExternal: input.movingExternal,
      currentSectionId,
      destination,
      orders,
      placements: input.placements,
      isExternal,
      now: input.now,
    });
    if (!input.movingExternal) {
      const response = await requestOfficial("thread/section/move", {
        threadId: move.threadId,
        sectionId: move.sectionId,
        beforeThreadId: plan.officialBeforeThreadId,
      });
      const error = officialError(response);
      if (error) return { kind: "error", error };
    }
    await input.savePlacements(plan.placements);
    return { kind: "moved" };
  } catch (error) {
    if (error instanceof ThreadSectionError)
      return { kind: "error", error: { code: -32600, message: error.message } };
    if (error instanceof OfficialThreadListError) return { kind: "error", error: error.rpcError };
    throw error;
  }
}
