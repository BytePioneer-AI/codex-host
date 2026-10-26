import { afterEach, describe, expect, it, vi } from "vitest";
import type { HarnessOutput } from "@codexhost/harness-adapter";
import {
  harnessPermissionModeIdSchema,
  harnessThinkingOptionIdSchema,
  hostTurnIdSchema,
  nativeSessionRefSchema,
} from "@codexhost/shared-contracts";
import { DevinAdapter, DevinSession } from "../src/adapter.js";
import { devinModelRef } from "../src/models.js";
import { DevinTransport, type DevinSessionInfo } from "../src/transport.js";

const info = {
  sessionId: "configuration-session",
  modes: {
    currentModeId: "accept-edits",
    availableModes: ["accept-edits", "ask", "smart", "plan", "bypass"].map((id) => ({
      id,
      name: id,
    })),
  },
  configOptions: [
    {
      id: "model",
      name: "Model",
      type: "select",
      currentValue: "swe-2-high",
      options: ["swe-2-high", "gpt-5-4-mini-low"].map((value) => ({ value, name: value })),
    },
  ],
} satisfies DevinSessionInfo;
const model = devinModelRef("gpt-5-4-mini-low");
const turnId = hostTurnIdSchema.parse("configuration-turn");
const start = {
  type: "turn.start" as const,
  turnId,
  input: [{ type: "text" as const, text: "hello" }],
};
function confirmed(configId: string, value: string) {
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
function stubOpen() {
  const open = vi.spyOn(DevinTransport.prototype, "open").mockImplementation(async function (
    this: DevinTransport,
  ) {
    this.sessionId = info.sessionId;
    return structuredClone(info);
  });
  const close = vi.spyOn(DevinTransport.prototype, "close").mockResolvedValue();
  const configure = vi
    .spyOn(DevinTransport.prototype, "configure")
    .mockImplementation(async (id, value) => confirmed(id, value));
  return { adapter: new DevinAdapter(), open, close, configure };
}
function activeSession() {
  const transport = new DevinTransport({ cwd: process.cwd(), environment: {} });
  transport.sessionId = info.sessionId;
  const turn = Promise.withResolvers<Awaited<ReturnType<DevinTransport["prompt"]>>>();
  vi.spyOn(transport, "prompt").mockReturnValue(turn.promise);
  vi.spyOn(transport, "close").mockResolvedValue();
  const cancel = vi.spyOn(transport, "cancel").mockImplementation(async () => {
    turn.resolve({ stopReason: "cancelled" });
  });
  const configure = vi
    .spyOn(transport, "configure")
    .mockImplementation(async (id, value) => confirmed(id, value));
  const session = new DevinSession(transport, structuredClone(info), () => {});
  const outputs: HarnessOutput[] = [];
  const done = (async () => {
    for await (const output of session.outputs) outputs.push(output);
  })();
  return {
    session,
    transport,
    configure,
    cancel,
    outputs,
    turn,
    async close() {
      turn.resolve({ stopReason: "cancelled" });
      await session.close();
      await done;
    },
  };
}
afterEach(() => vi.restoreAllMocks());

describe("Devin unattended execution policy", () => {
  it.each(["accept-edits", "ask", "smart", "plan"])(
    "rejects conflicting %s before opening native resources",
    async (mode) => {
      const f = stubOpen();
      try {
        expect(
          await f.adapter.open({
            kind: "create",
            cwd: process.cwd(),
            executionPolicy: "unattended-full-access",
            permissionModeId: harnessPermissionModeIdSchema.parse(mode),
          }),
        ).toMatchObject({ ok: false, error: { code: "invalidRequest" } });
        expect(f.open).not.toHaveBeenCalled();
        expect(f.configure).not.toHaveBeenCalled();
      } finally {
        await f.adapter.close();
      }
    },
  );
  it.each([undefined, "bypass"])("confirms bypass when the explicit mode is %s", async (mode) => {
    const f = stubOpen();
    try {
      const result = await f.adapter.open({
        kind: "create",
        cwd: process.cwd(),
        executionPolicy: "unattended-full-access",
        ...(mode ? { permissionModeId: harnessPermissionModeIdSchema.parse(mode) } : {}),
      });
      expect(f.configure).toHaveBeenCalledWith("mode", "bypass");
      expect(result.ok && result.value.initialState.effectivePermissionModeId).toBe("bypass");
    } finally {
      await f.adapter.close();
    }
  });
  it("rejects an unconfirmed bypass and closes the native transport", async () => {
    const f = stubOpen();
    f.configure.mockResolvedValue(confirmed("mode", "accept-edits"));
    try {
      expect(
        await f.adapter.open({
          kind: "create",
          cwd: process.cwd(),
          executionPolicy: "unattended-full-access",
        }),
      ).toMatchObject({ ok: false });
      expect(f.close).toHaveBeenCalledTimes(1);
    } finally {
      await f.adapter.close();
    }
  });
  it.each(["create", "resume"] as const)(
    "preserves explicit plan for ordinary %s",
    async (kind) => {
      const f = stubOpen();
      try {
        const selection = {
          cwd: process.cwd(),
          permissionModeId: harnessPermissionModeIdSchema.parse("plan"),
        };
        const result = await f.adapter.open(
          kind === "create"
            ? { ...selection, kind }
            : {
                ...selection,
                kind,
                nativeRef: nativeSessionRefSchema.parse({
                  harnessId: "devin",
                  nativeSessionId: info.sessionId,
                  formatVersion: 1,
                }),
              },
        );
        expect(result.ok && result.value.initialState.effectivePermissionModeId).toBe("plan");
        expect(f.configure).toHaveBeenCalledWith("mode", "plan");
      } finally {
        await f.adapter.close();
      }
    },
  );
});

describe("Devin configuration during an active Turn", () => {
  it("sends model selection immediately and publishes only the confirmed state", async () => {
    const f = activeSession();
    const config = Promise.withResolvers<Awaited<ReturnType<DevinTransport["configure"]>>>();
    f.configure.mockReturnValue(config.promise);
    try {
      expect((await f.session.execute(start)).ok).toBe(true);
      const selection = f.session.execute({ type: "model.select", model });
      expect(f.configure).toHaveBeenCalledWith("model", "gpt-5-4-mini-low");
      expect(f.session.initialState.effectiveModel).toEqual(devinModelRef("swe-2-high"));
      expect(
        f.outputs.some((o) => o.kind === "event" && o.event.type === "session.state.changed"),
      ).toBe(false);
      expect(await f.session.execute({ type: "model.select", model })).toMatchObject({
        ok: false,
        error: { code: "sessionBusy" },
      });
      expect(await f.session.readSnapshot()).toMatchObject({
        ok: false,
        error: { code: "sessionBusy" },
      });
      config.resolve(confirmed("model", "gpt-5-4-mini-low"));
      expect(await selection).toEqual({ ok: true, value: { completed: true } });
      await vi.waitFor(() =>
        expect(f.outputs).toContainEqual({
          kind: "event",
          event: {
            type: "session.state.changed",
            state: expect.objectContaining({ effectiveModel: model }),
          },
        }),
      );
      expect(f.outputs.some((o) => o.kind === "event" && o.event.type === "turn.completed")).toBe(
        false,
      );
      expect(f.cancel).not.toHaveBeenCalled();
      expect(
        await f.session.execute({ ...start, turnId: hostTurnIdSchema.parse("second-turn") }),
      ).toMatchObject({ ok: false, error: { code: "sessionBusy" } });
      expect(
        await f.session.execute({
          type: "permissionMode.select",
          permissionModeId: harnessPermissionModeIdSchema.parse("plan"),
        }),
      ).toMatchObject({ ok: false, error: { code: "sessionBusy" } });
      f.turn.resolve({
        stopReason: "end_turn",
        _meta: { "cognition.ai/userMessageId": "native-turn" },
      });
      await vi.waitFor(() =>
        expect(f.outputs).toContainEqual(
          expect.objectContaining({
            event: expect.objectContaining({
              type: "turn.completed",
              outcome: { status: "succeeded" },
            }),
          }),
        ),
      );
    } finally {
      config.resolve(confirmed("model", "gpt-5-4-mini-low"));
      await f.close();
    }
  });
  it.each(["rejected", "unconfirmed"])(
    "preserves state and the active Turn on %s native selection",
    async (failure) => {
      const f = activeSession();
      if (failure === "rejected")
        f.configure.mockRejectedValue(new Error("Native configuration refused"));
      else f.configure.mockResolvedValue(confirmed("model", "swe-2-high"));
      try {
        await f.session.execute(start);
        expect(await f.session.execute({ type: "model.select", model })).toMatchObject({
          ok: false,
          error: { code: "protocolError" },
        });
        expect(f.configure).toHaveBeenCalledTimes(1);
        expect(f.session.initialState.effectiveModel).toEqual(devinModelRef("swe-2-high"));
        expect(
          f.outputs.some((o) => o.kind === "event" && o.event.type === "session.state.changed"),
        ).toBe(false);
        expect(f.outputs.some((o) => o.kind === "event" && o.event.type === "turn.completed")).toBe(
          false,
        );
        f.configure.mockImplementation(async (id, value) => confirmed(id, value));
        expect((await f.session.execute({ type: "model.select", model })).ok).toBe(true);
      } finally {
        await f.close();
      }
    },
  );
  it("keeps cancellation available while native configuration is pending", async () => {
    const f = activeSession();
    const config = Promise.withResolvers<Awaited<ReturnType<DevinTransport["configure"]>>>();
    f.configure.mockReturnValue(config.promise);
    try {
      await f.session.execute(start);
      const selection = f.session.execute({ type: "model.select", model });
      expect(f.configure).toHaveBeenCalledTimes(1);
      expect((await f.session.execute({ type: "turn.cancel", turnId })).ok).toBe(true);
      expect(f.cancel).toHaveBeenCalledTimes(1);
      await vi.waitFor(() =>
        expect(f.outputs).toContainEqual(
          expect.objectContaining({
            event: expect.objectContaining({
              type: "turn.completed",
              outcome: { status: "cancelled" },
            }),
          }),
        ),
      );
      expect(
        await f.session.execute({ ...start, turnId: hostTurnIdSchema.parse("next-turn") }),
      ).toMatchObject({ ok: false, error: { code: "sessionBusy" } });
      config.resolve(confirmed("model", "gpt-5-4-mini-low"));
      expect((await selection).ok).toBe(true);
    } finally {
      config.resolve(confirmed("model", "gpt-5-4-mini-low"));
      await f.close();
    }
  });
  it("reports unsupported thinking selection even while a Turn is active", async () => {
    const f = activeSession();
    try {
      await f.session.execute(start);
      expect(
        await f.session.execute({
          type: "thinking.select",
          thinkingOptionId: harnessThinkingOptionIdSchema.parse("high"),
        }),
      ).toMatchObject({ ok: false, error: { code: "unsupported" } });
      expect(f.configure).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  });
});
