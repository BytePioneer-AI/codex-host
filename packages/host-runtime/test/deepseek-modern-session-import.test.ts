import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { HarnessResult } from "@codexhost/harness-adapter";
import { FakeHarnessAdapter } from "@codexhost/harness-adapter/testing";
import { MappingStore } from "@codexhost/mapping-store";
import { transportModelIdForHarness } from "@codexhost/protocol-core";
import {
  harnessIdSchema,
  hostThreadIdSchema,
  type DeepSeekModernSessionCandidate,
} from "@codexhost/shared-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DeepSeekModernSessionImporter } from "../src/deepseek-modern-session-import.js";
import {
  createExternalThreadRecordInput,
  ExternalThreadRepository,
} from "../src/external-thread-repository.js";

const DEEPSEEK_HARNESS_ID = harnessIdSchema.parse("deepseek-harness");
const directories: string[] = [];

class ModernCandidateAdapter extends FakeHarnessAdapter {
  candidates: DeepSeekModernSessionCandidate[] = [];
  readonly listModernSessionCandidates = vi.fn(
    async (): Promise<HarnessResult<DeepSeekModernSessionCandidate[]>> => ({
      ok: true,
      value: structuredClone(this.candidates),
    }),
  );

  constructor() {
    super(DEEPSEEK_HARNESS_ID);
  }
}

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-dsh-import-"));
  directories.push(directory);
  const store = new MappingStore({ directory });
  const repository = new ExternalThreadRepository(store);
  await repository.initialize();
  const adapter = new ModernCandidateAdapter();
  const importer = new DeepSeekModernSessionImporter({ adapter, repository });
  return { adapter, importer, repository };
}

function candidate(
  nativeSessionId = "native-session",
  overrides: Partial<DeepSeekModernSessionCandidate> = {},
): DeepSeekModernSessionCandidate {
  return {
    nativeSessionId,
    title: "Native title",
    updatedAt: 123,
    cwd: path.resolve("native-workspace"),
    running: false,
    ...overrides,
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("DeepSeekModernSessionImporter", () => {
  it("lists only unmapped ordinary DeepSeek Sessions", async () => {
    const setup = await fixture();
    const mapped = candidate("mapped");
    const available = candidate("available");
    setup.adapter.candidates = [mapped, available];
    const record = await setup.repository.createProvisional(
      createExternalThreadRecordInput({
        hostThreadId: hostThreadIdSchema.parse("mapped-thread"),
        harnessId: DEEPSEEK_HARNESS_ID,
        cwd: mapped.cwd,
        transportModelId: transportModelIdForHarness("deepseek-harness"),
        ephemeral: false,
        historyMode: "paginated",
      }),
    );
    await setup.repository.commitNative(record.hostThreadId, {
      harnessId: DEEPSEEK_HARNESS_ID,
      nativeSessionId: mapped.nativeSessionId,
      formatVersion: 1,
    });

    await expect(setup.importer.list()).resolves.toEqual({
      ok: true,
      candidates: [available],
    });
    await setup.repository.close();
  });

  it("does not treat a Subagent mapping as the ordinary Session owner", async () => {
    const setup = await fixture();
    const available = candidate("shared-with-subagent");
    setup.adapter.candidates = [available];
    const child = await setup.repository.createProvisional(
      createExternalThreadRecordInput({
        hostThreadId: hostThreadIdSchema.parse("subagent-thread"),
        harnessId: DEEPSEEK_HARNESS_ID,
        cwd: available.cwd,
        transportModelId: transportModelIdForHarness("deepseek-harness"),
        ephemeral: false,
        historyMode: "paginated",
        subagent: {
          parentHostThreadId: hostThreadIdSchema.parse("parent-thread"),
          nativeSubagentId: "native-subagent",
        },
      }),
    );
    await setup.repository.commitNative(child.hostThreadId, {
      harnessId: DEEPSEEK_HARNESS_ID,
      nativeSessionId: available.nativeSessionId,
      formatVersion: 1,
    });

    await expect(setup.importer.list()).resolves.toEqual({
      ok: true,
      candidates: [available],
    });
    await setup.repository.close();
  });

  it("revalidates native metadata and commits only a notLoaded mapping", async () => {
    const setup = await fixture();
    setup.adapter.candidates = [candidate("selected", { title: "Displayed" })];
    await expect(setup.importer.list()).resolves.toMatchObject({ ok: true });
    setup.adapter.candidates = [
      candidate("selected", { cwd: path.resolve("fresh-workspace"), title: "Fresh" }),
    ];
    const open = vi.spyOn(setup.adapter, "open");

    const imported = await setup.importer.import("selected");

    expect(imported).toMatchObject({
      ok: true,
      thread: {
        cwd: path.resolve("fresh-workspace"),
        name: "Fresh",
        status: { type: "notLoaded" },
        turns: [],
      },
    });
    if (!imported.ok) throw new Error(imported.error.message);
    await expect(setup.repository.find(imported.threadId)).resolves.toMatchObject({
      state: "ready",
      harnessId: "deepseek-harness",
      cwd: path.resolve("fresh-workspace"),
      title: "Fresh",
      transportModelId: transportModelIdForHarness("deepseek-harness"),
      ephemeral: false,
      historyMode: "paginated",
      nativeSessionRef: {
        harnessId: "deepseek-harness",
        nativeSessionId: "selected",
        formatVersion: 1,
      },
      turnMappings: [],
    });
    expect(open).not.toHaveBeenCalled();
    await setup.repository.close();
  });

  it("fails closed when the fresh Session is missing or running", async () => {
    const setup = await fixture();
    setup.adapter.candidates = [];
    await expect(setup.importer.import("missing")).resolves.toMatchObject({
      ok: false,
      error: { code: -32079 },
    });
    setup.adapter.candidates = [candidate("busy", { running: true })];
    await expect(setup.importer.import("busy")).resolves.toMatchObject({
      ok: false,
      error: { code: -32072 },
    });
    await expect(setup.repository.list()).resolves.toEqual([]);
    await setup.repository.close();
  });

  it("coalesces concurrent imports and idempotently returns the ready mapping", async () => {
    const setup = await fixture();
    setup.adapter.candidates = [candidate("shared")];
    const release = Promise.withResolvers<undefined>();
    setup.adapter.listModernSessionCandidates.mockImplementationOnce(async () => {
      await release.promise;
      return { ok: true, value: structuredClone(setup.adapter.candidates) };
    });

    const first = setup.importer.import("shared");
    const second = setup.importer.import("shared");
    expect(first).toBe(second);
    release.resolve(undefined);
    const [left, right] = await Promise.all([first, second]);
    expect(left).toMatchObject({ ok: true });
    expect(right).toEqual(left);
    if (!left.ok || !right.ok) throw new Error("Concurrent import did not succeed");
    expect(left.threadId).toBe(right.threadId);
    expect(setup.adapter.listModernSessionCandidates).toHaveBeenCalledOnce();
    setup.adapter.listModernSessionCandidates.mockRejectedValueOnce(new Error("must not list"));
    await expect(setup.importer.import("shared")).resolves.toMatchObject({
      ok: true,
      threadId: left.threadId,
    });
    expect((await setup.repository.list()).filter(({ state }) => state === "ready")).toHaveLength(
      1,
    );
    await setup.repository.close();
  });

  it("returns a mapping that wins while fresh discovery is in flight", async () => {
    const setup = await fixture();
    const available = candidate("race-winner");
    setup.adapter.candidates = [available];
    const listed = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    setup.adapter.listModernSessionCandidates.mockImplementationOnce(async () => {
      listed.resolve(undefined);
      await release.promise;
      return { ok: true, value: [available] };
    });

    const importing = setup.importer.import(available.nativeSessionId);
    await listed.promise;
    const winner = await setup.repository.createProvisional(
      createExternalThreadRecordInput({
        hostThreadId: hostThreadIdSchema.parse("winning-thread"),
        harnessId: DEEPSEEK_HARNESS_ID,
        cwd: available.cwd,
        transportModelId: transportModelIdForHarness("deepseek-harness"),
        ephemeral: false,
        historyMode: "paginated",
      }),
    );
    await setup.repository.commitNative(winner.hostThreadId, {
      harnessId: DEEPSEEK_HARNESS_ID,
      nativeSessionId: available.nativeSessionId,
      formatVersion: 1,
    });
    release.resolve(undefined);

    await expect(importing).resolves.toMatchObject({
      ok: true,
      threadId: "winning-thread",
    });
    expect(await setup.repository.list()).toHaveLength(1);
    await setup.repository.close();
  });

  it("resolves competing importer instances to one ready mapping", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-dsh-import-race-"));
    directories.push(directory);
    const firstReadyEntered = Promise.withResolvers<undefined>();
    const releaseFirstReady = Promise.withResolvers<undefined>();
    let readyReplacements = 0;
    const store = new MappingStore({
      directory,
      beforeReplace(record) {
        if (record.state !== "ready") return;
        readyReplacements += 1;
        if (readyReplacements === 1) {
          firstReadyEntered.resolve(undefined);
          return releaseFirstReady.promise;
        }
      },
    });
    const repository = new ExternalThreadRepository(store);
    await repository.initialize();
    const adapter = new ModernCandidateAdapter();
    adapter.candidates = [candidate("competing")];
    const firstImporter = new DeepSeekModernSessionImporter({ adapter, repository });
    const secondImporter = new DeepSeekModernSessionImporter({ adapter, repository });

    const imports = [firstImporter.import("competing"), secondImporter.import("competing")];
    await firstReadyEntered.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    const replacementsBeforeRelease = readyReplacements;
    releaseFirstReady.resolve(undefined);
    const results = await Promise.all(imports);

    expect(replacementsBeforeRelease).toBe(1);
    expect(results.every(({ ok }) => ok)).toBe(true);
    const [firstResult, secondResult] = results;
    if (!firstResult?.ok || !secondResult?.ok) {
      throw new Error("Expected both importers to resolve the winning mapping");
    }
    expect([firstResult.threadId, secondResult.threadId]).toEqual([
      firstResult.threadId,
      firstResult.threadId,
    ]);
    const records = await repository.list();
    expect(records).toEqual([
      expect.objectContaining({
        hostThreadId: firstResult.threadId,
        state: "ready",
        nativeSessionRef: expect.objectContaining({ nativeSessionId: "competing" }),
      }),
    ]);
    await repository.close();
  });

  it("removes its provisional record when the ready commit fails", async () => {
    const setup = await fixture();
    setup.adapter.candidates = [candidate()];
    vi.spyOn(setup.repository, "commitNative").mockRejectedValueOnce(
      new Error("synthetic commit failure"),
    );

    await expect(setup.importer.import("native-session")).resolves.toMatchObject({
      ok: false,
      error: { code: -32081 },
    });
    await expect(setup.repository.list()).resolves.toEqual([]);
    await setup.repository.close();
  });

  it("does not leave a record when provisional creation fails", async () => {
    const setup = await fixture();
    setup.adapter.candidates = [candidate()];
    vi.spyOn(setup.repository, "createProvisional").mockRejectedValueOnce(
      new Error("synthetic create failure"),
    );

    await expect(setup.importer.import("native-session")).resolves.toMatchObject({
      ok: false,
      error: { code: -32081 },
    });
    await expect(setup.repository.list()).resolves.toEqual([]);
    await setup.repository.close();
  });

  it("rejects Adapters without the Modern-only capability", async () => {
    const setup = await fixture();
    const legacy = new FakeHarnessAdapter(DEEPSEEK_HARNESS_ID);
    const importer = new DeepSeekModernSessionImporter({
      adapter: legacy,
      repository: setup.repository,
    });
    const open = vi.spyOn(legacy, "open");

    await expect(importer.list()).resolves.toMatchObject({
      ok: false,
      error: { code: -32076 },
    });
    expect(open).not.toHaveBeenCalled();
    await setup.repository.close();
  });

  it("reports a missing DeepSeek Adapter as unavailable", async () => {
    const setup = await fixture();
    const importer = new DeepSeekModernSessionImporter({ repository: setup.repository });

    await expect(importer.list()).resolves.toMatchObject({
      ok: false,
      error: { code: -32077 },
    });
    await setup.repository.close();
  });
});
