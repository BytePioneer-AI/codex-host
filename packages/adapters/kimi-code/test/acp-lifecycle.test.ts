import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import type { PromptResponse } from "@agentclientprotocol/sdk";
import { KimiAcpTransport, type ActivePromptHandler } from "../src/acp-transport.js";

const connection = vi.hoisted(() => ({
  initialize: vi.fn(async () => ({ protocolVersion: 1 })),
  newSession: vi.fn(async () => ({ sessionId: "native-session" })),
  prompt: vi.fn<() => Promise<PromptResponse>>(),
  cancel: vi.fn(async () => {}),
  request: vi.fn(async () => ({})),
}));
vi.mock("@agentclientprotocol/sdk", () => ({
  ClientSideConnection: function () {
    return connection;
  },
  ndJsonStream: () => ({}),
}));
vi.mock("../src/command.js", () => ({
  KimiExecutableError: class extends Error {},
  resolveKimiExecutable: () => "fake-kimi",
  kimiInvocation: () => ({ command: "fake-kimi", arguments: [], windowsVerbatimArguments: false }),
}));
vi.mock("node:child_process", () => ({
  spawn: () => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null as number | null,
    });
    const finish = () => {
      child.exitCode = 0;
      child.emit("exit", 0);
    };
    child.stdin.on("finish", finish);
    queueMicrotask(() => child.emit("spawn"));
    return Object.assign(child, { kill: finish });
  },
}));

describe("Kimi ACP cancellation", () => {
  it("waits for the native prompt terminal response instead of a 500ms cancellation timer", async () => {
    let finish!: (value: PromptResponse) => void;
    connection.prompt.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const transport = new KimiAcpTransport({ cwd: process.cwd(), closeTimeoutMs: 10 });
    await transport.openSession({ kind: "create" });
    const handler: ActivePromptHandler = {
      onEvent() {},
      onPermission: async () => ({ outcome: { outcome: "cancelled" } }),
      onElicitation: async () => ({ action: "cancel" }),
    };
    let settled = false;
    const prompt = transport.prompt("hello", handler).then((response) => {
      settled = true;
      return response;
    });
    try {
      await transport.cancel();
      await delay(550);
      expect(settled).toBe(false);
    } finally {
      finish({ stopReason: "cancelled" });
      await prompt;
      await transport.close();
    }
  });

  it("propagates a failed cancellation request", async () => {
    const transport = new KimiAcpTransport({ cwd: process.cwd(), closeTimeoutMs: 10 });
    await transport.openSession({ kind: "create" });
    connection.cancel.mockRejectedValueOnce(new Error("connection closed"));
    await expect(transport.cancel()).rejects.toThrow("connection closed");
    await transport.close();
  });
});
