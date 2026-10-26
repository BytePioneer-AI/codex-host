import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import type { HarnessOutput, HarnessSessionState } from "@codexhost/harness-adapter";
import {
  harnessInspectionSchema,
  harnessThinkingOptionIdSchema,
  hostTurnIdSchema,
  nativeSessionRefSchema,
} from "@codexhost/shared-contracts";
import { DevinAdapter, DevinSession } from "../src/adapter.js";
import { devinCatalog, devinModelRef, devinThinkingOptionId } from "../src/models.js";
import { DevinTransport, type DevinSessionInfo } from "../src/transport.js";

const thinkingId = "native/compute-budget";
const modelId = "native/model-picker";
const low = devinThinkingOptionId("budget: low");
const high = devinThinkingOptionId("budget: high");
const nativeRef = nativeSessionRefSchema.parse({
  harnessId: "devin",
  nativeSessionId: "thinking-session",
  formatVersion: 1,
});
function thinking(
  values = ["budget: low", "budget: high"],
  currentValue = values[0] ?? "",
): SessionConfigOption {
  return {
    id: thinkingId,
    category: "thought_level",
    name: "Compute",
    type: "select",
    currentValue,
    options: [
      {
        group: "budgets",
        name: "Budgets",
        options: values.map((value) => ({ value, name: `Native ${value}` })),
      },
    ],
  };
}
function info(selector: SessionConfigOption | undefined = thinking(), model = "swe-2-high") {
  return {
    sessionId: nativeRef.nativeSessionId,
    modes: { currentModeId: "ask", availableModes: [{ id: "ask", name: "Ask" }] },
    configOptions: [
      {
        id: modelId,
        category: "model",
        name: "Model",
        type: "select",
        currentValue: model,
        options: ["swe-2-high", "other-low"].map((value) => ({ value, name: value })),
      },
      {
        id: "speed",
        category: "model_config",
        name: "Speed",
        type: "select",
        currentValue: "fast",
        options: [{ value: "fast", name: "Fast" }],
      },
      ...(selector ? [selector] : []),
    ],
  } satisfies DevinSessionInfo;
}
function withoutThinking() {
  const result = info();
  result.configOptions = result.configOptions.filter(
    ({ category }) => category !== "thought_level",
  );
  return result;
}
function fixture(initial = info()) {
  const transport = new DevinTransport({ cwd: process.cwd(), environment: {} });
  transport.sessionId = nativeRef.nativeSessionId;
  const configure = vi.spyOn(transport, "configure").mockImplementation(async (id, value) => ({
    configOptions: (session.info.configOptions ?? []).map((option) =>
      option.id === id ? ({ ...option, currentValue: value } as SessionConfigOption) : option,
    ),
  }));
  vi.spyOn(transport, "close").mockResolvedValue();
  const turn = Promise.withResolvers<Awaited<ReturnType<DevinTransport["prompt"]>>>();
  vi.spyOn(transport, "prompt").mockReturnValue(turn.promise);
  const cancel = vi.spyOn(transport, "cancel").mockImplementation(async () => {
    turn.resolve({ stopReason: "cancelled" });
  });
  const session = new DevinSession(transport, structuredClone(initial), () => {});
  const outputs: HarnessOutput[] = [];
  const done = (async () => {
    for await (const output of session.outputs) outputs.push(output);
  })();
  return {
    session,
    transport,
    configure,
    turn,
    cancel,
    outputs,
    async close() {
      turn.resolve({ stopReason: "cancelled" });
      await session.close();
      await done;
    },
  };
}
const start = {
  type: "turn.start" as const,
  turnId: hostTurnIdSchema.parse("thinking-turn"),
  input: [{ type: "text" as const, text: "hello" }],
};
function states(outputs: HarnessOutput[]): HarnessSessionState[] {
  return outputs.flatMap((output) =>
    output.kind === "event" && output.event.type === "session.state.changed"
      ? [output.event.state]
      : [],
  );
}
afterEach(() => vi.restoreAllMocks());

describe("Devin native Thinking discovery", () => {
  it("inspects category-based grouped options, native labels and the current Model only", async () => {
    const open = vi.spyOn(DevinTransport.prototype, "open").mockResolvedValue(info());
    const close = vi.spyOn(DevinTransport.prototype, "close").mockResolvedValue();
    const adapter = new DevinAdapter({ environment: {} });
    try {
      const result = await adapter.inspect();
      expect(harnessInspectionSchema.safeParse(result).success).toBe(true);
      expect(result).toMatchObject({
        status: "ready",
        capabilities: { configuration: { selectThinkingOption: true } },
        catalog: {
          thinkingOptions: [
            { id: low, label: "Native budget: low" },
            { id: high, label: "Native budget: high" },
          ],
          defaultThinkingOptionId: low,
        },
      });
      const catalog = devinCatalog(info());
      expect(catalog.models[0]?.supportedThinkingOptionIds).toEqual([low, high]);
      expect(catalog.models[1]).not.toHaveProperty("supportedThinkingOptionIds");
      await adapter.inspect();
      expect(open).toHaveBeenCalledTimes(1);
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      await adapter.close();
    }
  });
  it.each([undefined, "model_config", "_reasoning", "unknown"])(
    "does not infer Thinking from names, IDs, suffixes or category %s",
    async (category) => {
      const selector = { ...thinking(), id: "thinking", name: "Reasoning effort" };
      if (category === undefined) delete selector.category;
      else selector.category = category;
      const initial = info(selector);
      vi.spyOn(DevinTransport.prototype, "open").mockResolvedValue(initial);
      vi.spyOn(DevinTransport.prototype, "close").mockResolvedValue();
      const adapter = new DevinAdapter({ environment: {} });
      const f = fixture(initial);
      try {
        expect(await adapter.inspect()).toMatchObject({
          status: "ready",
          capabilities: { configuration: { selectThinkingOption: false } },
          catalog: { thinkingOptions: [] },
        });
        expect(f.session.initialState).toMatchObject({ availableThinkingOptions: [] });
        expect(f.session.initialState).not.toHaveProperty("effectiveThinkingOptionId");
        expect(
          await f.session.execute({ type: "thinking.select", thinkingOptionId: high }),
        ).toMatchObject({ ok: false, error: { code: "unsupported" } });
        expect(f.configure).not.toHaveBeenCalled();
      } finally {
        await f.close();
        await adapter.close();
      }
    },
  );
  it("uses ACP priority order when multiple thought selectors are advertised", () => {
    const initial = info();
    initial.configOptions.push({ ...thinking(["other"]), id: "second" });
    expect(devinCatalog(initial).thinkingOptions.map(({ id }) => id)).toEqual([low, high]);
  });
  it("does not advertise empty or boolean thought selectors", () => {
    for (const selector of [
      thinking([], "none"),
      {
        id: "toggle",
        name: "Thoughts",
        category: "thought_level",
        type: "boolean" as const,
        currentValue: true,
      },
    ]) {
      expect(devinCatalog(info(selector)).thinkingOptions).toEqual([]);
    }
  });
  it("rejects an inconsistent native current value instead of claiming a default", () => {
    expect(() => devinCatalog(info(thinking(["low"], "missing")))).toThrow(/current value/);
  });
});

describe("Devin Thinking selection and native state", () => {
  it.each([false, true])(
    "confirms selection before completion (running=%s), without interrupting the Turn",
    async (running) => {
      const f = fixture();
      const pending = Promise.withResolvers<Awaited<ReturnType<DevinTransport["configure"]>>>();
      f.configure.mockReturnValue(pending.promise);
      try {
        if (running) await f.session.execute(start);
        const selection = f.session.execute({ type: "thinking.select", thinkingOptionId: high });
        expect(f.configure).toHaveBeenCalledWith(thinkingId, "budget: high");
        expect(f.session.initialState.effectiveThinkingOptionId).toBe(low);
        expect(states(f.outputs)).toEqual([]);
        expect(
          await f.session.execute({ type: "model.select", model: devinModelRef("other-low") }),
        ).toMatchObject({ ok: false, error: { code: "sessionBusy" } });
        expect(
          await f.session.execute({ type: "thinking.select", thinkingOptionId: low }),
        ).toMatchObject({ ok: false, error: { code: "sessionBusy" } });
        expect(await f.session.readSnapshot()).toMatchObject({
          ok: false,
          error: { code: "sessionBusy" },
        });
        pending.resolve({
          configOptions: info(thinking(undefined, "budget: high")).configOptions,
        });
        expect(await selection).toEqual({ ok: true, value: { completed: true } });
        expect(f.session.initialState.effectiveThinkingOptionId).toBe(high);
        expect(states(f.outputs).at(-1)?.effectiveThinkingOptionId).toBe(high);
        expect(f.cancel).not.toHaveBeenCalled();
        expect(f.outputs.some((o) => o.kind === "event" && o.event.type === "turn.completed")).toBe(
          false,
        );
      } finally {
        pending.resolve({ configOptions: info().configOptions });
        await f.close();
      }
    },
  );
  it.each(["invalid", "rejected", "unconfirmed"])(
    "does not claim requested state on %s selection",
    async (failure) => {
      const f = fixture();
      if (failure === "rejected") f.configure.mockRejectedValue(new Error("Native refused"));
      if (failure === "unconfirmed")
        f.configure.mockResolvedValue({ configOptions: info().configOptions });
      try {
        await f.session.execute(start);
        expect(
          await f.session.execute({
            type: "thinking.select",
            thinkingOptionId:
              failure === "invalid" ? harnessThinkingOptionIdSchema.parse("unknown") : high,
          }),
        ).toMatchObject({
          ok: false,
          error: { code: failure === "invalid" ? "invalidRequest" : "protocolError" },
        });
        expect(f.session.initialState.effectiveThinkingOptionId).toBe(low);
        expect(states(f.outputs)).toEqual([]);
        expect(f.cancel).not.toHaveBeenCalled();
        if (failure === "invalid") expect(f.configure).not.toHaveBeenCalled();
      } finally {
        await f.close();
      }
    },
  );
  it("keeps cancellation available during Thinking configuration", async () => {
    const f = fixture();
    const pending = Promise.withResolvers<Awaited<ReturnType<DevinTransport["configure"]>>>();
    f.configure.mockReturnValue(pending.promise);
    try {
      await f.session.execute(start);
      const selection = f.session.execute({ type: "thinking.select", thinkingOptionId: high });
      expect((await f.session.execute({ type: "turn.cancel", turnId: start.turnId })).ok).toBe(
        true,
      );
      pending.resolve({ configOptions: info(thinking(undefined, "budget: high")).configOptions });
      expect((await selection).ok).toBe(true);
      expect(f.cancel).toHaveBeenCalledOnce();
    } finally {
      pending.resolve({ configOptions: info().configOptions });
      await f.close();
    }
  });
  it("replaces dependent options and effective Thinking on Model changes, including removal", async () => {
    const f = fixture();
    try {
      const changed = info({ ...thinking(["new"], "new"), id: "new/selector" }, "other-low");
      f.configure.mockResolvedValueOnce({ configOptions: changed.configOptions });
      expect(
        (await f.session.execute({ type: "model.select", model: devinModelRef("other-low") })).ok,
      ).toBe(true);
      expect(f.session.initialState).toMatchObject({
        effectiveModel: devinModelRef("other-low"),
        effectiveThinkingOptionId: devinThinkingOptionId("new"),
        availableThinkingOptions: [{ id: devinThinkingOptionId("new"), label: "Native new" }],
      });
      expect(
        await f.session.execute({ type: "thinking.select", thinkingOptionId: high }),
      ).toMatchObject({ ok: false, error: { code: "invalidRequest" } });
      expect(
        (
          await f.session.execute({
            type: "thinking.select",
            thinkingOptionId: devinThinkingOptionId("new"),
          })
        ).ok,
      ).toBe(true);
      expect(f.configure).toHaveBeenLastCalledWith("new/selector", "new");
      f.configure.mockResolvedValueOnce({ configOptions: withoutThinking().configOptions });
      expect(
        (await f.session.execute({ type: "model.select", model: devinModelRef("swe-2-high") })).ok,
      ).toBe(true);
      expect(f.session.initialState.availableThinkingOptions).toEqual([]);
      expect(f.session.initialState).not.toHaveProperty("effectiveThinkingOptionId");
      expect(f.session.capabilities.configuration.selectThinkingOption).toBe(false);
      expect(
        await f.session.execute({ type: "thinking.select", thinkingOptionId: high }),
      ).toMatchObject({ ok: false, error: { code: "unsupported" } });
      expect((await f.session.readSnapshot()).ok).toBe(true);
    } finally {
      await f.close();
    }
  });
  it("publishes actual native readback even if the requested selection was not activated", async () => {
    const f = fixture();
    f.configure.mockResolvedValue({
      configOptions: info(thinking(["corrected"], "corrected")).configOptions,
    });
    try {
      expect(
        await f.session.execute({ type: "thinking.select", thinkingOptionId: high }),
      ).toMatchObject({ ok: false });
      expect(f.session.initialState.effectiveThinkingOptionId).toBe(
        devinThinkingOptionId("corrected"),
      );
    } finally {
      await f.close();
    }
  });
  it("does not publish a configuration response arriving after close", async () => {
    const f = fixture();
    const pending = Promise.withResolvers<Awaited<ReturnType<DevinTransport["configure"]>>>();
    f.configure.mockReturnValue(pending.promise);
    const selection = f.session.execute({ type: "thinking.select", thinkingOptionId: high });
    await f.close();
    pending.resolve({ configOptions: info(thinking(undefined, "budget: high")).configOptions });
    expect(await selection).toMatchObject({ ok: false, error: { code: "invalidState" } });
    expect(f.session.initialState.effectiveThinkingOptionId).toBe(low);
    expect(states(f.outputs)).toEqual([]);
  });
});

describe("Devin create/resume Thinking hints", () => {
  it.each(["create", "resume"] as const)(
    "rejects stale %s Thinking hints after native Model-dependent options change",
    async (kind) => {
      vi.spyOn(DevinTransport.prototype, "open").mockImplementation(async function (
        this: DevinTransport,
      ) {
        this.sessionId = nativeRef.nativeSessionId;
        return info();
      });
      const close = vi.spyOn(DevinTransport.prototype, "close").mockResolvedValue();
      const changed = info(thinking(["new"], "new"), "other-low");
      const configure = vi
        .spyOn(DevinTransport.prototype, "configure")
        .mockResolvedValue({ configOptions: changed.configOptions });
      const adapter = new DevinAdapter({ environment: {} });
      try {
        expect(
          await adapter.open({
            kind,
            nativeRef,
            cwd: process.cwd(),
            model: devinModelRef("other-low"),
            thinkingOptionId: high,
          }),
        ).toMatchObject({ ok: false, error: { code: "invalidRequest" } });
        expect(configure.mock.calls).toEqual([[modelId, "other-low"]]);
        expect(close).toHaveBeenCalledOnce();
      } finally {
        await adapter.close();
      }
    },
  );
  it.each(["create", "resume"] as const)(
    "applies %s Model then validates Thinking against the returned native options",
    async (kind) => {
      vi.spyOn(DevinTransport.prototype, "open").mockImplementation(async function (
        this: DevinTransport,
      ) {
        this.sessionId = nativeRef.nativeSessionId;
        return info();
      });
      const close = vi.spyOn(DevinTransport.prototype, "close").mockResolvedValue();
      const changed = info(thinking(["new"], "new"), "other-low");
      const configure = vi
        .spyOn(DevinTransport.prototype, "configure")
        .mockResolvedValue({ configOptions: changed.configOptions });
      const adapter = new DevinAdapter({ environment: {} });
      try {
        const result = await adapter.open({
          kind,
          nativeRef,
          cwd: process.cwd(),
          model: devinModelRef("other-low"),
          thinkingOptionId: devinThinkingOptionId("new"),
        });
        expect(configure.mock.calls).toEqual([
          [modelId, "other-low"],
          [thinkingId, "new"],
        ]);
        expect(result.ok && result.value.initialState.effectiveThinkingOptionId).toBe(
          devinThinkingOptionId("new"),
        );
        expect(result.ok && result.value.initialState.nativeRef).toEqual(nativeRef);
        expect(close).not.toHaveBeenCalled();
      } finally {
        await adapter.close();
      }
    },
  );
  it.each(["create", "resume"] as const)(
    "leaves %s native defaults untouched when hints are omitted",
    async (kind) => {
      vi.spyOn(DevinTransport.prototype, "open").mockImplementation(async function (
        this: DevinTransport,
      ) {
        this.sessionId = nativeRef.nativeSessionId;
        return info(thinking(undefined, "budget: high"));
      });
      vi.spyOn(DevinTransport.prototype, "close").mockResolvedValue();
      const configure = vi.spyOn(DevinTransport.prototype, "configure");
      const adapter = new DevinAdapter({ environment: {} });
      try {
        const result = await adapter.open({ kind, nativeRef, cwd: process.cwd() });
        expect(result.ok && result.value.initialState.effectiveThinkingOptionId).toBe(high);
        expect(configure).not.toHaveBeenCalled();
      } finally {
        await adapter.close();
      }
    },
  );
  it.each(["create", "resume"] as const)(
    "returns typed unsupported for %s hints on an old CLI",
    async (kind) => {
      vi.spyOn(DevinTransport.prototype, "open").mockImplementation(async function (
        this: DevinTransport,
      ) {
        this.sessionId = nativeRef.nativeSessionId;
        return withoutThinking();
      });
      const close = vi.spyOn(DevinTransport.prototype, "close").mockResolvedValue();
      const configure = vi.spyOn(DevinTransport.prototype, "configure");
      const adapter = new DevinAdapter({ environment: {} });
      try {
        expect(
          await adapter.open({ kind, nativeRef, cwd: process.cwd(), thinkingOptionId: high }),
        ).toMatchObject({ ok: false, error: { code: "unsupported" } });
        expect(configure).not.toHaveBeenCalled();
        expect(close).toHaveBeenCalledOnce();
      } finally {
        await adapter.close();
      }
    },
  );
});
