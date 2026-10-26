import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import type { HarnessOutput, HarnessSession } from "@codexhost/harness-adapter";
import {
  harnessInspectionSchema,
  harnessPermissionModeIdSchema,
  hostTurnIdSchema,
  nativeCheckpointRefSchema,
  nativeSessionRefSchema,
} from "@codexhost/shared-contracts";
import { DevinAdapter } from "../src/adapter.js";
import { devinModelRef, devinThinkingOptionId } from "../src/models.js";
import { devinHistorySteps } from "../src/history.js";
import { devinSnapshot } from "../src/projection.js";
import { DevinTransport, type DevinSessionInfo } from "../src/transport.js";

const cwd = process.cwd();
const sourceRef = nativeSessionRefSchema.parse({
  harnessId: "devin",
  nativeSessionId: "source",
  formatVersion: 1,
});
const checkpoint = (id: string) =>
  nativeCheckpointRefSchema.parse({
    harnessId: "devin",
    nativeSessionId: "source",
    checkpointId: id,
    formatVersion: 1,
  });
function replay(sessionId: string, keys: string[]): SessionNotification[] {
  return keys.flatMap((key) => [
    {
      sessionId,
      update: {
        sessionUpdate: "user_message_chunk" as const,
        content: { type: "text" as const, text: "same prompt" },
        _meta: { "cognition.ai/clientMessageId": key },
      },
    },
    {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk" as const,
        content: { type: "text" as const, text: `answer ${key}` },
      },
    },
  ]);
}
const baseInfo: DevinSessionInfo = {
  modes: {
    currentModeId: "ask",
    availableModes: [
      { id: "ask", name: "Ask" },
      { id: "plan", name: "Plan" },
    ],
  },
  configOptions: [
    {
      id: "model",
      category: "model",
      name: "Model",
      type: "select",
      currentValue: "a",
      options: ["a", "b"].map((value) => ({ value, name: value })),
    },
    {
      id: "effort",
      category: "thought_level",
      name: "Effort",
      type: "select",
      currentValue: "low",
      options: ["low", "high"].map((value) => ({ value, name: value })),
    },
    {
      id: "mode",
      name: "Mode",
      type: "select",
      currentValue: "ask",
      options: ["ask", "plan"].map((value) => ({ value, name: value })),
    },
  ],
};
let histories: Map<string, string[]>;
let infos: Map<string, DevinSessionInfo>;
let negotiated: boolean;
let adapter: DevinAdapter;
let opened: DevinTransport[];
const sourceBefore = () => structuredClone(histories.get("source"));
function present<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("Missing synthetic fixture value");
  return value;
}
async function value(result: Awaited<ReturnType<DevinAdapter["open"]>>): Promise<HarnessSession> {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
async function keys(session: HarnessSession) {
  const snapshot = await session.readSnapshot();
  if (!snapshot.ok) throw new Error(snapshot.error.message);
  return snapshot.value.turns.map((turn) => turn.nativeTurnRef.nativeTurnKey);
}

beforeEach(() => {
  histories = new Map([["source", ["u1", "u2", "u3"]]]);
  infos = new Map();
  negotiated = true;
  opened = [];
  adapter = new DevinAdapter({ environment: { BASE: "base" } });
  vi.spyOn(DevinTransport.prototype, "open").mockImplementation(async function (
    this: DevinTransport,
    id,
  ) {
    this.sessionId = id ?? "empty-child";
    this.nativeHistory = negotiated;
    this.replay = replay(this.sessionId, histories.get(this.sessionId) ?? []);
    opened.push(this);
    if (!histories.has(this.sessionId)) histories.set(this.sessionId, []);
    const info = { ...structuredClone(baseInfo), nativeHistory: negotiated };
    infos.set(this.sessionId, info);
    return info;
  });
  vi.spyOn(DevinTransport.prototype, "reload").mockImplementation(async function (
    this: DevinTransport,
  ) {
    return replay(this.sessionId, histories.get(this.sessionId) ?? []);
  });
  vi.spyOn(DevinTransport.prototype, "verifyCwd").mockResolvedValue();
  vi.spyOn(DevinTransport.prototype, "close").mockResolvedValue();
  vi.spyOn(DevinTransport.prototype, "historyRequest").mockImplementation(async function (
    this: DevinTransport,
    method,
    params,
  ) {
    const turns = histories.get(this.sessionId) ?? [];
    if (method === "listSteps")
      return {
        steps: [
          // Deliberately reordered and interleaved question steps: never map by position/text.
          ...turns
            .toReversed()
            .map((id) => ({ stepId: `step-${id}`, kind: "prompt", userMessageId: id })),
          { stepId: "question", kind: "questionAnswer", userMessageId: "u1" },
        ],
      };
    const index = turns.findIndex((key) => `step-${key}` === params?.stepId);
    histories.set("child", turns.slice(0, index + 1));
    return { forkedSessionId: "child" };
  });
  vi.spyOn(DevinTransport.prototype, "configure").mockImplementation(async function (
    this: DevinTransport,
    configId,
    selected,
  ) {
    const configOptions = present(present(infos.get(this.sessionId)).configOptions);
    const option = present(configOptions.find((option) => option.id === configId));
    option.currentValue = selected;
    return { configOptions: structuredClone(configOptions) };
  });
});
afterEach(async () => {
  await adapter.close();
  vi.restoreAllMocks();
});

describe("Devin exact native history", () => {
  it("negotiates capabilities consistently and maps only native prompt IDs to checkpoints", async () => {
    const inspection = await adapter.inspect({ cwd });
    expect(harnessInspectionSchema.safeParse(inspection).success).toBe(true);
    expect(inspection).toMatchObject({
      capabilities: { history: { fork: true, forkAcrossCwd: false, rollbackLastTurn: true } },
    });
    const session = await value(await adapter.open({ kind: "resume", nativeRef: sourceRef, cwd }));
    const snapshot = await session.readSnapshot();
    expect(
      snapshot.ok && snapshot.value.turns.map((turn) => turn.checkpoint?.checkpointId),
    ).toEqual(["step-u1", "step-u2", "step-u3"]);
    const raw = devinSnapshot("source", replay("source", ["u1"]));
    expect(raw.turns[0]).not.toHaveProperty("checkpoint");
  });
  it.each(["fork", "rollbackLastTurn"] as const)(
    "returns unsupported for unnegotiated %s without mutation",
    async (kind) => {
      negotiated = false;
      const inspection = await adapter.inspect({ cwd });
      expect(harnessInspectionSchema.safeParse(inspection).success).toBe(true);
      expect(inspection).toMatchObject({
        capabilities: { history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false } },
      });
      const result = await adapter.open({
        kind,
        sourceRef,
        checkpoint: checkpoint("step-u1"),
        cwd,
      });
      expect(result).toMatchObject({ ok: false, error: { code: "unsupported" } });
      expect(DevinTransport.prototype.historyRequest).not.toHaveBeenCalled();
      expect(histories.get("source")).toEqual(["u1", "u2", "u3"]);
    },
  );
  it.each([
    ["step-u2", ["u1", "u2"]],
    ["step-u3", ["u1", "u2", "u3"]],
  ] as const)("forks at %s and keeps the source intact", async (id, expected) => {
    const source = await value(await adapter.open({ kind: "resume", nativeRef: sourceRef, cwd }));
    const before = sourceBefore();
    const child = await value(
      await adapter.open({
        kind: "fork",
        sourceRef,
        checkpoint: checkpoint(id),
        cwd,
        environment: { THREAD_ONLY: "child", BASE: "override" },
      }),
    );
    expect(child.initialState.nativeRef?.nativeSessionId).toBe("child");
    expect(await keys(child)).toEqual(expected);
    expect(await keys(source)).toEqual(before);
    expect(histories.get("source")).toEqual(before);
    expect(
      opened.find((transport) => transport.sessionId === "child")?.options.environment,
    ).toEqual({ BASE: "override", THREAD_ONLY: "child" });
    expect(DevinTransport.prototype.historyRequest).toHaveBeenCalledWith("forkFromStep", {
      stepId: id,
    });
  });
  it("rejects stale and foreign checkpoints before forking", async () => {
    for (const cp of [
      checkpoint("missing"),
      { ...checkpoint("step-u1"), nativeSessionId: "other" },
    ]) {
      expect(await adapter.open({ kind: "fork", sourceRef, checkpoint: cp, cwd })).toMatchObject({
        ok: false,
        error: { code: "checkpointNotFound" },
      });
    }
    expect(DevinTransport.prototype.historyRequest).not.toHaveBeenCalledWith(
      "forkFromStep",
      expect.anything(),
    );
  });
  it("rejects cross-cwd derivation from a live source", async () => {
    await value(await adapter.open({ kind: "resume", nativeRef: sourceRef, cwd }));
    expect(
      await adapter.open({
        kind: "fork",
        sourceRef,
        checkpoint: checkpoint("step-u1"),
        cwd: "/other",
      }),
    ).toMatchObject({ ok: false, error: { code: "unsupported" } });
  });
  it.each([
    "native-error",
    "source-id",
    "missing-id",
    "wrong-prefix",
    "wrong-content",
    "opaque-payload",
    "child-load-error",
  ])("fails safely on %s", async (scenario) => {
    const original = present(
      vi.mocked(DevinTransport.prototype.historyRequest).getMockImplementation(),
    );
    vi.spyOn(DevinTransport.prototype, "historyRequest").mockImplementation(async function (
      this: DevinTransport,
      method,
      params,
    ) {
      if (method !== "forkFromStep") return original.call(this, method, params);
      if (scenario === "native-error") throw new Error("native fork failed");
      if (scenario === "source-id") return { forkedSessionId: "source" };
      if (scenario === "missing-id") return {};
      const response = await original.call(this, method, params);
      if (scenario === "wrong-prefix") histories.set("child", ["u2"]);
      return response;
    });
    if (scenario === "wrong-content" || scenario === "opaque-payload") {
      vi.spyOn(DevinTransport.prototype, "reload").mockImplementation(async function (
        this: DevinTransport,
      ) {
        const result = replay(this.sessionId, histories.get(this.sessionId) ?? []);
        if (this.sessionId === "child") {
          if (scenario === "wrong-content")
            present(result[1]).update = {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "wrong" },
            };
          else present(result[1]).update._meta = { opaqueNativePayload: "changed" };
        }
        return result;
      });
    }
    if (scenario === "child-load-error") {
      const originalOpen = present(
        vi.mocked(DevinTransport.prototype.open).getMockImplementation(),
      );
      vi.spyOn(DevinTransport.prototype, "open").mockImplementation(async function (
        this: DevinTransport,
        id,
      ) {
        if (id === "child") throw new Error("native child load failed");
        return originalOpen.call(this, id);
      });
    }
    const before = sourceBefore();
    const result = await adapter.open({
      kind: "fork",
      sourceRef,
      checkpoint: checkpoint("step-u2"),
      cwd,
    });
    expect(result).toMatchObject({ ok: false });
    expect(histories.get("source")).toEqual(before);
    expect(DevinTransport.prototype.close).toHaveBeenCalled();
    if (["wrong-prefix", "wrong-content", "opaque-payload", "child-load-error"].includes(scenario))
      expect(!result.ok && result.error.message).toContain("may remain on disk");
  });
  it.each([["u1", "u2", "u3"], ["u1"]])(
    "rolls back %j via an independent Session and preserves configuration",
    async (...turns) => {
      histories.set("source", turns);
      const result = await adapter.open({
        kind: "rollbackLastTurn",
        sourceRef,
        cwd,
        model: devinModelRef("b"),
        thinkingOptionId: devinThinkingOptionId("high"),
        permissionModeId: harnessPermissionModeIdSchema.parse("plan"),
      });
      const child = await value(result);
      expect(await keys(child)).toEqual(turns.slice(0, -1));
      expect(child.initialState).toMatchObject({
        effectiveModel: devinModelRef("b"),
        effectiveThinkingOptionId: devinThinkingOptionId("high"),
        effectivePermissionModeId: "plan",
      });
      expect(child.initialState.nativeRef?.nativeSessionId).not.toBe("source");
      expect(histories.get("source")).toEqual(turns);
      if (turns.length === 1)
        expect(DevinTransport.prototype.historyRequest).not.toHaveBeenCalledWith(
          "forkFromStep",
          expect.anything(),
        );
      const prompt = vi.spyOn(DevinTransport.prototype, "prompt").mockResolvedValue({
        stopReason: "end_turn",
        _meta: { "cognition.ai/userMessageId": "continued" },
      });
      expect(
        await child.execute({
          type: "turn.start",
          turnId: hostTurnIdSchema.parse("next"),
          input: [{ type: "text", text: "continue" }],
        }),
      ).toMatchObject({ ok: true });
      await vi.waitFor(() => expect(prompt).toHaveBeenCalledOnce());
    },
  );
  it("detects source history changes instead of returning a child", async () => {
    const original = present(
      vi.mocked(DevinTransport.prototype.historyRequest).getMockImplementation(),
    );
    vi.spyOn(DevinTransport.prototype, "historyRequest").mockImplementation(async function (
      this: DevinTransport,
      method,
      params,
    ) {
      const result = await original.call(this, method, params);
      if (method === "forkFromStep") histories.set("source", ["u1", "u2"]);
      return result;
    });
    const result = await adapter.open({
      kind: "fork",
      sourceRef,
      checkpoint: checkpoint("step-u1"),
      cwd,
    });
    expect(result).toMatchObject({ ok: false });
    expect(!result.ok && result.error.message).toContain("source history changed");
  });
  it("checks combined configuration after the final permission selection", async () => {
    const original = present(vi.mocked(DevinTransport.prototype.configure).getMockImplementation());
    vi.spyOn(DevinTransport.prototype, "configure").mockImplementation(async function (
      this: DevinTransport,
      configId,
      selected,
    ) {
      const result = await original.call(this, configId, selected);
      if (configId === "mode")
        present(result.configOptions.find((option) => option.id === "model")).currentValue = "a";
      return result;
    });
    const result = await adapter.open({
      kind: "rollbackLastTurn",
      sourceRef,
      cwd,
      model: devinModelRef("b"),
      permissionModeId: harnessPermissionModeIdSchema.parse("plan"),
    });
    expect(result).toMatchObject({ ok: false });
    expect(!result.ok && result.error.message).toContain("did not preserve");
    expect(histories.get("source")).toEqual(["u1", "u2", "u3"]);
  });
  it("rejects empty rollback without creating a child", async () => {
    histories.set("source", []);
    expect(await adapter.open({ kind: "rollbackLastTurn", sourceRef, cwd })).toMatchObject({
      ok: false,
      error: { code: "invalidState" },
    });
    expect(opened.map((transport) => transport.sessionId)).toEqual(["source"]);
  });
  it("closes a derived child when configuration cannot be preserved", async () => {
    vi.spyOn(DevinTransport.prototype, "configure").mockRejectedValue(new Error("config failed"));
    const result = await adapter.open({
      kind: "rollbackLastTurn",
      sourceRef,
      cwd,
      model: devinModelRef("b"),
    });
    expect(result).toMatchObject({ ok: false });
    expect(!result.ok && result.error.message).toContain("native child child may remain");
    expect(histories.get("source")).toEqual(["u1", "u2", "u3"]);
    expect(DevinTransport.prototype.close).toHaveBeenCalled();
  });
  it("rejects history during an active Turn and reserves a source during derivation", async () => {
    const source = await value(await adapter.open({ kind: "resume", nativeRef: sourceRef, cwd }));
    let finish!: (result: { stopReason: "end_turn" }) => void;
    vi.spyOn(DevinTransport.prototype, "prompt").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await source.execute({
      type: "turn.start",
      turnId: hostTurnIdSchema.parse("active"),
      input: [{ type: "text", text: "hello" }],
    });
    expect(await adapter.open({ kind: "rollbackLastTurn", sourceRef, cwd })).toMatchObject({
      ok: false,
      error: { code: "sessionBusy", retryable: true },
    });
    finish({ stopReason: "end_turn" });
    await vi.waitFor(async () => expect((await source.readSnapshot()).ok).toBe(true));
    let release!: () => void;
    vi.spyOn(DevinTransport.prototype, "verifyCwd").mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const deriving = adapter.open({
      kind: "fork",
      sourceRef,
      checkpoint: checkpoint("step-u1"),
      cwd,
    });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    expect(
      await source.execute({
        type: "turn.start",
        turnId: hostTurnIdSchema.parse("racing"),
        input: [{ type: "text", text: "hello" }],
      }),
    ).toMatchObject({ ok: false, error: { code: "sessionBusy" } });
    release();
    await deriving;
  });
  it("reports checkpoint discovery failure without falsifying a settled Turn outcome", async () => {
    const source = await value(await adapter.open({ kind: "resume", nativeRef: sourceRef, cwd }));
    const outputs: HarnessOutput[] = [];
    const done = (async () => {
      for await (const output of source.outputs) outputs.push(output);
    })();
    vi.spyOn(DevinTransport.prototype, "prompt").mockResolvedValue({
      stopReason: "end_turn",
      _meta: { "cognition.ai/userMessageId": "settled" },
    });
    vi.spyOn(DevinTransport.prototype, "historyRequest").mockRejectedValue(
      new Error("listSteps failed"),
    );
    await source.execute({
      type: "turn.start",
      turnId: hostTurnIdSchema.parse("settled"),
      input: [{ type: "text", text: "hello" }],
    });
    await done;
    expect(outputs).toContainEqual(
      expect.objectContaining({
        event: expect.objectContaining({
          type: "turn.completed",
          outcome: { status: "succeeded" },
          nativeTurnRef: expect.objectContaining({ nativeTurnKey: "settled" }),
        }),
      }),
    );
    expect(outputs).toContainEqual(
      expect.objectContaining({
        event: expect.objectContaining({
          type: "session.faulted",
          error: expect.objectContaining({ message: "listSteps failed" }),
        }),
      }),
    );
  });
  it("rejects malformed and ambiguous native steps instead of guessing", async () => {
    expect(() => devinHistorySteps({ steps: [{ stepId: "s" }] })).toThrow();
    vi.spyOn(DevinTransport.prototype, "historyRequest").mockResolvedValue({
      steps: [
        { stepId: "a", kind: "prompt", userMessageId: "u1" },
        { stepId: "b", kind: "prompt", userMessageId: "u1" },
      ],
    });
    expect(
      await adapter.open({ kind: "fork", sourceRef, checkpoint: checkpoint("a"), cwd }),
    ).toMatchObject({ ok: false });
  });
});
