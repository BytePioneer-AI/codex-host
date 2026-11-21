import { afterEach, describe, expect, it, vi } from "vitest";
import type { HarnessOutput, HarnessSession } from "@codexhost/harness-adapter";
import {
  harnessIdSchema,
  harnessInspectionSchema,
  harnessPermissionModeIdSchema,
  harnessThinkingOptionIdSchema,
  hostTurnIdSchema,
  nativeCheckpointRefSchema,
} from "@codexhost/shared-contracts";
import * as derivation from "../src/derivation.js";
import { CodeBuddyAdapter } from "../src/codebuddy-adapter.js";
import { CodeBuddyError } from "../src/common.js";
import { modelRef } from "../src/configuration.js";
import { configOptions, fixture } from "./fixtures.js";

const adapters: CodeBuddyAdapter[] = [];
afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.close()));
});
const turn = (id: string, input = "hello") => ({
  type: "turn.start" as const,
  turnId: hostTurnIdSchema.parse(id),
  input: [{ type: "text" as const, text: input }],
});
const terminal = (output: HarnessOutput) =>
  output.kind === "event" && output.event.type === "turn.completed";
function collect(session: HarnessSession) {
  const outputs: HarnessOutput[] = [];
  const closed = (async () => {
    for await (const output of session.outputs) outputs.push(output);
  })();
  return {
    outputs,
    closed,
    completed: async (count = 1) => {
      await vi.waitFor(() => expect(outputs.filter(terminal)).toHaveLength(count));
      return outputs.filter(terminal);
    },
  };
}
function setup(
  environment = {},
  prepareClient?: (client: ReturnType<typeof fixture>["clients"][number], index: number) => void,
) {
  const native = fixture();
  const adapter = new CodeBuddyAdapter({
    ...native,
    environment,
    clientFactory: (options) => {
      const client = native.clientFactory(options);
      prepareClient?.(client, native.clients.length - 1);
      return client;
    },
  });
  adapters.push(adapter);
  return { native, adapter };
}
async function create(adapter: CodeBuddyAdapter, environment = {}) {
  const opened = await adapter.open({ kind: "create", cwd: process.cwd(), environment });
  if (!opened.ok) throw Error(opened.error.message);
  return opened.value;
}

describe("CodeBuddy native Adapter", () => {
  it.each(["fork", "rollbackLastTurn"] as const)(
    "does not begin %s after shutdown completes during a source snapshot",
    async (kind) => {
      const native = fixture();
      const entered = Promise.withResolvers<undefined>();
      const release = Promise.withResolvers<undefined>();
      const adapter = new CodeBuddyAdapter({
        ...native,
        readHistory: async () => {
          entered.resolve(undefined);
          await release.promise;
          return native.readHistory();
        },
      });
      adapters.push(adapter);
      native.history.push({ id: "user-1", type: "message", role: "user", content: "hello" });
      const source = await create(adapter);
      const sourceRef = source.initialState.nativeRef;
      if (!sourceRef) throw Error("No native identity");
      const derive = vi.spyOn(derivation, "deriveCodeBuddySession");
      try {
        const input = { cwd: process.cwd(), sourceRef };
        const opening = adapter.open(
          kind === "fork"
            ? {
                ...input,
                kind,
                checkpoint: nativeCheckpointRefSchema.parse({
                  harnessId: "codebuddy",
                  nativeSessionId: sourceRef.nativeSessionId,
                  checkpointId: "user-1",
                  formatVersion: 1,
                }),
              }
            : { ...input, kind },
        );
        await entered.promise;
        await adapter.close();
        expect(native.clients[0]?.closed).toBe(true);
        release.resolve(undefined);
        expect(await opening).toMatchObject({ error: { code: "invalidState" } });
        expect(derive).not.toHaveBeenCalled();
        expect(native.clients).toHaveLength(1);
      } finally {
        release.resolve(undefined);
        derive.mockRestore();
      }
    },
  );

  it("keeps the CodeBuddy native commands distinct from the WorkBuddy catalog", async () => {
    const { adapter } = setup();
    const session = await create(adapter);
    expect(adapter.commandCatalog?.commands.map((command) => command.invocation)).toEqual([
      "/compact",
      "/cost",
    ]);
    const available = await session.commands?.list();
    if (!available?.ok) throw Error("CodeBuddy command catalog is unavailable");
    const invocations = available.value.commands.map((command) => command.invocation);
    expect(invocations).toEqual(expect.arrayContaining(["/compact", "/cost", "/review"]));
    expect(invocations).not.toContain("/init");
  });

  it("completes PARTIAL_SUCCESS while retaining a recovered diagnostic Tool failure", async () => {
    const { adapter, native } = setup();
    const session = await create(adapter),
      events = collect(session);
    const client = native.clients[0];
    if (!client) throw Error("No native fixture");
    client.nativeOutcome = "PARTIAL_SUCCESS";
    client.recoverableToolFailure = true;
    await session.execute(turn("diagnostic", "List diagnostic state"));
    const completed = await events.completed();
    expect(completed).toMatchObject([
      { event: { outcome: { status: "succeeded" }, nativeTurnRef: { nativeTurnKey: "user-1" } } },
    ]);
    expect(
      events.outputs.filter(
        (output) => output.kind === "event" && output.event.type === "item.completed",
      ),
    ).toMatchObject([
      {
        event: { snapshot: { item: { type: "commandExecution" }, outcome: { status: "failed" } } },
      },
      {
        event: {
          snapshot: {
            item: { type: "agentMessage", text: "Result List diagnostic state" },
            outcome: { status: "succeeded" },
          },
        },
      },
    ]);
    expect(await session.readSnapshot()).toMatchObject({
      value: {
        turns: [
          {
            outcome: { status: "succeeded" },
            items: [{ outcome: { status: "failed" } }, { outcome: { status: "succeeded" } }],
          },
        ],
      },
    });
    client.nativeOutcome = "SUCCESS";
    client.recoverableToolFailure = false;
    await session.execute(turn("followup"));
    await events.completed(2);
    expect(
      events.outputs.some(
        (output) => output.kind === "event" && output.event.type === "session.faulted",
      ),
    ).toBe(false);
  });

  it.each([
    ["FAILED_MODEL_REQUEST", "end_turn", "failed"],
    ["FAILED_TOOL_EXECUTION", "end_turn", "failed"],
    ["FAILED_AGENT_LOOP", "end_turn", "failed"],
    ["REFUSED_OR_BLOCKED", "end_turn", "failed"],
    ["PERMISSION_DENIED", "end_turn", "failed"],
    ["FUTURE_UNKNOWN_OUTCOME", "end_turn", "failed"],
    ["PARTIAL_SUCCESS", "max_tokens", "failed"],
    ["CANCELLED", "end_turn", "cancelled"],
  ])("preserves native %s / %s as %s", async (outcome, stopReason, expected) => {
    const { adapter, native } = setup();
    const session = await create(adapter),
      events = collect(session);
    const client = native.clients[0];
    if (!client) throw Error("No native fixture");
    client.nativeOutcome = outcome;
    client.nativeStopReason = stopReason;
    await session.execute(turn("terminal"));
    expect(await events.completed()).toMatchObject([{ event: { outcome: { status: expected } } }]);
  });

  it("inspects ephemeral protocol sessions, caches per cwd, and refreshes without a prompt", async () => {
    const { adapter, native } = setup();
    const first = await adapter.inspect();
    expect(harnessInspectionSchema.parse(first).status).toBe("ready");
    await adapter.inspect();
    expect(native.clients).toHaveLength(1);
    await adapter.inspect({ refresh: true });
    expect(native.clients).toHaveLength(2);
    expect(native.clients.every((client) => client.closed && client.context.ephemeral)).toBe(true);
    expect(native.history).toEqual([]);
  });

  it("reports missing CLI and caches failure until explicit refresh", async () => {
    const factory = vi.fn(() => {
      throw new CodeBuddyError("notInstalled", "CLI missing");
    });
    const adapter = new CodeBuddyAdapter({ clientFactory: factory });
    adapters.push(adapter);
    expect(await adapter.inspect()).toMatchObject({ status: "notInstalled" });
    await adapter.inspect();
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("preserves native Turn identity, text deltas, and per-Thread environment through new Adapter resume", async () => {
    const { adapter, native } = setup({ PRIVATE: "base", KEEP: "present" });
    const session = await create(adapter, { PRIVATE: "thread", NEW: "new" });
    const events = collect(session);
    expect(native.clients[0]?.context.environment).toEqual({
      PRIVATE: "thread",
      KEEP: "present",
      NEW: "new",
    });
    expect(await session.execute(turn("host-1"))).toMatchObject({ ok: true });
    const [completed] = await events.completed();
    const snapshot = await session.readSnapshot();
    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok || completed?.kind !== "event" || completed.event.type !== "turn.completed")
      throw Error("Missing evidence");
    expect(snapshot.value.turns[0]?.nativeTurnRef).toEqual(completed.event.nativeTurnRef);
    const started = events.outputs.find(
      (output) => output.kind === "event" && output.event.type === "item.started",
    );
    expect(started).toMatchObject({ event: { item: { text: "" } } });
    const ref = session.initialState.nativeRef;
    if (!ref) throw Error("No native identity");
    await adapter.close();
    await events.closed;
    const resumedAdapter = new CodeBuddyAdapter({ ...native });
    adapters.push(resumedAdapter);
    const resumed = await resumedAdapter.open({
      kind: "resume",
      nativeRef: ref,
      cwd: process.cwd(),
      environment: { RESUMED: "yes" },
    });
    if (!resumed.ok) throw Error(resumed.error.message);
    expect(await resumed.value.readSnapshot()).toMatchObject({
      value: { turns: [{ nativeTurnRef: completed.event.nativeTurnRef }] },
    });
    const resumedEvents = collect(resumed.value);
    await resumed.value.execute(turn("host-2"));
    await resumedEvents.completed();
    expect(await resumed.value.readSnapshot()).toMatchObject({
      value: { turns: [{ input: [{ text: "hello" }] }, { input: [{ text: "hello" }] }] },
    });
  });

  it("allows active Model/Thinking selection but rejects busy starts/snapshots and cancels only the matching Turn", async () => {
    const { adapter } = setup();
    const session = await create(adapter);
    const events = collect(session);
    await session.execute(turn("hold", "hold"));
    expect(await session.execute(turn("duplicate"))).toMatchObject({
      error: { code: "sessionBusy" },
    });
    expect(await session.execute({ type: "model.select", model: modelRef("other") })).toMatchObject(
      { ok: true },
    );
    expect(
      await session.execute({
        type: "thinking.select",
        thinkingOptionId: harnessThinkingOptionIdSchema.parse("high"),
      }),
    ).toMatchObject({ ok: true });
    expect(await session.readSnapshot()).toMatchObject({ error: { code: "sessionBusy" } });
    expect(
      await session.execute({ type: "turn.cancel", turnId: hostTurnIdSchema.parse("wrong") }),
    ).toMatchObject({ error: { code: "invalidRequest" } });
    await session.execute({ type: "turn.cancel", turnId: hostTurnIdSchema.parse("hold") });
    expect(await events.completed()).toMatchObject([
      { event: { outcome: { status: "cancelled" } } },
    ]);
    await session.execute(turn("followup"));
    await events.completed(2);
    expect(await session.readSnapshot()).toMatchObject({
      value: { turns: [{ outcome: { status: "unknown" } }, { outcome: { status: "succeeded" } }] },
    });
  });

  it("settles cancellation after retiring the old process without opening its replacement", async () => {
    const { adapter, native } = setup();
    const session = await create(adapter);
    const events = collect(session);
    const old = native.clients[0];
    if (!old) throw Error("No native client");
    const closeEntered = Promise.withResolvers<undefined>();
    const releaseClose = Promise.withResolvers<undefined>();
    const close = old.close.bind(old);
    vi.spyOn(old, "close").mockImplementation(async () => {
      closeEntered.resolve(undefined);
      await releaseClose.promise;
      await close();
    });
    const cancel = vi.spyOn(old, "cancel");
    const start = turn("stopped", "hold");
    await session.execute(start);
    try {
      expect(await session.execute({ type: "turn.cancel", turnId: start.turnId })).toMatchObject({
        ok: true,
      });
      await closeEntered.promise;
      expect(await session.execute({ type: "turn.cancel", turnId: start.turnId })).toMatchObject({
        ok: true,
      });
      expect(cancel).toHaveBeenCalledOnce();
      expect(events.outputs.filter(terminal)).toHaveLength(0);
      expect(await session.execute(turn("too-early"))).toMatchObject({
        error: { code: "sessionBusy" },
      });
    } finally {
      releaseClose.resolve(undefined);
    }
    expect(await events.completed()).toMatchObject([
      {
        event: {
          outcome: { status: "cancelled", checkpoint: { checkpointId: "user-1" } },
          nativeTurnRef: { nativeTurnKey: "user-1" },
        },
      },
    ]);
    expect(old.closed).toBe(true);
    expect(await session.readSnapshot()).toMatchObject({ ok: true });
    expect(native.clients).toHaveLength(1);
    expect(await session.execute(turn("next"))).toMatchObject({ ok: true });
    expect((await events.completed(2))[1]).toMatchObject({
      event: { outcome: { status: "succeeded" } },
    });
  });

  it("settles a first prompt cancelled before native history is written", async () => {
    const { adapter, native } = setup({}, (client, index) => {
      if (index !== 0) return;
      client.prompt = async () => ({ stopReason: "cancelled" });
    });
    const session = await create(adapter);
    const events = collect(session);
    await session.execute(turn("stopped"));
    const [completed] = await events.completed();
    expect(completed).toMatchObject({ event: { outcome: { status: "cancelled" } } });
    expect(completed).not.toHaveProperty("event.nativeTurnRef");
    expect(native.clients).toHaveLength(1);
    expect(await session.execute(turn("next"))).toMatchObject({ ok: true });
    expect((await events.completed(2))[1]).toMatchObject({
      event: { outcome: { status: "succeeded" } },
    });
  });

  it.each(["missing", "unreadable", "stalled"] as const)(
    "preserves confirmed cancellation with a userMessageId and %s history",
    async (historyState) => {
      const native = fixture();
      const readEntered = Promise.withResolvers<undefined>();
      const releaseRead = Promise.withResolvers<string>();
      const adapter = new CodeBuddyAdapter({
        ...native,
        readHistory: async () => {
          if (native.clients.length === 1 && native.clients[0]?.closed) {
            readEntered.resolve(undefined);
            if (historyState === "unreadable") throw Error("History read failed");
            if (historyState === "stalled") return releaseRead.promise;
          }
          return native.readHistory();
        },
      });
      adapters.push(adapter);
      const session = await create(adapter);
      const events = collect(session);
      const old = native.clients[0];
      if (!old) throw Error("No native client");
      old.missingHistory = historyState === "missing";
      const start = turn("stopped", "hold");
      expect(await session.execute(start)).toMatchObject({ ok: true });
      expect(old.pending?.id).toBe("user-1");
      if (historyState === "stalled") vi.useFakeTimers();
      try {
        await session.execute({ type: "turn.cancel", turnId: start.turnId });
        await readEntered.promise;
        if (historyState === "stalled") {
          await vi.advanceTimersByTimeAsync(1_000);
          expect(events.outputs.filter(terminal)).toHaveLength(1);
        }
        expect(await events.completed()).toEqual([
          {
            kind: "event",
            event: {
              type: "turn.completed",
              turnId: start.turnId,
              outcome: { status: "cancelled" },
            },
          },
        ]);
      } finally {
        if (historyState === "stalled") vi.useRealTimers();
        releaseRead.resolve("");
      }
      expect(native.clients).toHaveLength(1);
      expect(await session.execute(turn("next"))).toMatchObject({ ok: true });
      expect((await events.completed(2))[1]).toMatchObject({
        event: { outcome: { status: "succeeded" } },
      });
    },
  );

  it("fails the old Turn and never opens a replacement if shutdown cannot be confirmed", async () => {
    const { adapter, native } = setup();
    const session = await create(adapter);
    const events = collect(session);
    const old = native.clients[0];
    if (!old) throw Error("No native client");
    vi.spyOn(old, "close").mockRejectedValueOnce(
      new CodeBuddyError("unavailable", "shutdown timed out"),
    );
    const start = turn("stopped", "hold");
    await session.execute(start);
    await session.execute({ type: "turn.cancel", turnId: start.turnId });
    expect(await events.completed()).toMatchObject([
      {
        event: {
          outcome: { status: "failed", error: { message: "CodeBuddy: shutdown timed out" } },
        },
      },
    ]);
    await events.closed;
    expect(await session.execute(turn("next"))).toMatchObject({ error: { code: "invalidState" } });
    expect(native.clients).toHaveLength(1);
  });

  it("ignores retired process replies and callbacks after cancellation", async () => {
    const { adapter, native } = setup();
    const session = await create(adapter);
    const events = collect(session);
    const old = native.clients[0];
    if (!old) throw Error("No native client");
    const lateConfig = Promise.withResolvers<{ configOptions: ReturnType<typeof configOptions> }>();
    vi.spyOn(old, "configure").mockReturnValueOnce(lateConfig.promise);
    const first = turn("first", "hold");
    await session.execute(first);
    const selection = session.execute({ type: "model.select", model: modelRef("other") });
    await session.execute({ type: "turn.cancel", turnId: first.turnId });
    await events.completed();
    lateConfig.resolve({ configOptions: configOptions("other") });
    expect(await selection).toMatchObject({ error: { code: "invalidState" } });
    expect(await session.readSnapshot()).toMatchObject({
      value: { state: { effectiveModel: modelRef("native/model") } },
    });

    // A configuration choice is also a native operation and can trigger lazy recovery.
    expect(
      await session.execute({
        type: "thinking.select",
        thinkingOptionId: harnessThinkingOptionIdSchema.parse("high"),
      }),
    ).toMatchObject({ ok: true });
    const next = turn("next", "hold");
    const offset = events.outputs.length;
    expect(await session.execute(next)).toMatchObject({ ok: true });
    old.update({ sessionUpdate: "config_option_update", configOptions: configOptions("other") });
    old.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "stale" } });
    old.context.handlers.fault(Error("retired client fault"));
    await expect(old.context.handlers.question({ sessionId: "native-session" })).resolves.toEqual({
      outcome: "cancelled",
    });
    await expect(
      old.context.handlers.permission({
        sessionId: "native-session",
        toolCall: { toolCallId: "stale" },
        options: [],
      }),
    ).resolves.toEqual({ outcome: { outcome: "cancelled" } });
    expect(await session.execute({ type: "turn.cancel", turnId: first.turnId })).toMatchObject({
      error: { code: "invalidRequest" },
    });
    await session.execute({ type: "turn.cancel", turnId: next.turnId });
    expect(await events.completed(2)).toMatchObject([
      { event: { outcome: { status: "cancelled" } } },
      { event: { outcome: { status: "cancelled" } } },
    ]);
    expect(
      events.outputs.slice(offset).map((output) => output.kind === "event" && output.event.type),
    ).toEqual(["turn.started", "turn.completed"]);
    expect(await session.readSnapshot()).toMatchObject({
      value: {
        state: { effectiveModel: modelRef("native/model"), effectiveThinkingOptionId: "high" },
      },
    });
  });

  it.each(["open timeout", "configuration timeout", "configuration refusal"] as const)(
    "reports a recovery %s only on the next operation and preserves the confirmed settings",
    async (failure) => {
      const code = failure === "configuration refusal" ? "nativeFailure" : "unavailable";
      const error = new CodeBuddyError(code, failure);
      const entered = Promise.withResolvers<undefined>();
      const release = Promise.withResolvers<undefined>();
      const { adapter, native } = setup({}, (client, index) => {
        if (index !== 1) return;
        const fail = async () => {
          entered.resolve(undefined);
          await release.promise;
          if (code === "unavailable") client.context.handlers.fault(error);
          throw error;
        };
        if (failure === "open timeout") client.open = fail;
        else client.configure = fail;
      });
      const opened = await adapter.open({
        kind: "create",
        cwd: process.cwd(),
        model: modelRef("other"),
        thinkingOptionId: harnessThinkingOptionIdSchema.parse("high"),
        permissionModeId: harnessPermissionModeIdSchema.parse("fullAccess"),
      });
      if (!opened.ok) throw Error(opened.error.message);
      const session = opened.value;
      const events = collect(session);
      const start = turn("stopped", "hold");
      const confirmed = {
        effectiveModel: modelRef("other"),
        effectiveThinkingOptionId: "high",
        effectivePermissionModeId: "fullAccess",
      };
      await session.execute(start);
      try {
        await session.execute({ type: "turn.cancel", turnId: start.turnId });
        expect(await events.completed()).toMatchObject([
          { event: { outcome: { status: "cancelled" } } },
        ]);
        expect(native.clients).toHaveLength(1);
        const offset = events.outputs.length;
        const next = session.execute(turn("blocked"));
        await entered.promise;
        expect(events.outputs.slice(offset)).not.toContainEqual(
          expect.objectContaining({
            event: expect.objectContaining({ type: "session.state.changed" }),
          }),
        );
        release.resolve(undefined);
        expect(await next).toMatchObject({ error: { code, message: `CodeBuddy: ${failure}` } });
        expect(native.clients[1]?.closed).toBe(true);
        expect(await session.readSnapshot()).toMatchObject({ value: { state: confirmed } });
        expect(
          events.outputs.slice(offset).filter(({ kind }) => kind === "event"),
        ).not.toContainEqual(
          expect.objectContaining({
            event: expect.objectContaining({
              type: expect.stringMatching(
                /^(turn\.started|turn\.completed|session\.faulted|session\.state\.changed)$/u,
              ),
            }),
          }),
        );
        expect(await session.execute(turn("retry"))).toMatchObject({ ok: true });
        expect((await events.completed(2))[1]).toMatchObject({
          event: { outcome: { status: "succeeded" } },
        });
        expect(await session.readSnapshot()).toMatchObject({
          value: {
            turns: [{ input: [{ text: "hold" }] }, { input: [{ text: "hello" }] }],
            state: confirmed,
          },
        });
      } finally {
        release.resolve(undefined);
      }
    },
  );

  it.each([false, true])(
    "restores only changed configuration and rejects a reset of a skipped value (%s)",
    async (resetModel) => {
      const requests: [string, string][] = [];
      const { adapter, native } = setup({}, (client, index) => {
        if (index !== 1) return;
        const configure = client.configure.bind(client);
        client.configure = async (sessionId, id, value) => {
          requests.push([id, value]);
          if (resetModel && id === "thought_level") client.options = configOptions("other");
          return configure(sessionId, id, value);
        };
      });
      const session = await create(adapter);
      const events = collect(session);
      expect(
        await session.execute({
          type: "thinking.select",
          thinkingOptionId: harnessThinkingOptionIdSchema.parse("high"),
        }),
      ).toMatchObject({ ok: true });
      const start = turn("stopped", "hold");
      await session.execute(start);
      await session.execute({ type: "turn.cancel", turnId: start.turnId });
      await events.completed();
      const next = await session.execute(turn("next"));
      expect(requests).toEqual([["thought_level", "high"]]);
      if (resetModel) {
        expect(next).toMatchObject({
          error: {
            code: "protocolError",
            message: expect.stringContaining("did not restore model"),
          },
        });
        expect(native.clients[1]?.closed).toBe(true);
      } else {
        expect(next).toMatchObject({ ok: true });
        expect((await events.completed(2))[1]).toMatchObject({
          event: { outcome: { status: "succeeded" } },
        });
      }
      expect(await session.readSnapshot()).toMatchObject({
        value: {
          state: {
            effectiveModel: modelRef("native/model"),
            effectiveThinkingOptionId: "high",
            effectivePermissionModeId: "default",
          },
        },
      });
    },
  );

  it("keeps unlisted Model selection disabled for the ordinary CodeBuddy profile", async () => {
    const { adapter } = setup();
    const session = await create(adapter);

    expect(
      await session.execute({ type: "model.select", model: modelRef("not-in-native-options") }),
    ).toMatchObject({
      error: { code: "invalidRequest", message: expect.stringContaining("Unavailable CodeBuddy") },
    });
  });

  it("confirms native configuration and rejects an unacknowledged selection", async () => {
    const { adapter, native } = setup();
    const session = await create(adapter);
    const events = collect(session);
    expect(await session.execute({ type: "model.select", model: modelRef("other") })).toMatchObject(
      { ok: true },
    );
    const client = native.clients[0];
    if (!client) throw Error("No client");
    client.failedConfig = true;
    expect(
      await session.execute({
        type: "permissionMode.select",
        permissionModeId: harnessPermissionModeIdSchema.parse("plan"),
      }),
    ).toMatchObject({ error: { code: "protocolError" } });
    expect(
      events.outputs.some(
        (output) =>
          output.kind === "event" &&
          output.event.type === "session.state.changed" &&
          output.event.state.effectivePermissionModeId === "plan",
      ),
    ).toBe(false);
  });

  it("uses the native fullAccess mode for unattended execution and refuses invalid refs before opening", async () => {
    const { adapter, native } = setup();
    const opened = await adapter.open({
      kind: "create",
      cwd: process.cwd(),
      executionPolicy: "unattended-full-access",
    });
    expect(opened).toMatchObject({
      value: { initialState: { effectivePermissionModeId: "fullAccess" } },
    });
    const count = native.clients.length;
    expect(
      await adapter.open({
        kind: "resume",
        cwd: process.cwd(),
        nativeRef: {
          harnessId: harnessIdSchema.parse("claude-code"),
          nativeSessionId: "../escape",
          formatVersion: 1,
        },
      }),
    ).toMatchObject({ error: { code: "invalidRequest" } });
    expect(native.clients).toHaveLength(count);
  });

  it.each(["approval", "question"])(
    "validates and settles a correlated %s without fabricating answers",
    async (input) => {
      const { adapter, native } = setup();
      const session = await create(adapter);
      const events = collect(session);
      await session.execute(turn("interactive", input));
      await vi.waitFor(() =>
        expect(events.outputs.some((output) => output.kind === "interaction")).toBe(true),
      );
      const output = events.outputs.find((output) => output.kind === "interaction");
      if (output?.kind !== "interaction") throw Error("No interaction");
      const interaction = output.interaction;
      const bad = await session.execute({
        type: "interaction.respond",
        interactionId: interaction.interactionId,
        response: { type: "approval", actionId: "allow-everything" },
      });
      expect(bad.ok).toBe(false);
      const response =
        interaction.type === "approval"
          ? { type: "approval" as const, actionId: "allow" }
          : { type: "question" as const, answers: { q_0: ["Alpha"] } };
      const command = {
        type: "interaction.respond" as const,
        interactionId: interaction.interactionId,
        response,
      };
      expect(await session.execute(command)).toMatchObject({ ok: true });
      await events.completed();
      expect(await session.execute(command)).toMatchObject({ error: { code: "invalidRequest" } });
      expect(
        events.outputs.filter(
          (output) => output.kind === "event" && output.event.type === "interaction.closed",
        ),
      ).toHaveLength(1);
      if (input === "question")
        expect(native.clients[0]?.lastQuestion).toEqual({
          sessionId: "native-session",
          toolCallId: "call-1",
          answers: { q_0: ["Alpha"] },
        });
    },
  );

  it("terminates accepted Turns exactly once on process death and releases outputs", async () => {
    const { adapter, native } = setup();
    const session = await create(adapter);
    const events = collect(session);
    await session.execute(turn("running", "hold"));
    native.clients[0]?.context.handlers.fault(new CodeBuddyError("processExited", "Child exited"));
    await events.closed;
    expect(events.outputs.filter(terminal)).toHaveLength(1);
    expect(await session.execute(turn("late"))).toMatchObject({ error: { code: "invalidState" } });
  });

  it("completes consecutive Turns with native context injections and same-turn user input", async () => {
    const { adapter, native } = setup();
    const session = await create(adapter);
    const events = collect(session);
    const client = native.clients[0];
    if (!client) throw Error("No client");
    const complete = client.complete.bind(client);
    vi.spyOn(client, "complete").mockImplementation((id, input) => {
      native.history.push(
        {
          type: "message",
          role: "user",
          id: `context-${id}`,
          parentId: id,
          providerData: { startsNewUserRequest: false, conversationRequestId: id },
          content:
            '<system-reminder data-role="user-context">quoted <user_query></system-reminder>',
        },
        {
          type: "message",
          role: "user",
          id: `steer-${id}`,
          parentId: `context-${id}`,
          providerData: { startsNewUserRequest: false, conversationRequestId: id },
          content: "Only review; do not edit.",
        },
      );
      return complete(id, input);
    });

    for (const [index, prompt] of ["first", "second"].entries()) {
      expect(await session.execute(turn(prompt, prompt))).toMatchObject({ ok: true });
      expect((await events.completed(index + 1)).at(-1)).toMatchObject({
        event: {
          outcome: { status: "succeeded", checkpoint: { checkpointId: `user-${index + 1}` } },
          nativeTurnRef: { nativeTurnKey: `user-${index + 1}` },
        },
      });
    }
    const snapshot = await session.readSnapshot();
    if (!snapshot.ok) throw Error(snapshot.error.message);
    expect(snapshot.value.turns).toHaveLength(2);
    expect(snapshot.value.turns.map((turn) => turn.input)).toEqual(
      ["first", "second"].map((text) => [
        { type: "text", text },
        { type: "text", text: "Only review; do not edit." },
      ]),
    );
    expect(snapshot.value.turns.map((turn) => turn.items)).toMatchObject([
      [{ item: { type: "agentMessage", text: "Result first" } }],
      [{ item: { type: "agentMessage", text: "Result second" } }],
    ]);
  });

  it("fails a successful native response that lacks persisted identity", async () => {
    const { adapter, native } = setup();
    const session = await create(adapter);
    const events = collect(session);
    const client = native.clients[0];
    if (!client) throw Error("No client");
    client.missingHistory = true;
    await session.execute(turn("missing"));
    expect(await events.completed()).toMatchObject([{ event: { outcome: { status: "failed" } } }]);
  });
});
