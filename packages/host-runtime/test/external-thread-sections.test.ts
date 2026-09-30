import type { StoredSectionPlacementV1 } from "@codexhost/mapping-store";
import { decodeThreadListRequest, type JsonObject } from "@codexhost/protocol-core";
import { describe, expect, it } from "vitest";

import {
  listSectionThreads,
  mergeSectionOrder,
  moveThreadSection,
} from "../src/external-thread-sections.js";

const PINNED = "01984de2-8f74-7c91-a3b2-5c5e937cf318";
const CUSTOM = "019b0000-0000-7000-8000-00000000c0de";

/** In-memory official app-server that owns section definitions and official Thread order. */
class OfficialSections {
  readonly sections = new Map<string, string[]>([
    [PINNED, []],
    [CUSTOM, []],
  ]);
  readonly requests: { method: string; params: JsonObject }[] = [];

  sectionOf(threadId: string): string | null {
    for (const [id, order] of this.sections) if (order.includes(threadId)) return id;
    return null;
  }

  request = async (method: string, params: JsonObject): Promise<JsonObject> => {
    this.requests.push({ method, params });
    if (method === "threadSection/list") {
      return {
        result: {
          data: [
            { id: PINNED, name: "Pinned", appearance: null },
            { id: CUSTOM, name: "Custom", appearance: { icon: "star", color: null } },
          ],
          nextCursor: null,
        },
      };
    }
    if (method === "thread/read") {
      const threadId = String(params.threadId);
      const sectionId = this.sectionOf(threadId);
      return {
        result: {
          thread: {
            id: threadId,
            section: sectionId ? { id: sectionId, name: "", appearance: null } : null,
          },
        },
      };
    }
    if (method === "thread/list") {
      const order = this.sections.get(String(params.sectionId)) ?? [];
      const rows = order.map((id) => ({ id }));
      if (params.sortDirection === "desc") rows.reverse();
      return { result: { data: rows, nextCursor: null, backwardsCursor: null } };
    }
    if (method === "thread/section/move") {
      const threadId = String(params.threadId);
      const sectionId = params.sectionId as string | null;
      const before = (params.beforeThreadId as string | null | undefined) ?? null;
      if (sectionId !== null && !this.sections.has(sectionId)) {
        return { error: { code: -32600, message: `section ${sectionId} does not exist` } };
      }
      const target = sectionId === null ? null : (this.sections.get(sectionId) ?? []);
      if (target && before !== null && !target.includes(before)) {
        return {
          error: {
            code: -32600,
            message: `before thread ${before} is not in section ${sectionId}`,
          },
        };
      }
      for (const order of this.sections.values()) {
        const index = order.indexOf(threadId);
        if (index >= 0) order.splice(index, 1);
      }
      if (target) {
        const index = before === null ? target.length : target.indexOf(before);
        target.splice(index, 0, threadId);
      }
      return { result: {} };
    }
    throw new Error(`Unexpected official request ${method}`);
  };
}

class Harness {
  readonly official = new OfficialSections();
  placements: StoredSectionPlacementV1[] = [];
  /** Reference model: what every section should show, in order. */
  readonly expected = new Map<string, string[]>([
    [PINNED, []],
    [CUSTOM, []],
  ]);
  clock = 1_790_000_000_000;

  constructor(readonly externalIds: ReadonlySet<string>) {}

  merged(sectionId: string): string[] {
    return mergeSectionOrder(
      this.official.sections.get(sectionId) ?? [],
      this.placements.filter((placement) => placement.section.id === sectionId),
    );
  }

  async move(threadId: string, sectionId: string | null, beforeThreadId: string | null = null) {
    this.clock += 1_000;
    const outcome = await moveThreadSection({
      move: { threadId, sectionId, beforeThreadId },
      movingExternal: this.externalIds.has(threadId),
      externalThreadIds: this.externalIds,
      placements: this.placements,
      requestOfficial: this.official.request,
      savePlacements: async (next) => {
        this.placements = next;
      },
      now: new Date(this.clock),
    });
    if (outcome.kind === "forward") {
      const response = await this.official.request("thread/section/move", {
        threadId,
        sectionId,
        beforeThreadId,
      });
      if (response.error) return { kind: "error" as const, error: response.error as JsonObject };
      return { kind: "moved" as const };
    }
    return outcome;
  }

  applyExpected(threadId: string, sectionId: string | null, before: string | null) {
    for (const order of this.expected.values()) {
      const index = order.indexOf(threadId);
      if (index >= 0) order.splice(index, 1);
    }
    if (sectionId === null) return;
    const target = this.expected.get(sectionId);
    if (!target) throw new Error("unknown section");
    target.splice(before === null ? target.length : target.indexOf(before), 0, threadId);
  }
}

describe("External Thread sections", () => {
  it("pins an External Thread with the official section definition", async () => {
    const harness = new Harness(new Set(["ext-a"]));
    await expect(harness.move("ext-a", PINNED)).resolves.toEqual({ kind: "moved" });
    expect(harness.placements).toEqual([
      {
        hostThreadId: "ext-a",
        section: { id: PINNED, name: "Pinned", appearance: null },
        enteredAt: new Date(harness.clock).toISOString(),
        beforeThreadId: null,
      },
    ]);
    // External Threads never reach the official move.
    expect(harness.official.requests.map((request) => request.method)).not.toContain(
      "thread/section/move",
    );
    await expect(harness.move("ext-a", null)).resolves.toEqual({ kind: "moved" });
    expect(harness.placements).toEqual([]);
  });

  it("mirrors official section errors", async () => {
    const harness = new Harness(new Set(["ext-a", "ext-b"]));
    await expect(harness.move("ext-a", "019b0000-0000-7000-8000-00000000dead")).resolves.toEqual({
      kind: "error",
      error: {
        code: -32600,
        message: "section 019b0000-0000-7000-8000-00000000dead does not exist",
      },
    });
    await expect(harness.move("ext-a", PINNED, "ext-b")).resolves.toEqual({
      kind: "error",
      error: { code: -32600, message: `before thread ext-b is not in section ${PINNED}` },
    });
    expect(harness.placements).toEqual([]);
  });

  it("forwards official moves unchanged while no External Thread is placed", async () => {
    const harness = new Harness(new Set(["ext-a"]));
    const outcome = await moveThreadSection({
      move: { threadId: "off-1", sectionId: PINNED, beforeThreadId: null },
      movingExternal: false,
      externalThreadIds: harness.externalIds,
      placements: [],
      requestOfficial: harness.official.request,
      savePlacements: async () => undefined,
      now: new Date(),
    });
    expect(outcome).toEqual({ kind: "forward" });
    expect(harness.official.requests).toEqual([]);
  });

  it("reports an applied official move even when External anchors cannot be saved", async () => {
    const harness = new Harness(new Set(["ext-a"]));
    await harness.move("ext-a", PINNED);
    const failure = new Error("disk full");
    const move = (threadId: string, movingExternal: boolean) =>
      moveThreadSection({
        move: { threadId, sectionId: PINNED, beforeThreadId: null },
        movingExternal,
        externalThreadIds: harness.externalIds,
        placements: harness.placements,
        requestOfficial: harness.official.request,
        savePlacements: () => Promise.reject(failure),
        now: new Date(),
      });
    await expect(move("off-1", false)).resolves.toEqual({ kind: "moved", persistError: failure });
    expect(harness.official.sections.get(PINNED)).toEqual(["off-1"]);
    // An External move changed nothing yet, so its persistence failure is a real failure.
    await expect(move("ext-a", true)).rejects.toBe(failure);
  });

  it("keeps entry time when a Thread is reordered inside its section", async () => {
    const harness = new Harness(new Set(["ext-a", "ext-b"]));
    await harness.move("ext-a", PINNED);
    const enteredAt = harness.placements[0]?.enteredAt;
    await harness.move("ext-b", PINNED);
    await harness.move("ext-b", PINNED, "ext-a");
    expect(harness.merged(PINNED)).toEqual(["ext-b", "ext-a"]);
    expect(harness.placements.find((p) => p.hostThreadId === "ext-a")?.enteredAt).toBe(enteredAt);
  });

  it("interleaves official and External Threads exactly like one shared order", async () => {
    const official = ["off-1", "off-2", "off-3", "off-4"];
    const external = ["ext-a", "ext-b", "ext-c", "ext-d"];
    const all = [...official, ...external];
    const sections = [PINNED, CUSTOM, null] as const;
    // mulberry32: deterministic and well mixed in its low bits.
    let seed = 7;
    const random = (limit: number) => {
      seed = (seed + 0x6d2b79f5) | 0;
      let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
      return ((value ^ (value >>> 14)) >>> 0) % limit;
    };
    for (let run = 0; run < 40; run += 1) {
      const harness = new Harness(new Set(external));
      for (let step = 0; step < 30; step += 1) {
        const threadId = all[random(all.length)] as string;
        const sectionId = sections[random(sections.length)] ?? null;
        let before: string | null = null;
        if (sectionId !== null) {
          const candidates = (harness.expected.get(sectionId) ?? []).filter(
            (id) => id !== threadId,
          );
          const pick = random(candidates.length + 1);
          before = candidates[pick] ?? null;
        }
        const outcome = await harness.move(threadId, sectionId, before);
        expect(outcome, `run ${run} step ${step}`).toEqual({ kind: "moved" });
        harness.applyExpected(threadId, sectionId, before);
        for (const id of [PINNED, CUSTOM]) {
          expect(harness.merged(id), `run ${run} step ${step} ${id}`).toEqual(
            harness.expected.get(id),
          );
        }
      }
    }
  });

  it("merges External rows into a paginated section_position list", async () => {
    const harness = new Harness(new Set(["ext-a", "ext-b"]));
    await harness.move("off-1", PINNED);
    await harness.move("ext-a", PINNED, "off-1");
    await harness.move("off-2", PINNED);
    await harness.move("ext-b", PINNED);
    const query = decodeThreadListRequest({
      id: 1,
      method: "thread/list",
      params: { sectionId: PINNED, sortKey: "section_position", limit: 3 },
    });
    if (!query) throw new Error("query");
    const externalRows = new Map<string, JsonObject>([
      ["ext-a", { id: "ext-a", modelProvider: "codexhost" }],
      ["ext-b", { id: "ext-b", modelProvider: "codexhost" }],
    ]);
    const first = await listSectionThreads({
      query,
      placements: harness.placements,
      externalRows,
      requestOfficial: harness.official.request,
    });
    expect(first?.data.map((row) => row.id)).toEqual(["ext-a", "off-1", "off-2"]);
    expect(first?.nextCursor).toEqual(expect.stringContaining("codexhost:thread-section-list"));

    const next = decodeThreadListRequest({
      id: 2,
      method: "thread/list",
      params: {
        sectionId: PINNED,
        sortKey: "section_position",
        limit: 3,
        cursor: first?.nextCursor ?? null,
      },
    });
    if (!next) throw new Error("query");
    const second = await listSectionThreads({
      query: next,
      placements: harness.placements,
      externalRows,
      requestOfficial: harness.official.request,
    });
    expect(second).toEqual({
      data: [{ id: "ext-b", modelProvider: "codexhost" }],
      nextCursor: null,
      backwardsCursor: null,
    });

    const descending = decodeThreadListRequest({
      id: 3,
      method: "thread/list",
      params: { sectionId: PINNED, sortKey: "section_position", sortDirection: "desc" },
    });
    if (!descending) throw new Error("query");
    const reversed = await listSectionThreads({
      query: descending,
      placements: harness.placements,
      externalRows,
      requestOfficial: harness.official.request,
    });
    expect(reversed?.data.map((row) => row.id)).toEqual(["ext-b", "off-2", "off-1", "ext-a"]);
  });

  it("leaves a section list official when no listed External Thread is placed there", async () => {
    const harness = new Harness(new Set(["ext-a"]));
    await harness.move("ext-a", CUSTOM);
    const query = decodeThreadListRequest({
      id: 1,
      method: "thread/list",
      params: { sectionId: PINNED, sortKey: "section_position" },
    });
    if (!query) throw new Error("query");
    await expect(
      listSectionThreads({
        query,
        placements: harness.placements,
        externalRows: new Map(),
        requestOfficial: harness.official.request,
      }),
    ).resolves.toBeNull();
  });

  it("keeps a placement whose anchor left the section", () => {
    const placement = (hostThreadId: string, beforeThreadId: string | null) =>
      ({
        hostThreadId,
        section: { id: PINNED, name: "Pinned", appearance: null },
        enteredAt: new Date(0).toISOString(),
        beforeThreadId,
      }) as StoredSectionPlacementV1;
    expect(
      mergeSectionOrder(
        ["off-1"],
        [placement("ext-a", "gone"), placement("ext-b", "ext-c"), placement("ext-c", "ext-b")],
      ),
    ).toEqual(["off-1", "ext-a", "ext-b", "ext-c"]);
  });
});
