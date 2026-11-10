import type { JsonObject } from "@codexhost/protocol-core";
import {
  THREAD_CATALOG_READ_METHOD,
  threadCatalogReadResultSchema,
} from "@codexhost/shared-contracts";
import { afterEach, expect, it, vi } from "vitest";
import { OfficialRuntimeClient } from "../src/codex-runtime/official-runtime-scope.js";
import { OfficialAdmissionError } from "../src/codex-runtime/official-work-gate.js";
import { createFixture, stopFixture, writeRequest } from "./app-server-host-fixture.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0)) await close();
});

it("routes the public catalog through existing client and Desktop/CDP entry points and validates params", async () => {
  const fixture = createFixture();
  cleanup.push(() => stopFixture(fixture));
  await fixture.ready;
  const request = vi.spyOn(OfficialRuntimeClient.prototype, "request").mockResolvedValue({
    result: { data: [{ id: "native", createdAt: 1, updatedAt: 1 }], nextCursor: null },
  });
  const reply = await fixture.host.handleClientRequest(THREAD_CATALOG_READ_METHOD, {});
  expect(reply).toHaveProperty("result");
  if (!("result" in reply)) throw new Error("Expected catalog");
  expect(threadCatalogReadResultSchema.parse(reply.result)).toEqual({
    threads: [{ id: "native", createdAt: 1, updatedAt: 1, turns: [] }],
    ownership: [{ threadId: "native", owner: "codex" }],
    archivedThreadIds: [],
    officialCursor: { live: null },
  });
  expect(request).toHaveBeenCalledExactlyOnceWith("thread/list", {
    archived: false,
    limit: 20,
    cursor: null,
    sortKey: "updated_at",
    sortDirection: "desc",
  });
  expect(fixture.spawnOfficial).toHaveBeenCalledTimes(1);
  await expect(
    fixture.host.handleClientRequest(THREAD_CATALOG_READ_METHOD, { includeArchived: "true" }),
  ).resolves.toMatchObject({ error: { code: -32602 } });
  await expect(
    fixture.host.handleClientRequest(THREAD_CATALOG_READ_METHOD, { cursor: "unsupported" }),
  ).resolves.toMatchObject({ error: { code: -32602 } });
  writeRequest(fixture.desktopInput, { id: 900, method: THREAD_CATALOG_READ_METHOD, params: {} });
  expect(await fixture.collector.waitFor((message) => message.id === 900)).toMatchObject({
    result: reply.result,
  });
  expect(request).toHaveBeenCalledTimes(2);
});

it("returns external-only metadata when lazy admission is explicitly unavailable", async () => {
  const fixture = createFixture({ externalOnly: true });
  cleanup.push(() => stopFixture(fixture));
  await vi.waitFor(async () => expect(await fixture.mappingStore.listThreads()).toEqual([]));
  const started = await fixture.host.handleClientRequest("thread/start", {
    model: "codexhost/pi-native",
    cwd: "/synthetic",
  });
  expect(started).toHaveProperty("result");
  if (!("result" in started)) throw new Error("Expected external Thread");
  const threadId = ((started.result as JsonObject).thread as JsonObject).id;
  const initialize = vi
    .spyOn(OfficialRuntimeClient.prototype, "initialize")
    .mockRejectedValue(new OfficialAdmissionError("unavailable"));
  const request = vi.spyOn(OfficialRuntimeClient.prototype, "request");
  const reply = await fixture.host.handleClientRequest(THREAD_CATALOG_READ_METHOD, {
    includeArchived: true,
  });
  expect(reply).toMatchObject({
    result: {
      threads: [{ id: threadId, turns: [] }],
      ownership: [{ threadId, owner: "external", harnessId: "pi" }],
      archivedThreadIds: [],
    },
  });
  expect(initialize).toHaveBeenCalledTimes(1);
  expect(await fixture.host.handleClientRequest("thread/archive", { threadId })).toHaveProperty(
    "result",
  );
  expect(await fixture.host.handleClientRequest(THREAD_CATALOG_READ_METHOD, {})).toMatchObject({
    result: { threads: [], ownership: [], archivedThreadIds: [threadId] },
  });
  expect(initialize).toHaveBeenCalledTimes(2);
  expect(fixture.spawnOfficial).not.toHaveBeenCalled();
  expect(request).not.toHaveBeenCalled();
});

it("lazily initializes the existing managed scope on a cold external Host and reuses it across catalog reads", async () => {
  const fixture = createFixture({ externalOnly: true });
  cleanup.push(() => stopFixture(fixture));
  const requests: JsonObject[] = [];
  let buffer = "";
  fixture.official.stdin.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const request = JSON.parse(buffer.slice(0, end)) as JsonObject;
      buffer = buffer.slice(end + 1);
      requests.push(request);
      if (request.id === undefined) continue;
      const archived = (request.params as JsonObject).archived === true;
      fixture.official.stdout.write(
        `${JSON.stringify({
          id: request.id,
          result:
            request.method === "thread/list"
              ? {
                  data: [
                    {
                      id: archived ? "native-archived" : "native",
                      createdAt: archived ? 1 : 2,
                      updatedAt: 3,
                    },
                  ],
                  nextCursor: null,
                }
              : {},
        })}\n`,
      );
    }
  });
  await vi.waitFor(async () => expect(await fixture.mappingStore.listThreads()).toEqual([]));
  expect(fixture.spawnOfficial).not.toHaveBeenCalled();
  expect(
    await fixture.host.handleClientRequest(THREAD_CATALOG_READ_METHOD, { includeArchived: true }),
  ).toMatchObject({
    result: {
      threads: [{ id: "native" }, { id: "native-archived" }],
      archivedThreadIds: ["native-archived"],
    },
  });
  expect(await fixture.host.handleClientRequest(THREAD_CATALOG_READ_METHOD, {})).toMatchObject({
    result: { threads: [{ id: "native" }], archivedThreadIds: [] },
  });
  expect(fixture.spawnOfficial).toHaveBeenCalledTimes(1);
  expect(requests.filter((request) => request.method === "initialize")).toHaveLength(1);
  expect(
    requests.filter((request) => request.method === "thread/list").map((request) => request.params),
  ).toEqual([
    { archived: false, cursor: null, limit: 20, sortKey: "updated_at", sortDirection: "desc" },
    { archived: true, cursor: null, limit: 20, sortKey: "updated_at", sortDirection: "desc" },
    { archived: false, cursor: null, limit: 20, sortKey: "updated_at", sortDirection: "desc" },
  ]);
});

it("preserves official RPC errors and fails unavailable, invalid, and thrown official requests instead of returning an empty catalog", async () => {
  const fixture = createFixture();
  cleanup.push(() => stopFixture(fixture));
  await fixture.ready;
  const request = vi
    .spyOn(OfficialRuntimeClient.prototype, "request")
    .mockResolvedValueOnce({
      error: { code: -32123, message: "native failure", data: { retryable: true } },
    })
    .mockRejectedValueOnce(new OfficialAdmissionError("unavailable"))
    .mockResolvedValueOnce({ result: { data: "invalid" } })
    .mockRejectedValueOnce(new Error("native request failed"));
  expect(await fixture.host.handleClientRequest(THREAD_CATALOG_READ_METHOD, {})).toEqual({
    error: { code: -32123, message: "native failure" },
  });
  for (let i = 0; i < 3; i++) {
    expect(await fixture.host.handleClientRequest(THREAD_CATALOG_READ_METHOD, {})).toMatchObject({
      error: { code: -32082 },
    });
  }
  expect(request).toHaveBeenCalledTimes(4);
});
