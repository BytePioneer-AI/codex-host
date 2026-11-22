import assert from "node:assert/strict";
import { it, onTestFinished } from "vitest";
import { officialCodexModelRef, harnessModelRefKey } from "@codexhost/shared-contracts";
import { RemoteSessions, remoteSessionId } from "../../packages/web-server/src/remote-sessions.ts";
import { EventHub, RpcRegistry, StreamRegistry } from "../../packages/web-server/src/transport.ts";
import {
  mergeRemoteControls,
  parseRemoteControls,
  selectRemoteModel,
  type RemoteControlsEntry,
} from "../../packages/web-server/src/remote-session-controls.ts";

it("carries a confirmed speed tier across partial reads only for the same model and connection", () => {
  const configuration = { owner: "codex", locked: true };
  const previous = parseRemoteControls({
    configuration,
    nativeSettings: { model: "gpt-6-astra", serviceTier: "ultrafast" },
  });
  for (const [model, serviceTier, sameEpoch, expectedTier] of [
    ["gpt-6-astra", undefined, true, "ultrafast"],
    ["gpt-6-astra", null, true, null],
    ["gpt-6-astra", "priority", true, "priority"],
    ["gpt-other", undefined, true, null],
    ["gpt-6-astra", undefined, false, null],
  ] as const) {
    const next = parseRemoteControls({
      configuration,
      nativeSettings: { model, serviceTier, reasoningEffort: "high" },
    });
    assert.deepEqual(mergeRemoteControls(previous, next, sameEpoch).configuration, {
      ...configuration,
      effectiveModel: { id: model, ...(expectedTier ? { serviceTier: expectedTier } : {}) },
      effectiveThinkingOptionId: "high",
    });
  }
  const confirmedStandard = parseRemoteControls({
    configuration: { ...configuration, effectiveModel: { id: "gpt-6-astra" } },
    nativeSettings: { model: "gpt-6-astra" },
  });
  assert.deepEqual(
    mergeRemoteControls(previous, confirmedStandard, true).configuration,
    confirmedStandard.configuration,
  );
});

it("uses native model and Thinking settings when the confirmed Model differs", () => {
  const controls = parseRemoteControls({
    configuration: {
      owner: "codex",
      locked: true,
      effectiveModel: { id: "previous", serviceTier: "ultrafast" },
      effectiveThinkingOptionId: "low",
    },
    nativeSettings: { model: "gpt-other", reasoningEffort: "high" },
  });
  assert.deepEqual(controls.configuration, {
    owner: "codex",
    locked: true,
    effectiveModel: { id: "gpt-other" },
    effectiveThinkingOptionId: "high",
  });
});

it("stops a combined selection when refresh moves to another connection", async () => {
  const entry: RemoteControlsEntry = {
    epoch: "original",
    row: { modelProvider: "openai" },
    controls: parseRemoteControls({
      configuration: { owner: "codex", locked: true },
      nativeSettings: { model: "before" },
    }),
  };
  const writes: unknown[] = [];
  await assert.rejects(
    selectRemoteModel(
      "remote",
      entry,
      {
        provider: "codex",
        model: "after",
        reasoningEffort: "high",
      },
      async (_entry, setting) => {
        writes.push(setting);
      },
      async () => {
        entry.epoch = "replacement";
      },
    ),
    /Thinking was not completed/,
  );
  assert.deepEqual(writes, [{ modelId: "after" }]);
});

it("switches remote Codex speed tiers and skips unchanged Refs without consulting local defaults", async () => {
  const rpc = new RpcRegistry();
  for (const method of ["session/modelCatalog", "session/selectModel", "session/projections"])
    rpc.register(method, () => {
      throw Error("local fallback");
    });
  let model: string | undefined = "gpt-6-astra";
  let tier: string | null = null;
  let epoch = "one";
  let writes = 0;
  let available = true;
  const ref = () => officialCodexModelRef(model ?? "unknown", tier);
  const key = (id: string, serviceTier?: string | null) =>
    harnessModelRefKey(officialCodexModelRef(id, serviceTier));
  const inspection = {
    status: "ready",
    catalog: {
      models: [
        {
          ref: { id: "gpt-6-astra" },
          fastModel: { id: "gpt-6-astra", serviceTier: "priority" },
          label: "Astra",
          supportedThinkingOptionIds: ["high"],
        },
        {
          ref: { id: "gpt-6-astra", serviceTier: "ultrafast" },
          label: "Astra · Ultrafast",
          supportedThinkingOptionIds: ["high"],
        },
        { ref: { id: "gpt-other" }, label: "Other" },
      ],
      defaultModel: { id: "gpt-other" },
      thinkingOptions: [{ id: "high", label: "High" }],
    },
    capabilities: {
      configuration: {
        selectModel: true,
        selectThinkingOption: true,
        selectPermissionMode: false,
        permissionModeScope: "live",
      },
      history: { fork: true, forkAcrossCwd: false, rollbackLastTurn: false },
    },
  };
  const row = () => ({
    id: "native",
    cwd: "/mac",
    modelProvider: "openai",
    model,
    createdAt: 1,
    updatedAt: 2,
    status: { type: "idle" },
    turns: [],
  });
  const remote = new RemoteSessions(new EventHub("native-test"), async (op) => {
    if (op.kind === "hosts") return [{ hostId: "remote-ssh:mac", online: true }];
    if (op.kind === "list") return { data: [row()], nextCursor: null };
    if (op.kind === "read")
      return {
        result: { thread: row() },
        epoch,
        requests: [],
        configuration: {
          owner: "codex",
          locked: true,
          ...(model && tier !== "ultrafast" ? { effectiveModel: ref() } : {}),
        },
        // Some native Thread headers omit the tier even after the Host confirms it.
        nativeSettings: { model, ...(tier === "ultrafast" ? {} : { serviceTier: tier }) },
        ...(available ? { inspection } : {}),
      };
    if (op.kind === "configure") {
      assert.equal(op.hostId, "remote-ssh:mac");
      assert.equal(op.threadId, "native");
      assert.equal(op.epoch, epoch);
      assert.ok(op.modelId);
      model = op.modelId;
      tier = op.serviceTier ?? null;
      writes++;
      return { effectiveModel: ref() };
    }
    throw Error("unexpected operation");
  });
  onTestFinished(() => remote.close());
  remote.install(rpc, new StreamRegistry());
  const id = remoteSessionId("remote-ssh:mac", "native");
  const call = (method: string, request = {}) =>
    rpc.dispatch(method, { args: { request: { sessionId: id, ...request } } });
  await remote.read(id);
  const projection = await call("session/projections");
  assert.ok(projection.ok);
  assert.deepEqual(
    (projection.value as { values: { modelSelection: unknown } }).values.modelSelection,
    {
      lastUsed: { provider: "codex", model: ref().id },
      next: { provider: "codex", model: ref().id },
    },
  );
  const catalog = await call("session/modelCatalog");
  assert.ok(catalog.ok);
  assert.equal((catalog.value as { default: { model: string } }).default.model, ref().id);
  assert.deepEqual((catalog.value as { groups: Array<{ models: unknown }> }).groups[0]?.models, [
    {
      id: "gpt-6-astra",
      name: "Astra",
      fastModel: key("gpt-6-astra", "priority"),
      ultrafastModel: key("gpt-6-astra", "ultrafast"),
      reasoning: { efforts: [{ id: "high", name: "High" }] },
    },
    {
      id: key("gpt-6-astra", "ultrafast"),
      name: "Astra · Ultrafast",
      reasoning: { efforts: [{ id: "high", name: "High" }] },
    },
    {
      id: "gpt-other",
      name: "Other",
      reasoning: { efforts: [{ id: "high", name: "High" }] },
    },
  ]);
  for (const [targetModel, targetTier] of [
    ["gpt-6-astra", "priority"],
    ["gpt-6-astra", "priority"],
    ["gpt-6-astra", "ultrafast"],
    ["gpt-6-astra", null],
  ] as const) {
    const target = key(targetModel, targetTier);
    assert.ok((await call("session/selectModel", { provider: "codex", model: target })).ok);
    assert.equal(model, targetModel);
    assert.equal(tier, targetTier);
    const view = await call("session/projections");
    assert.ok(view.ok);
    assert.equal(
      (view.value as { values: { modelSelection: { next: { model: string } } } }).values
        .modelSelection.next.model,
      target,
    );
  }
  assert.equal(writes, 3);
  assert.equal(
    (await call("session/selectModel", { provider: "claude-code", model: "wrong" })).ok,
    false,
  );
  epoch = "two";
  tier = "ultrafast";
  await remote.read(id);
  assert.ok((await call("session/selectModel", { provider: "codex", model: "gpt-6-astra" })).ok);
  assert.equal(tier, null);
  epoch = "three";
  model = undefined;
  available = false;
  await remote.read(id);
  assert.equal((await call("session/modelCatalog")).ok, false);
  assert.equal(writes, 4);
});
