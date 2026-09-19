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
import { fixture } from "./fixtures.js";

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
function setup(environment = {}) {
  const native = fixture();
  const adapter = new CodeBuddyAdapter({ ...native, environment });
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
