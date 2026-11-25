import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { MappingStore } from "@codexhost/mapping-store";
import type { JsonObject } from "@codexhost/protocol-core";
import { describe, expect, it } from "vitest";

import { OfficialRuntimeScope } from "../src/codex-runtime/official-runtime-scope.js";
import { DelegationControlRegistry } from "../src/delegation-control-registry.js";
import type { ThreadListInput } from "../src/delegation-types.js";
import type {
  OfficialAppServerConnection,
  OfficialAppServerExit,
} from "../src/official-app-server-connection.js";
import {
  closeFixture,
  createFixture,
  startPiThread,
  writeRequest,
} from "./app-server-host-fixture.js";

interface NativeRow {
  id: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  recencyAt: number;
}

const row = (id: string, time: number, cwd = "/synthetic"): NativeRow => ({
  id,
  cwd,
  createdAt: time,
  updatedAt: time,
  recencyAt: time,
});
const query = { cwd: "/synthetic", limit: 2, sort: "created-desc" as const };

function nativePage(rows: NativeRow[], params: JsonObject): JsonObject {
  const field =
    params.sortKey === "created_at"
      ? "createdAt"
      : params.sortKey === "updated_at"
        ? "updatedAt"
        : "recencyAt";
  const direction = params.sortDirection === "asc" ? 1 : -1;
  const compare = (left: NativeRow, right: NativeRow) =>
    (left[field] - right[field]) * direction || left.id.localeCompare(right.id);
  const anchor =
    typeof params.cursor === "string"
      ? (JSON.parse(Buffer.from(params.cursor, "base64url").toString()) as NativeRow)
      : null;
  const matches = rows
    .filter((entry) => !Array.isArray(params.cwd) || params.cwd.includes(entry.cwd))
    .sort(compare)
    .filter((entry) => !anchor || compare(entry, anchor) > 0);
  const data = matches.slice(0, Number(params.limit));
  const last = data.at(-1);
  return {
    data: data.map((entry) => ({ ...entry, status: { type: "idle" } })),
    nextCursor:
      last && data.length < matches.length
        ? Buffer.from(JSON.stringify(last)).toString("base64url")
        : null,
    backwardsCursor: null,
  };
}

/** Real Hosts, repository aggregation and one native keyset backend per source. */
async function fixture(
  sources: { rows: NativeRow[] }[],
  options: { sharedBackend?: boolean; catalog?: boolean } = {},
) {
  const directory = mkdtempSync(path.join(tmpdir(), "codexhost-list-paging-"));
  const store = new MappingStore({ directory });
  await store.initialize();
  const requests: JsonObject[] = [];
  const scopes = (options.sharedBackend ? sources.slice(0, 1) : sources).map((source) => {
    const backendClosed = Promise.withResolvers<OfficialAppServerExit>();
    const connections = new Set<OfficialAppServerConnection>();
    return new OfficialRuntimeScope({
      permanentHome: directory,
      diagnosticOutput: new PassThrough(),
      createBackend: () => ({
        closed: backendClosed.promise,
        async start() {},
        async connect() {
          const stdin = new PassThrough();
          const stdout = new PassThrough();
          const stderr = new PassThrough();
          const closed = Promise.withResolvers<OfficialAppServerExit>();
          let buffer = "";
          stdin.on("data", (chunk: Buffer) => {
            buffer += chunk.toString();
            let newline: number;
            while ((newline = buffer.indexOf("\n")) >= 0) {
              const line = buffer.slice(0, newline);
              buffer = buffer.slice(newline + 1);
              if (!line) continue;
              const request = JSON.parse(line) as JsonObject;
              if (request.id === undefined) continue;
              let result: JsonObject = {};
              if (request.method === "thread/list") {
                const params = request.params as JsonObject;
                requests.push(params);
                result = nativePage(source.rows, params);
              }
              stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
            }
          });
          const connection: OfficialAppServerConnection = {
            stdin,
            stdout,
            stderr,
            closed: closed.promise,
            close() {
              stdin.end();
              stdout.end();
              stderr.end();
              closed.resolve({ code: 0, signal: null });
              connections.delete(connection);
            },
          };
          connections.add(connection);
          return connection;
        },
        async stop() {
          for (const connection of [...connections]) connection.close();
          backendClosed.resolve({ code: 0, signal: null });
        },
      }),
    });
  });
  const registry = new DelegationControlRegistry();
  const hosts = sources.map((_, index) => {
    const scope = scopes[options.sharedBackend ? 0 : index];
    if (!scope) throw new Error("Missing test backend");
    return createFixture({
      mappingStore: store,
      mappingStoreDirectory: directory,
      closeMappingStoreOnExit: false,
      officialRuntimeScope: scope,
      onDelegationApi: (api) =>
        registry.register(api, { harnessCatalog: options.catalog === true && index === 0 }),
    });
  });
  await Promise.all(
    hosts.map(async (host) => {
      await host.ready;
      writeRequest(host.desktopInput, {
        id: "paging-initialize",
        method: "initialize",
        params: { clientInfo: { name: "paging-test", version: "1" } },
      });
      const initialized = await host.collector.waitFor(
        (message) => message.id === "paging-initialize",
      );
      expect(initialized).not.toHaveProperty("error");
    }),
  );
  return {
    registry,
    hosts,
    requests,
    async close() {
      registry.close();
      for (const host of hosts) await closeFixture(host);
      for (const scope of scopes) await scope.close();
      await store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

async function allPages(registry: DelegationControlRegistry, input: ThreadListInput) {
  const ids: string[] = [];
  let cursor: string | undefined;
  let count = 0;
  do {
    const page = await registry.list({ ...input, ...(cursor ? { cursor } : {}) });
    ids.push(...page.threads.map((entry) => entry.threadId));
    cursor = page.nextCursor ?? undefined;
    expect(++count).toBeLessThan(100);
  } while (cursor);
  return ids;
}

describe("delegation Thread list native pagination", () => {
  it("uses one catalog for shared Remote Control backends, including external Threads", async () => {
    const source = { rows: [row("native100", 100), row("native90", 90), row("native80", 80)] };
    const f = await fixture([source, source], { sharedBackend: true, catalog: true });
    try {
      const attached = f.hosts[1];
      if (!attached) throw new Error("Missing attached Host");
      const externalId = await startPiThread(attached);
      const ids = await allPages(f.registry, query);
      expect(ids).toEqual([externalId, "native100", "native90", "native80"]);
      expect(new Set(ids).size).toBe(ids.length);
      expect(f.requests.every((params) => Number(params.limit) <= query.limit)).toBe(true);
    } finally {
      await f.close();
    }
  });

  it.each(["insert", "delete"] as const)(
    "continues after the last emitted native row when a prior prefix changes: %s",
    async (mutation) => {
      const a = { rows: [row("a100", 100), row("a80", 80), row("a60", 60)] };
      const b = { rows: [row("b90", 90), row("b70", 70), row("b50", 50)] };
      const f = await fixture([a, b]);
      try {
        const first = await f.registry.list(query);
        expect(first.threads.map((entry) => entry.threadId)).toEqual(["a100", "b90"]);
        if (mutation === "insert") a.rows.unshift(row("a110", 110));
        else a.rows = a.rows.filter((entry) => entry.id !== "a100");
        expect(first.nextCursor).not.toBeNull();
        const second = await f.registry.list({ ...query, cursor: first.nextCursor ?? "" });
        expect(second.threads.map((entry) => entry.threadId)).toEqual(["a80", "b70"]);
        const last = await f.registry.list({ ...query, cursor: second.nextCursor ?? "" });
        expect(last.threads.map((entry) => entry.threadId)).toEqual(["a60", "b50"]);
        expect(last.nextCursor).toBeNull();
        expect(f.requests.every((params) => params.limit === 1)).toBe(true);
      } finally {
        await f.close();
      }
    },
  );

  it("does not cache an unreturned candidate across requests", async () => {
    const a = { rows: [row("a100", 100), row("a80", 80)] };
    const b = { rows: [row("b90", 90), row("b70", 70)] };
    const f = await fixture([a, b]);
    try {
      const first = await f.registry.list({ ...query, limit: 1 });
      expect(first.threads.map((entry) => entry.threadId)).toEqual(["a100"]);
      b.rows = b.rows.filter((entry) => entry.id !== "b90");
      const next = await f.registry.list({ ...query, cursor: first.nextCursor ?? "" });
      expect(next.threads.map((entry) => entry.threadId)).toEqual(["a80", "b70"]);
      expect(next.nextCursor).toBeNull();
    } finally {
      await f.close();
    }
  });

  it("retains native live-list semantics when an emitted row's sort key moves behind its cursor", async () => {
    const emitted = row("a100", 100);
    const f = await fixture([
      { rows: [emitted, row("a80", 80), row("a60", 60)] },
      { rows: [row("b90", 90), row("b70", 70)] },
    ]);
    try {
      const first = await f.registry.list({ ...query, sort: "updated-desc" });
      expect(first.threads.map((entry) => entry.threadId)).toEqual(["a100", "b90"]);
      emitted.updatedAt = 75;
      const next = await f.registry.list({
        ...query,
        sort: "updated-desc",
        cursor: first.nextCursor ?? "",
      });
      // The backend itself revisits a moved row; the Host does not invent a snapshot or seen-ID set.
      expect(next.threads.map((entry) => entry.threadId)).toEqual(["a80", "a100"]);
    } finally {
      await f.close();
    }
  });

  it("rejects cwd changes before reading any source, but allows changing limit", async () => {
    const f = await fixture([
      { rows: [row("a100", 100), row("a80", 80), row("a300", 300, "/different")] },
      { rows: [row("b90", 90), row("b70", 70), row("b290", 290, "/different")] },
    ]);
    try {
      const first = await f.registry.list(query);
      const before = f.requests.length;
      await expect(
        f.registry.list({ ...query, cwd: "/different", cursor: first.nextCursor ?? "" }),
      ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
      expect(f.requests).toHaveLength(before);
      const next = await f.registry.list({ ...query, limit: 1, cursor: first.nextCursor ?? "" });
      expect(next.threads.map((entry) => entry.threadId)).toEqual(["a80"]);
    } finally {
      await f.close();
    }
  });

  it.each<ThreadListInput["sort"]>([
    "created-asc",
    "created-desc",
    "updated-asc",
    "updated-desc",
    "recency-asc",
    "recency-desc",
  ])("preserves %s order through real Host aggregation", async (sort) => {
    const rows = Array.from({ length: 12 }, (_, index) => ({
      ...row(`thread-${index}`, 100 + index),
      updatedAt: 200 - index,
      recencyAt: 300 + ((index * 7) % 13),
    }));
    const f = await fixture([
      { rows: rows.filter((_, index) => index % 2 === 0) },
      { rows: rows.filter((_, index) => index % 2 === 1) },
      { rows: [] },
    ]);
    try {
      const field = sort.startsWith("created")
        ? "createdAt"
        : sort.startsWith("updated")
          ? "updatedAt"
          : "recencyAt";
      const expected = [...rows].sort(
        (a, b) => (a[field] - b[field]) * (sort.endsWith("asc") ? 1 : -1),
      );
      expect(await allPages(f.registry, { ...query, sort, limit: 3 })).toEqual(
        expected.map((entry) => entry.id),
      );
    } finally {
      await f.close();
    }
  });
});
