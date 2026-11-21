import path from "node:path";
import { describe, it, expect, vi } from "vitest";
import { CodeBuddyAcpClient } from "../src/acp-client.js";
const state = vi.hoisted(() => ({ scenario: "normal" }));
vi.mock("../src/command.js", () => ({
  codeBuddyInvocation: () => ({
    command: process.execPath,
    arguments: [
      path.resolve("packages/adapters/codebuddy/test/fixtures/acp.mjs"),
      state.scenario,
      ...(state.scenario === "serve-banner" ? ["--serve"] : []),
    ],
    environment: process.env,
    windowsVerbatimArguments: false,
  }),
}));
const handlers = () => ({
  update: vi.fn(),
  permission: vi.fn(),
  question: vi.fn(),
  fault: vi.fn(),
});
describe("CodeBuddy ACP process retirement", () => {
  it("delivers native session_end, which ACP SDK 1.3 does not define, in wire order", async () => {
    state.scenario = "session-end";
    const callbacks = handlers();
    const client = new CodeBuddyAcpClient({
      cwd: process.cwd(),
      environment: process.env,
      ephemeral: true,
      handlers: callbacks,
    });
    try {
      await client.initialize();
      await client.open(process.cwd());
      await client.prompt("native", "hi");
      await vi.waitFor(() => expect(callbacks.update).toHaveBeenCalledTimes(3));
      expect(callbacks.update.mock.calls.map(([notification]) => notification.update)).toEqual([
        expect.objectContaining({ sessionUpdate: "agent_message_chunk" }),
        {
          sessionUpdate: "session_end",
          stopReason: "end_turn",
          _meta: { "codebuddy.ai/requestId": "drain" },
        },
        expect.objectContaining({ sessionUpdate: "agent_message_chunk" }),
      ]);
      expect(callbacks.fault).not.toHaveBeenCalled();
    } finally {
      await client.close();
      state.scenario = "normal";
    }
  });
  it("initializes a server-mode ACP process without parsing its native banner", async () => {
    state.scenario = "serve-banner";
    const callbacks = handlers();
    const client = new CodeBuddyAcpClient({
      cwd: process.cwd(),
      environment: process.env,
      ephemeral: true,
      handlers: callbacks,
    });
    try {
      await expect(client.initialize()).resolves.toMatchObject({ protocolVersion: 1 });
      await expect(client.open(process.cwd())).resolves.toMatchObject({ sessionId: "native" });
      expect(callbacks.fault).not.toHaveBeenCalled();
    } finally {
      await client.close();
      state.scenario = "normal";
    }
  });
  it("settles an accepted prompt on exit even while descendants retain native pipes", async () => {
    state.scenario = "exit-open-pipes";
    const callbacks = handlers();
    const client = new CodeBuddyAcpClient({
      cwd: process.cwd(),
      environment: process.env,
      ephemeral: false,
      handlers: callbacks,
    });
    try {
      await client.initialize();
      await client.open(process.cwd());
      const settled = vi.fn();
      const pending = client.prompt("native", "hi").catch((error) => {
        settled(error);
      });
      await vi.waitFor(() => expect(callbacks.fault).toHaveBeenCalled(), { timeout: 800 });
      await pending;
      expect(settled).toHaveBeenCalledOnce();
    } finally {
      await client.close();
      state.scenario = "normal";
    }
  });
  it.each(["configure", "answer"])(
    "retires the transport after a %s timeout and rejects retries",
    async (method) => {
      const callbacks = handlers();
      const client = new CodeBuddyAcpClient(
        { cwd: process.cwd(), environment: process.env, ephemeral: false, handlers: callbacks },
        150,
      );
      try {
        await client.initialize();
        await client.open(process.cwd());
        const result =
          method === "configure"
            ? client.configure("native", "model", "next")
            : client.answer("native", "call", {});
        await expect(result).rejects.toThrow("timed out");
        expect(callbacks.fault).toHaveBeenCalledOnce();
        await expect(client.prompt("native", "must not be accepted")).rejects.toThrow();
      } finally {
        await client.close();
      }
    },
  );
});
