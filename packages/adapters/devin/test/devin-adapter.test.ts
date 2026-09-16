import { randomUUID } from "node:crypto";
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  hostTurnIdSchema,
  hostInteractionIdSchema,
  harnessPermissionModeIdSchema,
  harnessInspectionSchema,
} from "@codexhost/shared-contracts";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import type { HarnessOutput } from "@codexhost/harness-adapter";
import { DevinAdapter, DevinSession } from "../src/adapter.js";
import { DevinTransport, type DevinCallbacks } from "../src/transport.js";
import { devinModelRef, devinCatalog, devinModes, devinNativeModel } from "../src/models.js";
import { DevinInteractions } from "../src/interactions.js";
import { devinSnapshot } from "../src/projection.js";

const info = {
  sessionId: "fable-otter",
  modes: {
    currentModeId: "accept-edits",
    availableModes: [
      { id: "accept-edits", name: "Code" },
      { id: "plan", name: "Plan" },
      { id: "ask", name: "Ask" },
      { id: "bypass", name: "Bypass Permissions" },
    ],
  },
  configOptions: [
    {
      id: "model",
      name: "Model",
      type: "select" as const,
      currentValue: "swe-2-high",
      options: [
        { value: "swe-2-high", name: "SWE-2 High" },
        { value: "gpt-5-4-mini-low", name: "GPT-5.4 Mini Low" },
      ],
    },
    {
      id: "mode",
      name: "Session Mode",
      type: "select" as const,
      currentValue: "accept-edits",
      options: [
        { value: "accept-edits", name: "Code" },
        { value: "plan", name: "Plan" },
      ],
    },
  ],
};
const turnId = hostTurnIdSchema.parse("turn-one");
const start = {
  type: "turn.start" as const,
  turnId,
  input: [{ type: "text" as const, text: "hello" }],
};

/** Turns the fake server knows about; each entry is a replayed user message. */
const native = vi.hoisted(() => ({
  turns: [] as Array<{ id: string; text: string }>,
}));

class FakeTransport extends DevinTransport {
  override sessionId = info.sessionId;
  action: (
    text: string,
    callbacks: DevinCallbacks,
  ) => Promise<{ stopReason: "end_turn" | "cancelled"; _meta?: Record<string, unknown> }> = async (
    text,
    callbacks,
  ) => {
    callbacks.update({
      sessionId: this.sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } },
    });
    const id = randomUUID();
    native.turns.push({ id, text });
    return { stopReason: "end_turn", _meta: { "cognition.ai/userMessageId": id } };
  };
  override async open(sessionId?: string) {
    if (sessionId) {
      this.sessionId = sessionId;
      this.replay = this.#fakeReplay(sessionId);
    }
    return info;
  }
  #fakeReplay(sessionId: string): SessionNotification[] {
    return native.turns.flatMap((turn) => [
      {
        sessionId,
        update: {
          sessionUpdate: "user_message_chunk" as const,
          content: { type: "text" as const, text: turn.text },
          _meta: { "cognition.ai/clientMessageId": turn.id },
        },
      },
      {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk" as const,
          content: { type: "text" as const, text: "ok" },
        },
      },
    ]);
  }
  override async reload() {
    return this.#fakeReplay(this.sessionId);
  }
  override async prompt(text: string, callbacks: DevinCallbacks) {
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
function session(created = true) {
  const transport = new FakeTransport({ cwd: process.cwd(), environment: {} });
  const s = new DevinSession(transport, info, () => {}, created);
  const output: HarnessOutput[] = [];
  const done = (async () => {
    for await (const item of s.outputs) output.push(item);
  })();
  return { transport, session: s, output, done };
}
afterEach(() => {
  vi.restoreAllMocks();
  native.turns = [];
});

describe("Devin inspection and configuration", () => {
  it("reports ready with catalog, modes and capabilities from session info", async () => {
    const open = vi.spyOn(DevinTransport.prototype, "open").mockImplementation(async () => info);
    vi.spyOn(DevinTransport.prototype, "close").mockResolvedValue();
    const adapter = new DevinAdapter();
    try {
      const inspection = await adapter.inspect();
      expect(harnessInspectionSchema.safeParse(inspection).success).toBe(true);
      if (inspection.status !== "ready") throw new Error("not ready");
      expect(inspection.catalog.models.map((m) => m.label)).toContain("SWE-2 High");
      expect(inspection.permissionModes?.modes.map((m) => m.id)).toContain("bypass");
      expect(inspection.permissionModes?.modes.find((m) => m.id === "bypass")?.dangerous).toBe(
        true,
      );
      expect(inspection.permissionModes?.defaultModeId).toBe("accept-edits");
      await adapter.inspect();
      expect(open).toHaveBeenCalledTimes(1);
    } finally {
      await adapter.close();
    }
  });
  it("maps login failures to an unavailable inspection", async () => {
    vi.spyOn(DevinTransport.prototype, "open").mockRejectedValue(new Error("not logged in"));
    vi.spyOn(DevinTransport.prototype, "close").mockResolvedValue();
    const adapter = new DevinAdapter();
    const inspection = await adapter.inspect();
    expect(harnessInspectionSchema.safeParse(inspection).success).toBe(true);
    expect(inspection).toMatchObject({
      status: "unavailable",
      error: { code: "authenticationRequired" },
    });
    await adapter.close();
  });
  it("keeps the parameterized native model behind an opaque Host ref", () => {
    const ref = devinModelRef("gpt-5-4-mini-low");
    expect(ref.id).toMatch(/^[A-Za-z0-9._~-]+$/u);
    expect(devinNativeModel(info, ref.id)).toBe("gpt-5-4-mini-low");
    expect(() => devinNativeModel(info, "unknown")).toThrow();
    expect(devinCatalog(info).defaultModel?.id).toBe(devinModelRef("swe-2-high").id);
    expect(devinModes(info).defaultModeId).toBe("accept-edits");
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
    expect(f.session.initialState.effectivePermissionModeId).toBe("accept-edits");
    await f.session.close();
    await f.done;
  });
  it("rejects an unknown permission mode", async () => {
    const f = session();
    expect(
      (
        await f.session.execute({
          type: "permissionMode.select",
          permissionModeId: harnessPermissionModeIdSchema.parse("nope"),
        })
      ).ok,
    ).toBe(false);
    await f.session.close();
    await f.done;
  });
});

describe("Devin turn lifecycle", () => {
  it("emits one terminal with the native identity from the prompt response", async () => {
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
        nativeTurnRef: {
          harnessId: "devin",
          nativeSessionId: info.sessionId,
          nativeTurnKey: native.turns[0]?.id,
        },
      },
    });
  });
  it("refuses to report success when the terminal has no native identity", async () => {
    const f = session();
    f.transport.action = async () => ({ stopReason: "end_turn" });
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
          outcome: expect.objectContaining({
            status: "failed",
            error: expect.objectContaining({ code: "protocolError" }),
          }),
        }),
      }),
    );
  });
  it("rejects a concurrent turn and closes a pending approval on cancel", async () => {
    const f = session();
    f.transport.action = async (text, callbacks) => {
      const response = await callbacks.permission({
        sessionId: info.sessionId,
        toolCall: { toolCallId: "p", title: "shell" },
        options: [{ kind: "allow_once", optionId: "yes", name: "Allow" }],
      });
      expect(response).toEqual({ outcome: { outcome: "cancelled" } });
      const id = randomUUID();
      native.turns.push({ id, text });
      return { stopReason: "cancelled", _meta: { "cognition.ai/userMessageId": id } };
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
    expect(f.output).toContainEqual(
      expect.objectContaining({
        event: expect.objectContaining({
          type: "turn.completed",
          outcome: expect.objectContaining({ status: "cancelled" }),
        }),
      }),
    );
  });
  it("faults and closes a dead ACP session instead of accepting further turns", async () => {
    const f = session();
    f.transport.action = async () => {
      throw new Error("Devin ACP process exited (1)");
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
});

describe("Devin snapshot", () => {
  const replay: SessionNotification[] = [
    {
      sessionId: info.sessionId,
      update: {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "hel" },
        _meta: { "cognition.ai/clientMessageId": "k-1" },
      },
    },
    {
      sessionId: info.sessionId,
      update: {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "lo" },
        _meta: { "cognition.ai/clientMessageId": "k-1" },
      },
    },
    {
      sessionId: info.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "ok" },
      },
    },
    {
      sessionId: info.sessionId,
      update: {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "second" },
        _meta: { "cognition.ai/clientMessageId": "k-2" },
      },
    },
  ];
  it("groups multi-chunk user input by stable clientMessageId", () => {
    const snapshot = devinSnapshot(info.sessionId, replay);
    expect(snapshot.turns).toHaveLength(2);
    expect(snapshot.turns[0]).toMatchObject({
      nativeTurnRef: { nativeTurnKey: "k-1" },
      input: [{ type: "text", text: "hello" }],
      outcome: { status: "unknown" },
    });
    expect(snapshot.turns[1]?.nativeTurnRef.nativeTurnKey).toBe("k-2");
    expect(snapshot.turns[0]?.items[0]?.item).toMatchObject({
      type: "agentMessage",
      text: "ok",
    });
  });
  it("fails closed on missing identity, foreign session and non-text input", () => {
    const noKey: SessionNotification[] = [
      {
        sessionId: info.sessionId,
        update: {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: "hi" },
        },
      },
    ];
    expect(() => devinSnapshot(info.sessionId, noKey)).toThrow();
    expect(() => devinSnapshot("other", replay)).toThrow();
    const image: SessionNotification[] = [
      {
        sessionId: info.sessionId,
        update: {
          sessionUpdate: "user_message_chunk",
          content: { type: "image", data: "x", mimeType: "image/png" },
          _meta: { "cognition.ai/clientMessageId": "k" },
        },
      },
    ];
    expect(() => devinSnapshot(info.sessionId, image)).toThrow();
  });
  it("returns an empty snapshot for a fresh session without a replay spawn", async () => {
    const f = session();
    const reload = vi.spyOn(f.transport, "reload");
    const snapshot = await f.session.readSnapshot();
    expect(snapshot.ok && snapshot.value.turns.length === 0).toBe(true);
    expect(reload).not.toHaveBeenCalled();
    await f.session.close();
    await f.done;
  });
  it("reads the authoritative replay and matches live nativeTurnRef", async () => {
    const f = session();
    await f.session.execute(start);
    await vi.waitFor(() =>
      expect(f.output.some((x) => x.kind === "event" && x.event.type === "turn.completed")).toBe(
        true,
      ),
    );
    const snapshot = await f.session.readSnapshot();
    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) return;
    expect(snapshot.value.turns).toHaveLength(1);
    expect(snapshot.value.turns[0]?.nativeTurnRef.nativeTurnKey).toBe(native.turns[0]?.id);
    await f.session.close();
    await f.done;
  });
});

describe("Devin interactions", () => {
  it("binds permissions to the exact interaction and rejects repeats", async () => {
    const outputs: HarnessOutput[] = [];
    const interactions = new DevinInteractions((x) => outputs.push(x));
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
});
