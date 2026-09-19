import { afterEach, describe, expect, it, vi } from "vitest";
import { hostTurnIdSchema } from "@codexhost/shared-contracts";
import type { HarnessOutput } from "@codexhost/harness-adapter";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { CursorAdapter, CursorSession } from "../src/adapter.js";
import { CursorTransport, type CursorSessionInfo } from "../src/transport.js";
import { cursorCatalog, cursorModelRef, cursorModelSelection } from "../src/models.js";
import { cursorThinking, cursorThinkingState } from "../src/thinking.js";
import { cursorCommands, cursorCommandPrompt } from "../src/slash-commands.js";

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing test fixture");
  return value;
}

const history = vi.hoisted(() => ({ turns: [] as Array<{ id: string; text: string }> }));
vi.mock("../src/native-history.js", () => ({
  readCursorNativeTurns: () => structuredClone(history.turns),
  readCursorNativeHistory: () => ({
    revision: JSON.stringify(history.turns),
    turns: structuredClone(history.turns),
  }),
}));
const select = (
  id: string,
  currentValue: string,
  values: string[],
  category = "thought_level",
): SessionConfigOption & { type: "select" } => ({
  id,
  name: id,
  type: "select",
  currentValue,
  category,
  options: values.map((value) => ({ value, name: value })),
});
const model = select("model", "alpha", ["alpha", "auto"], "model");
const thinking = select("thinking", "true", ["false", "true"]);
const effort = select("effort", "high", ["low", "high"]);
const context = select("context", "200k", ["200k", "1m"], "model_config");
const info: CursorSessionInfo = {
  sessionId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  configOptions: [model, thinking, effort, context],
  nativeModels: [
    { value: "alpha", name: "Alpha", configOptions: [thinking, effort, context] },
    { value: "auto", name: "Auto", configOptions: [] },
  ],
};
const turnId = hostTurnIdSchema.parse("commands-test");
function setup() {
  const transport = new CursorTransport({ cwd: process.cwd(), environment: {} });
  transport.sessionId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  let options = structuredClone(info.configOptions ?? []);
  vi.spyOn(transport, "configure").mockImplementation(async (id, value) => {
    if (id === "model" && value === "auto")
      options = [select("model", "auto", ["alpha", "auto"], "model")];
    else
      options = options.map((option) =>
        option.id === id ? ({ ...option, currentValue: value } as SessionConfigOption) : option,
      );
    return { configOptions: structuredClone(options) };
  });
  vi.spyOn(transport, "close").mockResolvedValue();
  const session = new CursorSession(transport, info, () => {});
  const outputs: HarnessOutput[] = [];
  const done = (async () => {
    for await (const output of session.outputs) outputs.push(output);
  })();
  return { transport, session, outputs, done };
}
afterEach(() => {
  vi.restoreAllMocks();
  history.turns = [];
});

describe("Cursor parameterized Thinking", () => {
  it("preserves each native thinking parameter and excludes unrelated model settings", () => {
    const catalog = cursorCatalog(info);
    expect(catalog.thinkingOptions).toHaveLength(4);
    expect(catalog.models[0]?.supportedThinkingOptionIds).toHaveLength(4);
    expect(catalog.models[1]?.supportedThinkingOptionIds).toEqual([]);
    expect(
      cursorThinking(info.configOptions).every(({ values }) =>
        values.every(([id]) => id !== "context"),
      ),
    ).toBe(true);
  });
  it("confirms Thinking during an active turn and clears it when the next model lacks it", async () => {
    const f = setup();
    const pending = Promise.withResolvers<{ stopReason: "cancelled" }>();
    vi.spyOn(f.transport, "prompt").mockReturnValue(pending.promise);
    try {
      await f.session.execute({
        type: "turn.start",
        turnId,
        input: [{ type: "text", text: "work" }],
      });
      const option = cursorThinking(info.configOptions).find(({ values }) =>
        values.some(([id, value]) => id === "effort" && value === "low"),
      );
      if (!option) throw new Error("missing thinking option");
      expect(
        await f.session.execute({ type: "thinking.select", thinkingOptionId: option.id }),
      ).toEqual({ ok: true, value: { completed: true } });
      expect(f.session.initialState.effectiveThinkingOptionId).toBe(option.id);
      expect(f.transport.configure).not.toHaveBeenCalledWith("context", expect.anything());
      expect(
        await f.session.execute({ type: "model.select", model: cursorModelRef("auto") }),
      ).toMatchObject({ ok: true });
      expect(f.session.initialState.effectiveThinkingOptionId).toBeUndefined();
      expect(f.session.initialState.availableThinkingOptions).toEqual([]);
    } finally {
      pending.resolve({ stopReason: "cancelled" });
      await f.session.close();
      await f.done;
    }
  });
  it("does not publish a requested selection when native confirmation fails", async () => {
    const f = setup();
    vi.spyOn(f.transport, "configure").mockResolvedValue({ configOptions: [] });
    const original = structuredClone(f.session.initialState);
    try {
      expect(
        await f.session.execute({
          type: "thinking.select",
          thinkingOptionId: required(cursorThinking(info.configOptions)[0]).id,
        }),
      ).toMatchObject({ ok: false });
      expect(f.session.initialState).toEqual(original);
    } finally {
      await f.session.close();
      await f.done;
    }
  });
  it("reports the last confirmed state if the second parameter write fails", async () => {
    const f = setup();
    const original = required(vi.mocked(f.transport.configure).getMockImplementation());
    vi.spyOn(f.transport, "configure").mockImplementation((id, value) =>
      id === "effort" ? Promise.reject(new Error("native rejected effort")) : original(id, value),
    );
    try {
      const option = required(cursorThinking(info.configOptions)[0]);
      expect(
        await f.session.execute({ type: "thinking.select", thinkingOptionId: option.id }),
      ).toMatchObject({ ok: false });
      expect(f.session.initialState).toMatchObject(
        cursorThinkingState({
          configOptions: [model, { ...thinking, currentValue: "false" }, effort],
        }),
      );
    } finally {
      await f.session.close();
      await f.done;
    }
  });
  it("restores non-Thinking parameters from the saved effective Model Ref", async () => {
    const f = setup();
    await f.session.execute({ type: "model.select", model: cursorModelRef("alpha[context=1m]") });
    const saved = structuredClone(f.session.initialState);
    expect(saved.effectiveModel).toEqual(cursorModelRef("alpha[context=1m]"));
    await f.session.close();
    await f.done;
    vi.spyOn(CursorTransport.prototype, "open").mockImplementation(async function (
      this: CursorTransport,
    ) {
      this.sessionId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
      return structuredClone(info);
    });
    vi.spyOn(CursorTransport.prototype, "close").mockResolvedValue();
    let config = structuredClone(info.configOptions ?? []);
    const configure = vi
      .spyOn(CursorTransport.prototype, "configure")
      .mockImplementation(async (id, value) => {
        config = config.map((entry) =>
          entry.id === id ? ({ ...entry, currentValue: value } as SessionConfigOption) : entry,
        );
        return { configOptions: structuredClone(config) };
      });
    const adapter = new CursorAdapter();
    try {
      const resumed = await adapter.open({
        kind: "resume",
        cwd: process.cwd(),
        nativeRef: required(saved.nativeRef),
        model: required(saved.effectiveModel),
      });
      if (!resumed.ok) throw Error(resumed.error.message);
      expect(configure).toHaveBeenCalledWith("context", "1m");
      expect(resumed.value.initialState.effectiveModel).toEqual(saved.effectiveModel);
    } finally {
      await adapter.close();
    }
  });
  it("validates every legacy variant parameter before modifying native configuration", () => {
    expect(
      cursorModelSelection(info, cursorModelRef("alpha[thinking=true,context=1m,effort=low]").id),
    ).toEqual([
      ["model", "alpha"],
      ["thinking", "true"],
      ["context", "1m"],
      ["effort", "low"],
    ]);
    expect(() => cursorModelSelection(info, cursorModelRef("alpha[unknown=true]").id)).toThrow();
    expect(() =>
      cursorModelSelection(info, cursorModelRef("alpha[effort=imaginary]").id),
    ).toThrow();
    expect(() =>
      cursorModelSelection(info, cursorModelRef("alpha[effort=low,effort=high]").id),
    ).toThrow();
  });
});

describe("Cursor advertised slash commands", () => {
  const native = [
    { name: "review", description: "Review changes" },
    { name: "copy-request-id", description: "Copy request ID" },
  ];
  it("honors explicit native command input while retaining legacy custom arguments", () => {
    const catalog = cursorCommands([
      ...native,
      { name: "status", description: "Native local status", input: null },
      { name: "search", description: "Search", input: { hint: "query" } },
    ]);
    expect(catalog.commands.map(({ id, argumentMode }) => [id, argumentMode])).toEqual([
      ["cursor.review", "text"],
      ["cursor.copy-request-id", "none"],
      ["cursor.status", "none"],
      ["cursor.search", "text"],
    ]);
    expect(
      cursorCommandPrompt(
        { turnId, commandId: "cursor.status", arguments: { text: "x" } },
        catalog,
      ),
    ).toMatchObject({ error: { code: "invalidRequest" } });
  });
  it("rejects unadvertised commands and invalid arguments", () => {
    const catalog = cursorCommands(native);
    expect(cursorCommandPrompt({ turnId, commandId: "cursor.compact" }, catalog)).toMatchObject({
      error: { code: "unsupported" },
    });
    expect(
      cursorCommandPrompt(
        { turnId, commandId: "cursor.review", arguments: { unexpected: true } },
        catalog,
      ),
    ).toMatchObject({ error: { code: "invalidRequest" } });
    expect(
      cursorCommandPrompt(
        { turnId, commandId: "cursor.copy-request-id", arguments: { text: "x" } },
        catalog,
      ),
    ).toMatchObject({ ok: false });
    expect(
      cursorCommandPrompt(
        { turnId, commandId: "cursor.review", arguments: { text: "latest changes" } },
        catalog,
      ),
    ).toEqual({ ok: true, value: "/review latest changes" });
  });
  it.each(["review", "copy-request-id"])("uses native history semantics for %s", async (name) => {
    const f = setup();
    f.transport.availableCommands = native;
    const prompt = vi.spyOn(f.transport, "prompt").mockImplementation(async (text, callbacks) => {
      callbacks.update({
        sessionId: f.transport.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "native output" },
        },
      });
      if (name === "review") history.turns.push({ id: "native-command-turn", text });
      return { stopReason: "end_turn" };
    });
    try {
      expect(
        await f.session.commands.execute({ turnId, commandId: `cursor.${name}` }),
      ).toMatchObject({ ok: true });
      await vi.waitFor(() =>
        expect(
          f.outputs.some(
            (output) => output.kind === "event" && output.event.type === "turn.completed",
          ),
        ).toBe(true),
      );
      const terminal = f.outputs.find(
        (output) => output.kind === "event" && output.event.type === "turn.completed",
      );
      expect(terminal).toMatchObject({ event: { outcome: { status: "succeeded" } } });
      if (name === "copy-request-id")
        expect(terminal).not.toMatchObject({ event: { nativeTurnRef: expect.anything() } });
      else
        expect(terminal).toMatchObject({
          event: { nativeTurnRef: { nativeTurnKey: "native-command-turn" } },
        });
      expect(prompt).toHaveBeenCalledWith(`/${name}`, expect.anything());
      expect(
        await f.session.commands.execute({ turnId, commandId: `cursor.${name}` }),
      ).toMatchObject({ error: { code: "invalidState" } });
    } finally {
      await f.session.close();
      await f.done;
    }
    expect(await f.session.commands.list()).toMatchObject({ error: { code: "invalidState" } });
  });
  it("keeps full-access delegation unsupported without native policy confirmation", async () => {
    const adapter = new CursorAdapter();
    const open = vi.spyOn(CursorTransport.prototype, "open");
    expect(
      await adapter.open({
        kind: "create",
        cwd: process.cwd(),
        executionPolicy: "unattended-full-access",
      }),
    ).toMatchObject({ error: { code: "unsupported" } });
    expect(open).not.toHaveBeenCalled();
    await adapter.close();
  });
});
