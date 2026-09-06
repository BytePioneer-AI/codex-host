import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { PiAdapter } from "@codexhost/adapter-pi";
import type { HarnessAdapter, HarnessSessionImportSource } from "@codexhost/harness-adapter";
import { FakeHarnessAdapter } from "@codexhost/harness-adapter/testing";
import { MappingStore } from "@codexhost/mapping-store";
import {
  harnessIdSchema,
  jsonRpcRequestSchema,
  type JsonObject,
} from "@codexhost/shared-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ExternalThreadRepository } from "../src/external-thread-repository.js";
import { HarnessSessionImporter } from "../src/harness-session-import.js";
import { SessionImportRequests } from "../src/session-import-requests.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "codexhost-generic-import-")));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, "project");
  const sessions = path.join(root, "sessions");
  await mkdir(cwd);
  await mkdir(sessions);
  const sessionFile = path.join(sessions, "native.jsonl");
  await writeFile(
    sessionFile,
    [
      {
        type: "session",
        version: 3,
        id: "same-native-id",
        cwd,
        timestamp: "2026-01-01T00:00:00.000Z",
      },
      {
        type: "message",
        id: "user-1",
        parentId: null,
        message: { role: "user", content: "Never sent to Renderer", timestamp: 1_767_225_600_000 },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n",
  );
  const directory = path.join(root, "mappings");
  const repository = new ExternalThreadRepository(new MappingStore({ directory }));
  await repository.initialize();
  cleanup.push(() => repository.close());
  const createTransport = vi.fn(() => {
    throw new Error("Import must be mapping-only");
  });
  const pi = new PiAdapter(
    { environment: { PI_CODING_AGENT_SESSION_DIR: sessions } },
    { createTransport },
  );
  cleanup.push(() => pi.close());
  const importer = new HarnessSessionImporter({ harnessId: pi.harnessId, adapter: pi, repository });
  return { root, cwd, sessionFile, directory, repository, pi, importer, createTransport };
}

function dshAdapter(cwd: string) {
  const base = new FakeHarnessAdapter(harnessIdSchema.parse("deepseek-harness"));
  const source: HarnessSessionImportSource = {
    candidate: {
      nativeSessionId: "same-native-id",
      title: "DSH session",
      cwd,
      running: false,
      updatedAt: 1,
    },
    nativeRef: { harnessId: base.harnessId, nativeSessionId: "same-native-id", formatVersion: 1 },
  };
  return Object.assign(base, {
    sessionImport: {
      listCandidates: vi.fn(async () => ({ ok: true as const, value: [source.candidate] })),
      resolveCandidate: vi.fn(async () => ({ ok: true as const, value: source })),
    },
  });
}

describe("Generic native Session import", () => {
  it("persists Pi's exact locator, coalesces imports, and survives a mapping store restart without starting an Agent", async () => {
    const f = await fixture();
    const outcomes = await Promise.all([
      f.importer.import("same-native-id"),
      f.importer.import("same-native-id"),
    ]);
    expect(outcomes[0]).toEqual(outcomes[1]);
    const outcome = outcomes[0];
    if (!outcome?.ok) throw new Error("Pi import failed");
    expect(outcome.thread).toMatchObject({ status: { type: "notLoaded" } });
    expect(await f.importer.list()).toEqual({ ok: true, candidates: [], total: 0 });
    await f.repository.close();
    const reopened = new ExternalThreadRepository(new MappingStore({ directory: f.directory }));
    await reopened.initialize();
    cleanup.push(() => reopened.close());
    expect((await reopened.list())[0]).toMatchObject({
      state: "ready",
      harnessId: "pi",
      cwd: f.cwd,
      nativeSessionRef: {
        harnessId: "pi",
        nativeSessionId: "same-native-id",
        locator: { sessionFile: f.sessionFile },
        formatVersion: 1,
      },
    });
    const importer = new HarnessSessionImporter({
      harnessId: f.pi.harnessId,
      adapter: f.pi,
      repository: reopened,
    });
    await rm(f.sessionFile);
    expect(await importer.import("same-native-id")).toMatchObject({
      ok: true,
      threadId: outcome.threadId,
    });
    expect(f.createTransport).not.toHaveBeenCalled();
  });

  it("separates same native IDs across Harnesses and shares DSH legacy RPC aliases with the generic transaction", async () => {
    const f = await fixture();
    const dsh = dshAdapter(f.cwd);
    const discoveryOnly = Object.assign(
      new FakeHarnessAdapter(harnessIdSchema.parse("discovery-only")),
      {
        sessionImport: { listCandidates: async () => ({ ok: true as const, value: [] }) },
      },
    );
    const adapters = new Map<string, HarnessAdapter>([
      ["pi", f.pi],
      ["deepseek-harness", dsh],
      ["discovery-only", discoveryOnly],
    ]);
    const rpc = new SessionImportRequests({
      adapters,
      descriptors: () => [],
      repository: f.repository,
      diagnose: vi.fn(),
    });
    const request = (method: string, params: JsonObject) =>
      rpc.handle(jsonRpcRequestSchema.parse({ id: 1, method, params }));
    expect(await request("codexhost/harness/session-import/sources", {})).toMatchObject({
      body: {
        result: {
          harnesses: [
            { harnessId: "pi", name: "pi" },
            { harnessId: "deepseek-harness", name: "deepseek-harness" },
          ],
        },
      },
    });
    const listed = await request("codexhost/harness/session-import/list", { harnessId: "pi" });
    expect(listed).toMatchObject({ body: { result: { candidates: [{ running: null }] } } });
    expect(JSON.stringify(listed)).not.toContain("sessionFile");
    const [pi, generic, legacy] = await Promise.all([
      request("codexhost/harness/session-import/import", {
        harnessId: "pi",
        nativeSessionId: "same-native-id",
      }),
      request("codexhost/harness/session-import/import", {
        harnessId: "deepseek-harness",
        nativeSessionId: "same-native-id",
      }),
      request("codexhost/deepseek/modern-session/import", { nativeSessionId: "same-native-id" }),
    ]);
    expect(generic.body).toEqual(legacy.body);
    expect(pi.body).not.toEqual(generic.body);
    expect([generic, legacy].filter((response) => response.importedThread)).toHaveLength(1);
    expect(await f.repository.list()).toHaveLength(2);
    expect(dsh.sessionImport.resolveCandidate).toHaveBeenCalledOnce();
    for (const params of [
      {
        harnessId: "pi",
        nativeSessionId: "same-native-id",
        locator: { sessionFile: "/untrusted" },
      },
      { harnessId: "pi", nativeSessionId: "same-native-id", cwd: "/untrusted" },
    ])
      expect(await request("codexhost/harness/session-import/import", params)).toMatchObject({
        body: { error: { code: -32602 } },
      });
    expect(
      await request("codexhost/harness/session-import/list", { harnessId: "unknown-plugin" }),
    ).toMatchObject({ body: { error: { code: -32077 } } });
    expect(
      await request("codexhost/harness/session-import/list", { harnessId: "discovery-only" }),
    ).toMatchObject({ body: { error: { code: -32076 } } });
  });

  it.each(["harness", "identity", "busy"])(
    "rejects resolver %s violations without creating a provisional mapping",
    async (invalid) => {
      const f = await fixture();
      const adapter = dshAdapter(f.cwd);
      const response = await adapter.sessionImport.resolveCandidate();
      if (invalid === "harness") response.value.nativeRef.harnessId = f.pi.harnessId;
      if (invalid === "identity") response.value.nativeRef.nativeSessionId = "wrong-id";
      if (invalid === "busy") response.value.candidate.running = true;
      const importer = new HarnessSessionImporter({
        harnessId: adapter.harnessId,
        adapter,
        repository: f.repository,
      });
      expect(await importer.import("same-native-id")).toMatchObject({
        ok: false,
        error: { code: invalid === "busy" ? -32072 : -32076 },
      });
      expect(await f.repository.list()).toEqual([]);
    },
  );
});
