import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { HarnessOutput } from "@codexhost/harness-adapter";
import { hostTurnIdSchema, nativeSessionRefSchema } from "@codexhost/shared-contracts";
import { DevinAdapter } from "../src/adapter.js";
import { devinThinkingOptionId } from "../src/models.js";

vi.mock("../src/command.js", () => ({
  devinInvocation: (environment: NodeJS.ProcessEnv) => ({
    command: process.execPath,
    arguments: [
      fileURLToPath(new URL("./fixtures/configuration-acp.mjs", import.meta.url)),
      environment.DEVIN_TEST_SCENARIO ?? "normal",
    ],
    windowsVerbatimArguments: false,
  }),
}));

describe("Devin ACP configuration transport", () => {
  it("rejects a snapshot when a native load response contains an invalid complete config list", async () => {
    const adapter = new DevinAdapter({
      environment: { DEVIN_TEST_SCENARIO: "invalid-reload" },
      timeoutMs: 2_000,
    });
    const opened = await adapter.open({
      kind: "resume",
      cwd: process.cwd(),
      nativeRef: nativeSessionRefSchema.parse({
        harnessId: "devin",
        nativeSessionId: "fixture-session",
        formatVersion: 1,
      }),
    });
    if (!opened.ok) throw new Error(opened.error.message);
    const session = opened.value;
    const outputs: HarnessOutput[] = [];
    const done = (async () => {
      for await (const output of session.outputs) outputs.push(output);
    })();
    try {
      const snapshot = await session.readSnapshot();
      expect(snapshot).toMatchObject({ ok: false });
      expect(snapshot).not.toHaveProperty("value");
      expect(await session.readSnapshot()).toMatchObject({
        ok: false,
        error: { code: "invalidState" },
      });
      expect(session.initialState.effectiveThinkingOptionId).toBe(devinThinkingOptionId("low"));
      expect(outputs).toContainEqual(
        expect.objectContaining({
          event: expect.objectContaining({
            type: "session.faulted",
            error: expect.objectContaining({ code: "protocolError" }),
          }),
        }),
      );
    } finally {
      await adapter.close();
      await done;
    }
  });
  it("observes complete config notifications while idle/running and refreshes state on load", async () => {
    const adapter = new DevinAdapter({ environment: {}, timeoutMs: 2_000 });
    const opened = await adapter.open({
      kind: "resume",
      cwd: process.cwd(),
      nativeRef: nativeSessionRefSchema.parse({
        harnessId: "devin",
        nativeSessionId: "fixture-session",
        formatVersion: 1,
      }),
    });
    if (!opened.ok) throw new Error(opened.error.message);
    const session = opened.value;
    const outputs: HarnessOutput[] = [];
    const done = (async () => {
      for await (const output of session.outputs) outputs.push(output);
    })();
    try {
      expect(session.initialState.effectiveThinkingOptionId).toBe(devinThinkingOptionId("low"));
      const notified = await session.readSnapshot();
      expect(notified).toMatchObject({
        ok: true,
        value: { state: { effectiveThinkingOptionId: devinThinkingOptionId("high") } },
      });
      const snapshot = await session.readSnapshot();
      expect(snapshot).toMatchObject({
        ok: true,
        value: { state: { availableThinkingOptions: [] } },
      });
      expect(snapshot.ok && snapshot.value.state).not.toHaveProperty("effectiveThinkingOptionId");
      expect(session.capabilities.configuration.selectThinkingOption).toBe(false);
      const turnId = hostTurnIdSchema.parse("fixture-turn");
      expect(
        (
          await session.execute({
            type: "turn.start",
            turnId,
            input: [{ type: "text", text: "fixture only" }],
          })
        ).ok,
      ).toBe(true);
      await vi.waitFor(() =>
        expect(session.initialState.effectiveThinkingOptionId).toBe(devinThinkingOptionId("low")),
      );
      expect(session.capabilities.configuration.selectThinkingOption).toBe(true);
      expect(session.initialState.effectivePermissionModeId).toBe("bypass");
      expect(
        (
          await session.execute({
            type: "thinking.select",
            thinkingOptionId: devinThinkingOptionId("high"),
          })
        ).ok,
      ).toBe(true);
      expect(session.initialState.effectiveThinkingOptionId).toBe(devinThinkingOptionId("high"));
      expect(session.initialState.effectivePermissionModeId).toBe("bypass");
      expect((await session.execute({ type: "turn.cancel", turnId })).ok).toBe(true);
      await vi.waitFor(() =>
        expect(outputs).toContainEqual(
          expect.objectContaining({
            event: expect.objectContaining({
              type: "turn.completed",
              outcome: { status: "cancelled" },
            }),
          }),
        ),
      );
    } finally {
      await adapter.close();
      await done;
    }
  });
});
