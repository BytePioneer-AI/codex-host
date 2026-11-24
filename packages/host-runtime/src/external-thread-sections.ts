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

export const SHARED_SECTIONS_WATCH_METHOD = "codexhost/shared-threads/sections/watch";
export const SHARED_SECTIONS_CHANGED_METHOD = "codexhost/shared-threads/sections/changed";
export const SHARED_SECTIONS_RECONCILE_METHOD = "codexhost/shared-threads/sections/reconcile";

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
  requireComplete = false,
): Promise<JsonObject[]> {
  const rows: JsonObject[] = [];
  const seen = requireComplete ? new Set<string>() : undefined;
  let cursor: string | null = null;
  for (let page = 0; page < MAX_OFFICIAL_PAGES; page += 1) {
    const response = await requestOfficial("thread/list", {
      ...params,
      cursor,
      limit: OFFICIAL_PAGE_SIZE,
    });
    const result = officialThreadListPageFromResponse(response);
    if (seen && (!object(response.result) || response.result.nextCursor === undefined)) {
      throw new ThreadSectionError("Incomplete official section order");
    }
    rows.push(...result.data);
    const next = result.nextCursor;
    if (next === null) return rows;
    if (seen) {
      if (!next || seen.has(next))
        throw new ThreadSectionError("Incomplete official section order");
      seen.add(next);
    } else if (next === cursor) return rows;
    cursor = next;
  }
  throw new Error("Official thread/list pagination exceeded its request bound");
}

async function officialSectionOrder(input: {
  sectionId: string;
  requestOfficial: OfficialRequest;
  requireComplete?: boolean;
}): Promise<string[]> {
  const rows = await listAllOfficialRows(
    input.requestOfficial,
    {
      sectionId: input.sectionId,
      sortKey: "section_position",
      modelProviders: [],
      useStateDbOnly: true,
      ...(input.requireComplete ? { sortDirection: "asc" } : {}),
    },
    input.requireComplete,
  );
  const officialIds = rows.map((row) => String(row.id));
  if (
    input.requireComplete &&
    (rows.some((row) => typeof row.id !== "string" || !row.id) ||
      new Set(officialIds).size !== officialIds.length)
  )
    throw new ThreadSectionError("Invalid official section members");
  return officialIds;
}

/** Current merged order of one section, as Codex Desktop lists it. */
export async function sectionOrder(input: {
  sectionId: string;
  placements: readonly StoredSectionPlacementV1[];
  requestOfficial: OfficialRequest;
  requireComplete?: boolean;
}): Promise<string[]> {
  return mergeSectionOrder(
    await officialSectionOrder(input),
    input.placements.filter((placement) => placement.section.id === input.sectionId),
  );
}

function object(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function officialSectionDefinition(value: unknown): StoredThreadSection | null {
  if (
    !object(value) ||
    typeof value.id !== "string" ||
    !value.id ||
    typeof value.name !== "string" ||
    !value.name.trim()
  )
    return null;
  const appearance = value.appearance;
  if (appearance != null && !object(appearance)) return null;
  const icon = appearance?.icon ?? null;
  const color = appearance?.color ?? null;
  if ((icon !== null && typeof icon !== "string") || (color !== null && typeof color !== "string"))
    return null;
  return {
    id: value.id,
    name: value.name,
    appearance: appearance ? { icon, color } : null,
  };
}

/** The last complete definition set, with a confirmed write layered over it until refreshed. */
export class SectionDefinitions {
  #complete: ReadonlyMap<string, StoredThreadSection> | undefined;
  readonly #confirmed = new Map<string, StoredThreadSection | null>();

  constructor(private readonly pinnedSectionId: string) {}

  replace(definitions: ReadonlyMap<string, StoredThreadSection>): void {
    this.#complete = definitions;
    this.#confirmed.clear();
  }

  confirm(sectionId: string, section: StoredThreadSection | null): void {
    this.#confirmed.set(sectionId, section);
  }

  project(
    placements: StoredSectionPlacementV1[],
    complete = this.#complete,
  ): StoredSectionPlacementV1[] {
    let next: StoredSectionPlacementV1[] | undefined;
    for (const [index, placement] of placements.entries()) {
      const { section } = placement;
      const confirmed = complete === this.#complete ? this.#confirmed.get(section.id) : undefined;
      const current = confirmed !== undefined ? confirmed : complete?.get(section.id);
      if (
        section.id !== this.pinnedSectionId &&
        (current === null || (current === undefined && complete))
      ) {
        next ??= placements.slice(0, index);
      } else if (current && !sameSectionDefinition(section, current)) {
        next ??= placements.slice(0, index);
        next.push({ ...placement, section: current });
      } else {
        next?.push(placement);
      }
    }
    return next ?? placements;
  }
}

function sameSectionDefinition(left: StoredThreadSection, right: StoredThreadSection): boolean {
  return (
    left.name === right.name &&
    (left.appearance === null) === (right.appearance === null) &&
    left.appearance?.icon === right.appearance?.icon &&
    left.appearance?.color === right.appearance?.color
  );
}

/** Both projections use the same current placements, so only section fields can differ. */
export function sameProjectedSections(
  before: readonly StoredSectionPlacementV1[],
  after: readonly StoredSectionPlacementV1[],
): boolean {
  return (
    before === after ||
    (before.length === after.length &&
      before.every((placement, index) => {
        const next = after[index];
        return (
          next !== undefined &&
          (placement === next ||
            (placement.hostThreadId === next.hostThreadId &&
              placement.section.id === next.section.id &&
              sameSectionDefinition(placement.section, next.section)))
        );
      }))
  );
}

/** List native section definitions in their official order, across pages. */
export async function* officialThreadSections(
  requestOfficial: OfficialRequest,
): AsyncGenerator<StoredThreadSection> {
  let cursor: string | null = null;
  const seen = new Set<string>();
  const cursors = new Set<string>();
  for (let page = 0; page < MAX_OFFICIAL_PAGES; page += 1) {
    const response = await requestOfficial("threadSection/list", {
      cursor,
      limit: OFFICIAL_PAGE_SIZE,
    });
    const result = response.result;
    if (
      !object(result) ||
      !Array.isArray(result.data) ||
      (result.nextCursor !== null && typeof result.nextCursor !== "string")
    ) {
      throw new Error("Invalid official threadSection/list response");
    }
    for (const entry of result.data) {
      const section = officialSectionDefinition(entry);
      if (!section || seen.has(section.id))
        throw new Error("Invalid or duplicate official Thread section");
      seen.add(section.id);
      yield section;
    }
    const next = result.nextCursor;
    if (next === null) return;
    if (!next || cursors.has(next))
      throw new Error("Official Thread section pagination did not advance");
    cursors.add(next);
    cursor = next;
  }
  throw new Error("Official Thread section pagination exceeded its request bound");
}

/** The official definition of a section, which External placements copy. */
export async function findOfficialSection(
  requestOfficial: OfficialRequest,
  sectionId: string,
): Promise<StoredThreadSection> {
  for await (const section of officialThreadSections(requestOfficial)) {
    if (section.id === sectionId) return section;
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
  | { kind: "forward" }
  | { kind: "unchanged" }
  /** Legacy native moves report native success even if External anchors could not be saved. */
  | { kind: "moved"; persistError?: unknown }
  | {
      kind: "partial";
      persistError: unknown;
      /** Under the owner's section lock, use fresh placements. False means recovery is unsafe. */
      recover(placements: readonly StoredSectionPlacementV1[]): Promise<boolean>;
    }
  | { kind: "error"; error: JsonObject };

function officialError(response: JsonObject): JsonObject | null {
  const error = response.error;
  return typeof error === "object" && error !== null && !Array.isArray(error) ? error : null;
}

function sameSectionAnchors(
  actual: readonly StoredSectionPlacementV1[],
  expected: readonly StoredSectionPlacementV1[],
): boolean {
  return (
    actual.length === expected.length &&
    actual.every((placement, index) => {
      const original = expected[index];
      return (
        original !== undefined &&
        placement.hostThreadId === original.hostThreadId &&
        placement.section.id === original.section.id &&
        placement.enteredAt === original.enteredAt &&
        placement.beforeThreadId === original.beforeThreadId
      );
    })
  );
}

function sectionAnchorRecovery(input: {
  expectedNativeOrders: ReadonlyMap<string, readonly string[]>;
  unsectionedThreadId: string | null;
  previous: readonly StoredSectionPlacementV1[];
  planned: readonly StoredSectionPlacementV1[];
  requestOfficial: OfficialRequest;
  savePlacements(placements: StoredSectionPlacementV1[]): Promise<unknown>;
}): (placements: readonly StoredSectionPlacementV1[]) => Promise<boolean> {
  const { expectedNativeOrders, unsectionedThreadId, requestOfficial, savePlacements } = input;
  const affected = (placement: StoredSectionPlacementV1) =>
    expectedNativeOrders.has(placement.section.id);
  const previous = input.previous.filter(affected);
  const planned = input.planned.filter(affected);
  return async (placements) => {
    const current = placements.filter(affected);
    const alreadyApplied = sameSectionAnchors(current, planned);
    if (!alreadyApplied && !sameSectionAnchors(current, previous)) return false;
    for (const [sectionId, expected] of expectedNativeOrders) {
      const actual = await officialSectionOrder({
        sectionId,
        requestOfficial,
        requireComplete: true,
      });
      if (actual.length !== expected.length || actual.some((id, index) => id !== expected[index])) {
        return false;
      }
    }
    if (unsectionedThreadId !== null) {
      const response = await requestOfficial("thread/read", {
        threadId: unsectionedThreadId,
        includeTurns: false,
      });
      const thread = object(response.result) ? response.result.thread : undefined;
      if (officialError(response) || !object(thread) || thread.id !== unsectionedThreadId) {
        throw new ThreadSectionError("Could not confirm the moved Thread's section");
      }
      if (thread.section !== null) return false;
    }
    if (alreadyApplied) return true;
    const anchors = new Map(
      planned.map((placement) => [placement.hostThreadId, placement.beforeThreadId]),
    );
    const next: StoredSectionPlacementV1[] = [];
    for (const placement of placements) {
      if (!affected(placement)) {
        next.push(placement);
        continue;
      }
      const beforeThreadId = anchors.get(placement.hostThreadId);
      if (beforeThreadId !== undefined) next.push({ ...placement, beforeThreadId });
    }
    await savePlacements(next);
    return true;
  };
}

/**
 * Applies one `thread/section/move`. An official move that touches no External placement is
 * forwarded unchanged. An exact custom move may only need to save External anchors.
 */
export async function moveThreadSection(input: {
  move: DecodedThreadSectionMoveRequest;
  custom?: { currentSectionId: string | null; destination?: StoredThreadSection };
  movingExternal: boolean;
  externalThreadIds: ReadonlySet<string>;
  placements: readonly StoredSectionPlacementV1[];
  requestOfficial: OfficialRequest;
  savePlacements(placements: StoredSectionPlacementV1[]): Promise<unknown>;
  now: Date;
}): Promise<SectionMoveOutcome> {
  const { move, requestOfficial, custom } = input;
  const isExternal = (threadId: string) => input.externalThreadIds.has(threadId);
  if (
    !custom &&
    !input.movingExternal &&
    input.placements.length === 0 &&
    !(move.beforeThreadId !== null && isExternal(move.beforeThreadId))
  ) {
    return { kind: "forward" };
  }
  try {
    let currentSectionId: string | null;
    let destination: StoredThreadSection | null = null;
    if (custom) {
      currentSectionId = custom.currentSectionId;
      if (move.sectionId !== null)
        destination =
          custom.destination ?? (await findOfficialSection(requestOfficial, move.sectionId));
    } else if (input.movingExternal) {
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
    const nativeOrders = custom && !input.movingExternal ? new Map<string, string[]>() : undefined;
    for (const sectionId of new Set([currentSectionId, move.sectionId])) {
      if (sectionId === null) continue;
      const native = await officialSectionOrder({
        sectionId,
        requestOfficial,
        requireComplete: custom !== undefined,
      });
      nativeOrders?.set(sectionId, native);
      orders.set(
        sectionId,
        mergeSectionOrder(
          native,
          input.placements.filter((placement) => placement.section.id === sectionId),
        ),
      );
    }
    if (custom && currentSectionId !== null) {
      const order = orders.get(currentSectionId) ?? [];
      const index = order.indexOf(move.threadId);
      if (index < 0) throw new ThreadSectionError("Moved Thread is missing from the section order");
      if (currentSectionId === move.sectionId) {
        if (move.beforeThreadId !== null && !order.includes(move.beforeThreadId)) {
          throw new ThreadSectionError(
            `before thread ${move.beforeThreadId} is not in section ${move.sectionId}`,
          );
        }
        if ((order[index + 1] ?? null) === move.beforeThreadId) return { kind: "unchanged" };
      }
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
    if (input.movingExternal) {
      await input.savePlacements(plan.placements);
      return { kind: "moved" };
    }
    const currentNativeOrder =
      currentSectionId === null ? undefined : nativeOrders?.get(currentSectionId);
    const currentIndex = currentNativeOrder?.indexOf(move.threadId) ?? -1;
    const nativeMove =
      !nativeOrders ||
      currentSectionId !== move.sectionId ||
      (currentSectionId !== null &&
        (currentIndex < 0 ||
          (currentNativeOrder?.[currentIndex + 1] ?? null) !== plan.officialBeforeThreadId));
    if (nativeMove) {
      const response = await requestOfficial("thread/section/move", {
        threadId: move.threadId,
        sectionId: move.sectionId,
        beforeThreadId: plan.officialBeforeThreadId,
      });
      const error = officialError(response);
      if (error) return { kind: "error", error };
    }
    if (nativeOrders && sameSectionAnchors(input.placements, plan.placements)) {
      return { kind: nativeMove ? "moved" : "unchanged" };
    }
    try {
      await input.savePlacements(plan.placements);
    } catch (persistError) {
      if (!nativeMove) throw persistError;
      if (!nativeOrders) return { kind: "moved", persistError };

      // Recovery is valid only while both owners still reflect this move's inputs and native result.
      for (const [sectionId, order] of nativeOrders) {
        const current = order.indexOf(move.threadId);
        if (current >= 0) order.splice(current, 1);
        if (sectionId === move.sectionId) {
          const before = plan.officialBeforeThreadId;
          order.splice(before === null ? order.length : order.indexOf(before), 0, move.threadId);
        }
      }
      return {
        kind: "partial",
        persistError,
        recover: sectionAnchorRecovery({
          expectedNativeOrders: nativeOrders,
          unsectionedThreadId: move.sectionId === null ? move.threadId : null,
          previous: input.placements,
          planned: plan.placements,
          requestOfficial,
          savePlacements: input.savePlacements,
        }),
      };
    }
    return { kind: "moved" };
  } catch (error) {
    if (error instanceof ThreadSectionError)
      return { kind: "error", error: { code: -32600, message: error.message } };
    if (error instanceof OfficialThreadListError) return { kind: "error", error: error.rpcError };
    throw error;
  }
}
