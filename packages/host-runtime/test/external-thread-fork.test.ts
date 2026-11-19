import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenSessionInput, HostThreadSnapshot } from "@codexhost/harness-adapter";
import { FakeHarnessAdapter, FakeHarnessSession } from "@codexhost/harness-adapter/testing";
import { MappingStore } from "@codexhost/mapping-store";
import {
  decodeExternalTransportSelection,
  encodeExternalTransportSelection,
  type JsonObject,
} from "@codexhost/protocol-core";
import {
  harnessIdSchema,
  harnessModelCatalogSchema,
  harnessModelRefSchema,
  harnessThinkingOptionIdSchema,
  hostThreadIdSchema,
} from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";
import {
  closeFixture,
  completePiTurn,
  createFixture,
  requestId,
  startExternalThread,
  stopFixture,
  writeRequest,
} from "./app-server-host-fixture.js";

const normal = harnessModelRefSchema.parse({ id: "normal" });
const fast = harnessModelRefSchema.parse({ id: "priority" });
const catalog = harnessModelCatalogSchema.parse({
  models: [{ ref: normal, fastModel: fast, label: "Model", supportedThinkingOptionIds: ["high"] }],
  thinkingOptions: [{ id: "high", label: "High" }],
  defaultModel: normal,
  defaultThinkingOptionId: "high",
});
const fastTransport = encodeExternalTransportSelection("pi", {
  model: fast,
  thinkingOptionId: harnessThinkingOptionIdSchema.parse("high"),
});

/** Like Pi, Fork starts with no process-local Fast flag; Resume applies the saved Model ref. */
class NativeForkDefaultsAdapter extends FakeHarnessAdapter {
  readonly resumedModels: (typeof normal | undefined)[] = [];
  constructor(readonly snapshots = new Map<string, HostThreadSnapshot>()) {
    super(harnessIdSchema.parse("pi"), catalog);
  }
  override async open(input: OpenSessionInput) {
    if (input.kind === "resume") {
      const snapshot = this.snapshots.get(input.nativeRef.nativeSessionId);
      if (snapshot) {
        this.resumedModels.push(input.model);
        const session = new FakeHarnessSession(
          this.harnessId,
          catalog,
          input.model ?? normal,
          input.nativeRef,
          snapshot,
          true,
          input.cwd,
          true,
          catalog.defaultThinkingOptionId,
        );
        this.sessions.push(session);
        return { ok: true as const, value: session };
      }
    }
    const opened = await super.open(input);
    if (input.kind === "fork" && opened.ok) {
      const selected = await opened.value.execute({ type: "model.select", model: normal });
      if (!selected.ok) throw new Error(selected.error.message);
      const snapshot = await opened.value.readSnapshot();
      const nativeRef = opened.value.initialState.nativeRef;
      if (!snapshot.ok || !nativeRef) throw new Error("Missing derived fixture snapshot");
      this.snapshots.set(nativeRef.nativeSessionId, snapshot.value);
    }
    return opened;
  }
}

describe("External Fork Model persistence", () => {
  it("persists the derived normal Model and does not re-enable Fast after reopening", async () => {
    const adapter = new NativeForkDefaultsAdapter();
    const fixture = createFixture({ externalAdapters: new Map([["pi", adapter]]) });
    let reopened: ReturnType<typeof createFixture> | undefined;
    try {
      const sourceId = await startExternalThread(fixture, fastTransport);
      await completePiTurn(fixture, sourceId, 2);
      writeRequest(fixture.desktopInput, {
        id: 3,
        method: "thread/fork",
        params: { threadId: sourceId },
      });
      const response = await fixture.collector.waitFor((message) => requestId(message, 3));
      expect(response.error).toBeUndefined();
      const derivedId = ((response.result as JsonObject).thread as JsonObject).id;
      if (typeof derivedId !== "string") throw new Error("Missing derived Thread ID");
      const saved = await fixture.mappingStore.getThread(hostThreadIdSchema.parse(derivedId));
      if (!saved) throw new Error("Missing derived record");
      expect(decodeExternalTransportSelection("pi", saved.transportModelId)).toMatchObject({
        model: normal,
        thinkingOptionId: "high",
      });
      expect(adapter.sessions.at(-1)?.state.effectiveModel).toEqual(normal);
      expect(adapter.sessions[0]?.state.effectiveModel).toEqual(fast);
      expect(
        (await fixture.mappingStore.getThread(hostThreadIdSchema.parse(sourceId)))
          ?.transportModelId,
      ).toBe(fastTransport);
      await closeFixture(fixture);
      const restoredAdapter = new NativeForkDefaultsAdapter(adapter.snapshots);
      reopened = createFixture({
        mappingStoreDirectory: fixture.mappingStoreDirectory,
        externalAdapters: new Map([["pi", restoredAdapter]]),
      });
      await reopened.ready;
      writeRequest(reopened.desktopInput, {
        id: 4,
        method: "thread/resume",
        params: { threadId: derivedId },
      });
      const restored = await reopened.collector.waitFor((message) => requestId(message, 4));
      expect(restored.error).toBeUndefined();
      expect(restoredAdapter.resumedModels).toEqual([normal]);
      expect(restoredAdapter.sessions.at(-1)?.state.effectiveModel).toEqual(normal);
    } finally {
      if (reopened) await closeFixture(reopened);
      await stopFixture(fixture);
    }
  });

  it("removes the provisional Fork and closes its Session if saving the actual Model fails", async () => {
    const adapter = new NativeForkDefaultsAdapter();
    const fixtureDirectory = mkdtempSync(path.join(os.tmpdir(), "codexhost-fork-model-"));
    const store = new MappingStore({
      directory: fixtureDirectory,
      beforeReplace(record) {
        if (
          record.state === "creating" &&
          record.forkSource &&
          decodeExternalTransportSelection("pi", record.transportModelId)?.model?.id === normal.id
        )
          throw new Error("Model persistence failed");
      },
    });
    const fixture = createFixture({
      mappingStore: store,
      mappingStoreDirectory: fixtureDirectory,
      externalAdapters: new Map([["pi", adapter]]),
    });
    try {
      const sourceId = await startExternalThread(fixture, fastTransport);
      await completePiTurn(fixture, sourceId, 2);
      writeRequest(fixture.desktopInput, {
        id: 3,
        method: "thread/fork",
        params: { threadId: sourceId },
      });
      await expect(
        fixture.collector.waitFor((message) => requestId(message, 3)),
      ).resolves.toMatchObject({ error: { code: -32081 } });
      expect(await store.listThreads()).toHaveLength(1);
      await expect(adapter.sessions.at(-1)?.readSnapshot()).resolves.toMatchObject({
        ok: false,
        error: { code: "invalidState" },
      });
      expect(adapter.sessions[0]?.state.effectiveModel).toEqual(fast);
    } finally {
      await stopFixture(fixture);
    }
  });
});

const sonnet = harnessModelRefSchema.parse({ id: "sonnet" });
const opus = harnessModelRefSchema.parse({ id: "opus" });
const switchCatalog = harnessModelCatalogSchema.parse({
  models: [
    { ref: sonnet, label: "Sonnet", supportedThinkingOptionIds: ["high"] },
    { ref: opus, label: "Opus", supportedThinkingOptionIds: ["high"] },
  ],
  thinkingOptions: [{ id: "high", label: "High" }],
  defaultModel: sonnet,
  defaultThinkingOptionId: "high",
});
const sonnetTransport = encodeExternalTransportSelection("pi", {
  model: sonnet,
  thinkingOptionId: harnessThinkingOptionIdSchema.parse("high"),
});

/** Like Claude Code: Resume applies the saved Model, and a Fork confirms no Model of its own. */
class NativeModelSwitchAdapter extends FakeHarnessAdapter {
  readonly resumedModels: (typeof sonnet | undefined)[] = [];
  constructor(readonly snapshots = new Map<string, HostThreadSnapshot>()) {
    super(harnessIdSchema.parse("pi"), switchCatalog);
  }
  override async open(input: OpenSessionInput) {
    if (input.kind === "resume" && this.snapshots.has(input.nativeRef.nativeSessionId)) {
      this.resumedModels.push(input.model);
      const session = new FakeHarnessSession(
        this.harnessId,
        switchCatalog,
        input.model,
        input.nativeRef,
        this.snapshots.get(input.nativeRef.nativeSessionId),
        true,
        input.cwd,
      );
      this.sessions.push(session);
      return { ok: true as const, value: session };
    }
    const opened = await super.open(input);
    if (input.kind !== "fork" || !opened.ok) return opened;
    const snapshot = await opened.value.readSnapshot();
    const nativeRef = opened.value.initialState.nativeRef;
    if (!snapshot.ok || !nativeRef) throw new Error("Missing derived fixture snapshot");
    const unconfirmed = new FakeHarnessSession(
      this.harnessId,
      switchCatalog,
      sonnet,
      nativeRef,
      snapshot.value,
      true,
      input.cwd,
    );
    // Claude Code opens a Fork without confirming the Model it would run.
    Object.defineProperty(unconfirmed, "initialState", { value: { nativeRef } });
    this.sessions.push(unconfirmed);
    return { ok: true as const, value: unconfirmed };
  }
}

describe("External selected Model persistence", () => {
  it("keeps a selected Model across Fork and reopening", async () => {
    const adapter = new NativeModelSwitchAdapter();
    const fixture = createFixture({ externalAdapters: new Map([["pi", adapter]]) });
    let reopened: ReturnType<typeof createFixture> | undefined;
    try {
      const sourceId = await startExternalThread(fixture, sonnetTransport);
      await completePiTurn(fixture, sourceId, 2);
      const source = adapter.sessions[0];
      if (!source) throw new Error("Missing source Session");
      writeRequest(fixture.desktopInput, {
        id: 5,
        method: "codexhost/thread/model/select",
        params: { threadId: sourceId, model: opus },
      });
      await expect(
        fixture.collector.waitFor((message) => requestId(message, 5)),
      ).resolves.toMatchObject({ result: { effectiveModel: opus } });
      const sourceThreadId = hostThreadIdSchema.parse(sourceId);
      const saved = await fixture.mappingStore.getThread(sourceThreadId);
      expect(decodeExternalTransportSelection("pi", saved?.transportModelId)).toMatchObject({
        model: opus,
        thinkingOptionId: "high",
      });

      writeRequest(fixture.desktopInput, {
        id: 3,
        method: "thread/fork",
        params: { threadId: sourceId },
      });
      const response = await fixture.collector.waitFor((message) => requestId(message, 3));
      expect(response.error).toBeUndefined();
      const derivedId = ((response.result as JsonObject).thread as JsonObject).id;
      if (typeof derivedId !== "string") throw new Error("Missing derived Thread ID");
      expect(adapter.sessions.at(-1)?.state.effectiveModel).toEqual(opus);
      const derived = await fixture.mappingStore.getThread(hostThreadIdSchema.parse(derivedId));
      expect(decodeExternalTransportSelection("pi", derived?.transportModelId)).toMatchObject({
        model: opus,
      });

      const sourceSnapshot = await source.readSnapshot();
      const sourceRef = source.initialState.nativeRef;
      if (!sourceSnapshot.ok || !sourceRef) throw new Error("Missing source snapshot");
      await closeFixture(fixture);
      const restoredAdapter = new NativeModelSwitchAdapter(
        new Map([[sourceRef.nativeSessionId, sourceSnapshot.value]]),
      );
      reopened = createFixture({
        mappingStoreDirectory: fixture.mappingStoreDirectory,
        externalAdapters: new Map([["pi", restoredAdapter]]),
      });
      await reopened.ready;
      writeRequest(reopened.desktopInput, {
        id: 4,
        method: "thread/resume",
        params: { threadId: sourceId },
      });
      const restored = await reopened.collector.waitFor((message) => requestId(message, 4));
      expect(restored.error).toBeUndefined();
      expect(restoredAdapter.resumedModels).toEqual([opus]);
    } finally {
      if (reopened) await closeFixture(reopened);
      await stopFixture(fixture);
    }
  });
});
