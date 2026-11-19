import assert from "node:assert/strict";
import { it } from "node:test";
import {
  encodeOfficialCodexModelRef,
  decodeOfficialCodexModelSelection,
} from "@codexhost/shared-contracts";
import { RemoteSessions, remoteSessionId } from "../src/remote-sessions.ts";
import { EventHub, RpcRegistry, StreamRegistry } from "../src/transport.ts";
import {
  mergeRemoteControls,
  parseRemoteControls,
  selectRemoteModel,
  type RemoteControlsEntry,
} from "../src/remote-session-controls.ts";

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
      effectiveModel: encodeOfficialCodexModelRef(model, expectedTier),
      effectiveThinkingOptionId: "high",
    });
  }
  const confirmedStandard = parseRemoteControls({
    configuration: { ...configuration, effectiveModel: encodeOfficialCodexModelRef("gpt-6-astra") },
    nativeSettings: { model: "gpt-6-astra" },
  });
  assert.deepEqual(
    mergeRemoteControls(previous, confirmedStandard, true).configuration,
    confirmedStandard.configuration,
  );
});

it("uses native model and Thinking settings when the confirmed reference is malformed", () => {
  const controls = parseRemoteControls({
    configuration: {
      owner: "codex",
      locked: true,
      effectiveModel: { id: "codex-model-v1." },
      effectiveThinkingOptionId: "low",
    },
    nativeSettings: { model: "gpt-other", reasoningEffort: "high" },
  });
  assert.deepEqual(controls.configuration, {
    owner: "codex",
    locked: true,
    effectiveModel: encodeOfficialCodexModelRef("gpt-other"),
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
        model: encodeOfficialCodexModelRef("after").id,
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
  assert.deepEqual(writes, [{ modelId: encodeOfficialCodexModelRef("after").id }]);
});

it("reads and changes the remote native model without consulting local defaults", async (t) => {
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
  const ref = () => encodeOfficialCodexModelRef(model ?? "unknown", tier);
  const inspection = {
    status: "ready",
    catalog: {
      models: [
        {
          ref: encodeOfficialCodexModelRef("gpt-6-astra"),
          fastModel: encodeOfficialCodexModelRef("gpt-6-astra", "priority"),
          label: "Astra",
          supportedThinkingOptionIds: ["high"],
        },
        {
          ref: encodeOfficialCodexModelRef("gpt-6-astra", "ultrafast"),
          label: "Astra · Ultrafast",
          supportedThinkingOptionIds: ["high"],
        },
        { ref: encodeOfficialCodexModelRef("gpt-other"), label: "Other" },
      ],
      defaultModel: encodeOfficialCodexModelRef("gpt-other"),
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
      const selection = decodeOfficialCodexModelSelection({ id: op.modelId } as ReturnType<
        typeof ref
      >);
      model = selection.model;
      tier = selection.serviceTier;
      writes++;
      return { effectiveModel: ref() };
    }
    throw Error("unexpected operation");
  });
  t.after(() => remote.close());
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
      id: encodeOfficialCodexModelRef("gpt-6-astra").id,
      name: "Astra",
      fastModel: encodeOfficialCodexModelRef("gpt-6-astra", "priority").id,
      ultrafastModel: encodeOfficialCodexModelRef("gpt-6-astra", "ultrafast").id,
      reasoning: { efforts: [{ id: "high", name: "High" }] },
    },
    {
      id: encodeOfficialCodexModelRef("gpt-6-astra", "ultrafast").id,
      name: "Astra · Ultrafast",
      reasoning: { efforts: [{ id: "high", name: "High" }] },
    },
    {
      id: encodeOfficialCodexModelRef("gpt-other").id,
      name: "Other",
      reasoning: { efforts: [{ id: "high", name: "High" }] },
    },
  ]);
  for (const [targetModel, targetTier] of [
    ["gpt-other", null],
    ["gpt-6-astra", "priority"],
    ["gpt-6-astra", "ultrafast"],
    ["gpt-6-astra", null],
  ] as const) {
    const target = encodeOfficialCodexModelRef(targetModel, targetTier);
    assert.ok((await call("session/selectModel", { provider: "codex", model: target.id })).ok);
    assert.equal(model, targetModel);
    assert.equal(tier, targetTier);
    assert.equal(ref().id, target.id);
    const view = await call("session/projections");
    assert.ok(view.ok);
    assert.equal(
      (view.value as { values: { modelSelection: { next: { model: string } } } }).values
        .modelSelection.next.model,
      target.id,
    );
  }
  assert.equal(writes, 4);
  assert.equal(
    (await call("session/selectModel", { provider: "claude-code", model: "wrong" })).ok,
    false,
  );
  await t.test(
    "clears an unreported speed tier when Standard is selected after reconnect",
    async () => {
      epoch = "two";
      tier = "ultrafast";
      await remote.read(id);
      const standard = { provider: "codex", model: encodeOfficialCodexModelRef("gpt-6-astra").id };
      assert.ok((await call("session/selectModel", standard)).ok);
      assert.equal(tier, null);
    },
  );
  epoch = "three";
  model = undefined;
  available = false;
  await remote.read(id);
  assert.equal((await call("session/modelCatalog")).ok, false);
  assert.equal(writes, 5);
});
