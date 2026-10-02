import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CursorAdapter } from "@codexhost/adapter-cursor-cli";
import { MappingStore } from "@codexhost/mapping-store";
import {
  harnessSessionImportResultSchema,
  jsonRpcRequestSchema,
  type JsonObject,
} from "@codexhost/shared-contracts";
import { afterEach, expect, it, vi } from "vitest";
import { ExternalThreadRepository } from "../src/external-thread-repository.js";
import { SessionImportRequests } from "../src/session-import-requests.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});

it("exposes Cursor's public import capability and persists its resolved policy without opening an Agent", async () => {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "codexhost-cursor-host-import-")),
  );
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const adapter = new CursorAdapter({ environment: { HOME: root, USERPROFILE: root } });
  cleanup.push(() => adapter.close());
  const nativeSessionId = randomUUID();
  // Native SQLite discovery/resume is covered by the Adapter's isolated fixtures.
  // This test checks Host registration, resolution, idempotency and persistence.
  const candidate = {
    nativeSessionId,
    cwd: root,
    title: "Cursor ACP",
    updatedAt: 1,
    running: null,
  };
  const nativeRef = {
    harnessId: adapter.harnessId,
    nativeSessionId,
    formatVersion: 1 as const,
    locator: { executionPolicy: "default" },
  };
  vi.spyOn(adapter.sessionImport, "listCandidates").mockResolvedValue({
    ok: true,
    value: [candidate],
  });
  const resolve = vi
    .spyOn(adapter.sessionImport, "resolveCandidate")
    .mockResolvedValue({ ok: true, value: { candidate, nativeRef } });
  const open = vi.spyOn(adapter, "open");
  // The isolated home has no Cursor CLI; a Harness positively not installed is not offered.
  vi.spyOn(adapter, "inspect").mockResolvedValue({
    status: "unavailable",
    error: { code: "unavailable", message: "not inspected in this test", retryable: true },
  });
  const directory = path.join(root, "mappings");
  const repository = new ExternalThreadRepository(new MappingStore({ directory }));
  await repository.initialize();
  cleanup.push(() => repository.close());
  const rpc = new SessionImportRequests({
    adapters: new Map([[adapter.harnessId, adapter]]),
    descriptors: () => [],
    repository,
    diagnose: vi.fn(),
  });
  const request = (method: string, params: JsonObject) =>
    rpc.handle(jsonRpcRequestSchema.parse({ id: 1, method, params }));
  expect(await request("codexhost/harness/session-import/sources", {})).toMatchObject({
    body: { result: { harnesses: [{ harnessId: "cursor-cli" }] } },
  });
  expect(
    await request("codexhost/harness/session-import/list", { harnessId: "cursor-cli" }),
  ).toMatchObject({ body: { result: { candidates: [candidate], total: 1 } } });
  const params = { harnessId: "cursor-cli", nativeSessionId };
  const [first, second] = await Promise.all([
    request("codexhost/harness/session-import/import", params),
    request("codexhost/harness/session-import/import", params),
  ]);
  const result = harnessSessionImportResultSchema.parse(first.body.result);
  expect(second.body.result).toEqual(result);
  expect([first, second].filter((value) => value.importedThread)).toHaveLength(1);
  expect(resolve).toHaveBeenCalledOnce();
  expect(open).not.toHaveBeenCalled();
  expect(
    await request("codexhost/harness/session-import/list", { harnessId: "cursor-cli" }),
  ).toMatchObject({ body: { result: { candidates: [], total: 0 } } });
  await repository.close();
  const reopened = new ExternalThreadRepository(new MappingStore({ directory }));
  await reopened.initialize();
  cleanup.push(() => reopened.close());
  expect(await reopened.list()).toMatchObject([
    { hostThreadId: result.threadId, nativeSessionRef: nativeRef, cwd: root, state: "ready" },
  ]);
});
