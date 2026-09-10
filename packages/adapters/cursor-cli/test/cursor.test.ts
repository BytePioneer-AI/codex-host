import { randomUUID } from "node:crypto";
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  hostTurnIdSchema,
  hostInteractionIdSchema,
  harnessPermissionModeIdSchema,
  harnessInspectionSchema,
} from "@codexhost/shared-contracts";
import type { HarnessOutput } from "@codexhost/harness-adapter";
import { CursorAdapter, CursorSession } from "../src/adapter.js";
import { CursorTransport, type CursorCallbacks } from "../src/transport.js";
import { cursorModelRef, cursorCatalog, cursorNativeModel } from "../src/models.js";
import { CursorInteractions } from "../src/interactions.js";
import { cursorSnapshot } from "../src/projection.js";

const native = vi.hoisted(() => ({ turns: [] as Array<{ id: string; text: string }> }));
vi.mock("../src/native-history.js", () => ({
  readCursorNativeTurns: () => structuredClone(native.turns),
}));
const info = {
  sessionId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  configOptions: [
    {
      id: "model",
      name: "Model",
      type: "select" as const,
      currentValue: "model[effort=high]",
      options: [{ value: "model[effort=high]", name: "Model" }],
    },
  ],
};
const turnId = hostTurnIdSchema.parse("turn-one");
const start = {
  type: "turn.start" as const,
  turnId,
  input: [{ type: "text" as const, text: "hello" }],
};

class FakeTransport extends CursorTransport {
  override sessionId = info.sessionId;
  action: (
    text: string,
    callbacks: CursorCallbacks,
  ) => Promise<{ stopReason: "end_turn" | "cancelled" }> = async (text, callbacks) => {
    callbacks.update({
      sessionId: this.sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } },
    });
    native.turns.push({ id: randomUUID(), text });
    return { stopReason: "end_turn" };
  };
  override async prompt(text: string, callbacks: CursorCallbacks) {
    return this.action(text, callbacks);
  }
  override async close() {}
  override async cancel() {}
  override async configure(configId: string, value: string) {
    return {
      configOptions: [
        {
          id: configId,
          name: configId,
          type: "select" as const,
          currentValue: value,
          options: [{ value, name: value }],
        },
      ],
    };
  }
}
function session() {
  const transport = new FakeTransport({ cwd: process.cwd(), environment: {} });
  const session = new CursorSession(transport, info, () => {});
  const output: HarnessOutput[] = [];
  const done = (async () => {
    for await (const item of session.outputs) output.push(item);
  })();
  return { transport, session, output, done };
}
afterEach(() => {
  vi.restoreAllMocks();
  native.turns = [];
});

describe("Cursor native configuration", () => {
  it("starts inspection cache expiry at completion, including slow native startup", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(0),
      gate = Promise.withResolvers<typeof info>();
    const open = vi.spyOn(CursorTransport.prototype, "open").mockImplementation(() => gate.promise);
    vi.spyOn(CursorTransport.prototype, "close").mockResolvedValue();
    const adapter = new CursorAdapter();
    try {
      const first = adapter.inspect();
      clock.mockReturnValue(400_000);
      gate.resolve(info);
      await first;
      await adapter.inspect();
      expect(open).toHaveBeenCalledTimes(1);
      clock.mockReturnValue(699_999);
      await adapter.inspect();
      expect(open).toHaveBeenCalledTimes(1);
      clock.mockReturnValue(700_001);
      await adapter.inspect();
      expect(open).toHaveBeenCalledTimes(2);
    } finally {
      await adapter.close();
    }
  });
  it.each([false, true])(
    "does not mutate a previously returned snapshot after mode changes (history=%s)",
    async (history) => {
      const f = session();
      vi.spyOn(CursorTransport.prototype, "open").mockImplementation(async function (
        this: CursorTransport,
      ) {
        this.replay = native.turns.map((turn) => ({
          sessionId: info.sessionId,
          update: {
            sessionUpdate: "user_message_chunk",
            content: { type: "text", text: turn.text },
          },
        }));
        return info;
      });
      try {
        if (history) {
          await f.session.execute(start);
          await vi.waitFor(() =>
            expect(
              f.output.some((x) => x.kind === "event" && x.event.type === "turn.completed"),
            ).toBe(true),
          );
        }
        const snapshot = await f.session.readSnapshot();
        if (!snapshot.ok) throw Error(snapshot.error.message);
        await f.session.execute({
          type: "permissionMode.select",
          permissionModeId: harnessPermissionModeIdSchema.parse("plan"),
        });
        expect(snapshot.value.state?.effectivePermissionModeId).toBe("agent");
      } finally {
        await f.session.close();
        await f.done;
      }
    },
  );
  it("preserves the complete parameterized native model behind an opaque Host ref", () => {
    const ref = cursorModelRef("model[effort=high]");
    expect(ref.id).toMatch(/^[A-Za-z0-9._~-]+$/u);
    expect(cursorNativeModel(info, ref.id)).toBe("model[effort=high]");
    expect(() => cursorNativeModel(info, "unknown")).toThrow();
    expect(cursorCatalog(info).thinkingOptions).toEqual([]);
  });
  it("caches failed inspection and retries only on explicit refresh or expiry", async () => {
    const open = vi
      .spyOn(CursorTransport.prototype, "open")
      .mockRejectedValue(new Error("not logged in"));
    vi.spyOn(CursorTransport.prototype, "close").mockResolvedValue();
    const adapter = new CursorAdapter();
    const first = await adapter.inspect();
    expect(harnessInspectionSchema.safeParse(first).success).toBe(true);
    expect(await adapter.inspect()).toEqual(first);
    expect(open).toHaveBeenCalledTimes(1);
    await adapter.inspect({ refresh: true });
    expect(open).toHaveBeenCalledTimes(2);
    await adapter.close();
  });
  it("does not claim unconfirmed mode selection", async () => {
    const f = session();
    vi.spyOn(f.transport, "configure").mockResolvedValue({ configOptions: [] });
    expect(
      (
        await f.session.execute({
          type: "permissionMode.select",
          permissionModeId: harnessPermissionModeIdSchema.parse("plan"),
        })
      ).ok,
    ).toBe(false);
    expect(f.session.initialState.effectivePermissionModeId).toBe("agent");
    await f.session.close();
    await f.done;
  });
});

describe("Cursor turn lifecycle", () => {
  it("faults and closes a dead ACP session instead of accepting further turns", async () => {
    const f = session();
    f.transport.action = async () => {
      throw new Error("Cursor ACP process exited (1)");
    };
    const close = vi.spyOn(f.transport, "close");
    await f.session.execute(start);
    await vi.waitFor(() =>
      expect(f.output.some((x) => x.kind === "event" && x.event.type === "turn.completed")).toBe(
        true,
      ),
    );
    expect(
      (await f.session.execute({ ...start, turnId: hostTurnIdSchema.parse("after-exit") })).ok,
    ).toBe(false);
    expect(f.output.some((x) => x.kind === "event" && x.event.type === "session.faulted")).toBe(
      true,
    );
    expect(close).toHaveBeenCalled();
    await f.session.close();
    await f.done;
  });
  it("emits a single terminal with durable native identity and refuses duplicate submission", async () => {
    const f = session();
    expect((await f.session.execute(start)).ok).toBe(true);
    await vi.waitFor(() =>
      expect(f.output.some((x) => x.kind === "event" && x.event.type === "turn.completed")).toBe(
        true,
      ),
    );
    expect((await f.session.execute(start)).ok).toBe(false);
    await f.session.close();
    await f.done;
    const terminal = f.output.filter(
      (x) => x.kind === "event" && x.event.type === "turn.completed",
    );
    expect(terminal).toHaveLength(1);
    expect(terminal[0]).toMatchObject({
      event: {
        outcome: { status: "succeeded" },
        nativeTurnRef: { nativeTurnKey: native.turns[0]?.id },
      },
    });
  });
  it.each([0, 2])("fails a nominal success when native history added %i turns", async (count) => {
    const f = session();
    f.transport.action = async (text) => {
      for (let index = 0; index < count; index++) native.turns.push({ id: randomUUID(), text });
      return { stopReason: "end_turn" };
    };
    await f.session.execute(start);
    await vi.waitFor(() =>
      expect(f.output.some((x) => x.kind === "event" && x.event.type === "turn.completed")).toBe(
        true,
      ),
    );
    await f.session.close();
    await f.done;
    expect(f.output).toContainEqual(
      expect.objectContaining({
        event: expect.objectContaining({
          type: "turn.completed",
          outcome: expect.objectContaining({ status: "failed" }),
        }),
      }),
    );
  });
  it("rejects a concurrent turn and closes pending approval on cancel", async () => {
    const f = session();
    f.transport.action = async (text, callbacks) => {
      const response = await callbacks.permission({
        sessionId: info.sessionId,
        toolCall: { toolCallId: "p", title: "shell" },
        options: [{ kind: "allow_once", optionId: "yes", name: "Allow" }],
      });
      expect(response).toEqual({ outcome: { outcome: "cancelled" } });
      native.turns.push({ id: randomUUID(), text });
      return { stopReason: "cancelled" };
    };
    await f.session.execute(start);
    expect((await f.session.execute({ ...start, turnId: hostTurnIdSchema.parse("two") })).ok).toBe(
      false,
    );
    expect((await f.session.execute({ type: "turn.cancel", turnId })).ok).toBe(true);
    await vi.waitFor(() =>
      expect(f.output.some((x) => x.kind === "event" && x.event.type === "turn.completed")).toBe(
        true,
      ),
    );
    await f.session.close();
    await f.done;
    expect(f.output).toContainEqual(
      expect.objectContaining({
        event: expect.objectContaining({ type: "interaction.closed", reason: "cancelled" }),
      }),
    );
    expect(
      f.output.filter((x) => x.kind === "event" && x.event.type === "turn.completed"),
    ).toHaveLength(1);
  });
  it("reports process failure without a guessed native turn ID", async () => {
    const f = session();
    f.transport.action = async () => {
      throw new Error("Cursor ACP process exited");
    };
    await f.session.execute(start);
    await vi.waitFor(() =>
      expect(f.output.some((x) => x.kind === "event" && x.event.type === "turn.completed")).toBe(
        true,
      ),
    );
    await f.session.close();
    await f.done;
    const terminal = f.output.find((x) => x.kind === "event" && x.event.type === "turn.completed");
    expect(terminal).toMatchObject({
      event: { outcome: { status: "failed", error: { code: "processExited" } } },
    });
    expect(terminal && "event" in terminal && "nativeTurnRef" in terminal.event).toBe(false);
  });
});

describe("Cursor interactions", () => {
  it("binds permissions to the exact interaction and rejects unknown or repeated decisions", async () => {
    const outputs: HarnessOutput[] = [];
    const interactions = new CursorInteractions((x) => outputs.push(x));
    const waiting = interactions.permission(turnId, {
      sessionId: info.sessionId,
      toolCall: { toolCallId: "p", title: "shell" },
      options: [{ kind: "reject_once", optionId: "reject-once", name: "Reject" }],
    });
    const first = outputs[0];
    if (first?.kind !== "interaction") throw new Error("missing interaction");
    expect(
      interactions.respond({
        type: "interaction.respond",
        interactionId: hostInteractionIdSchema.parse("wrong"),
        response: { type: "approval", actionId: "reject-once" },
      }).ok,
    ).toBe(false);
    const command = {
      type: "interaction.respond" as const,
      interactionId: first.interaction.interactionId,
      response: { type: "approval" as const, actionId: "reject-once" },
    };
    expect(interactions.respond(command).ok).toBe(true);
    expect(interactions.respond(command).ok).toBe(false);
    expect(await waiting).toEqual({ outcome: { outcome: "selected", optionId: "reject-once" } });
  });
  it("requires an explicit response for plans and questions, and cancels both on close", async () => {
    const outputs: HarnessOutput[] = [];
    const interactions = new CursorInteractions((x) => outputs.push(x));
    const plan = interactions.extension(turnId, "cursor/create_plan", { plan: "Do a thing" });
    const question = interactions.extension(turnId, "cursor/ask_question", {
      questions: [{ id: "q", prompt: "Which?", options: [{ id: "a", label: "A" }] }],
    });
    expect(outputs.filter((x) => x.kind === "interaction")).toHaveLength(2);
    interactions.cancel();
    expect(await plan).toEqual({ outcome: { outcome: "cancelled" } });
    expect(await question).toEqual({ outcome: { outcome: "cancelled" } });
  });
});

describe("Cursor replay identity", () => {
  const identity = { id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", text: "hello" };
  const replay = [
    {
      sessionId: info.sessionId,
      update: {
        sessionUpdate: "user_message_chunk" as const,
        content: { type: "text" as const, text: "hello" },
      },
    },
    {
      sessionId: info.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk" as const,
        content: { type: "text" as const, text: "ok" },
      },
    },
  ];
  it("uses native identity and preserves unknown historical outcome", () => {
    const snapshot = cursorSnapshot(info.sessionId, [identity], replay);
    expect(snapshot.turns[0]).toMatchObject({
      nativeTurnRef: { nativeTurnKey: identity.id },
      outcome: { status: "unknown" },
    });
  });
  it("fails closed on count, prompt and session mismatch", () => {
    expect(() => cursorSnapshot(info.sessionId, [], replay)).toThrow();
    expect(() =>
      cursorSnapshot(info.sessionId, [{ ...identity, text: "other" }], replay),
    ).toThrow();
    expect(() => cursorSnapshot("other", [identity], replay)).toThrow();
  });
});
