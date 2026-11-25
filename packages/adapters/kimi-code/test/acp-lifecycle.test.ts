import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PromptResponse } from "@agentclientprotocol/sdk";
import { KimiAcpTransport, type ActivePromptHandler } from "../src/acp-transport.js";

type FakeChildMode = "exit-on-stdin" | "exit-on-sigkill" | "ignore-sigkill";

interface FakeChildHandle {
  signals: Array<NodeJS.Signals | number | undefined>;
  exitWithSignal(signal: NodeJS.Signals): void;
  exitWithCode(code: number): void;
}

const childHarness = vi.hoisted(() => ({
  mode: "exit-on-stdin" as FakeChildMode,
  lastChild: null as FakeChildHandle | null,
}));

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
    const mode = childHarness.mode;
    const signals: Array<NodeJS.Signals | number | undefined> = [];
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
    });
    const exitWithCode = (code: number) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.exitCode = code;
      child.emit("exit", code, null);
    };
    const exitWithSignal = (signal: NodeJS.Signals) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.signalCode = signal;
      child.emit("exit", null, signal);
    };
    child.stdin.on("finish", () => {
      if (mode === "exit-on-stdin") exitWithCode(0);
    });
    queueMicrotask(() => child.emit("spawn"));
    childHarness.lastChild = { signals, exitWithSignal, exitWithCode };
    return Object.assign(child, {
      kill: (signal?: NodeJS.Signals | number) => {
        signals.push(signal);
        if (mode === "exit-on-stdin") {
          exitWithCode(0);
        } else if (mode === "exit-on-sigkill" && signal === "SIGKILL") {
          queueMicrotask(() => exitWithSignal("SIGKILL"));
        }
        return true;
      },
    });
  },
}));

afterEach(() => {
  childHarness.mode = "exit-on-stdin";
  childHarness.lastChild = null;
});

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

describe("Kimi ACP close confirmation", () => {
  it("resolves after SIGKILL confirms process exit when SIGTERM is ignored", async () => {
    childHarness.mode = "exit-on-sigkill";
    const transport = new KimiAcpTransport({ cwd: process.cwd(), closeTimeoutMs: 20 });
    await transport.openSession({ kind: "create" });

    await expect(transport.close()).resolves.toBeUndefined();
    expect(childHarness.lastChild?.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(transport.isClosed).toBe(true);
  });

  it("rejects when the child still has not exited after SIGKILL and allows retry once exited", async () => {
    childHarness.mode = "ignore-sigkill";
    const transport = new KimiAcpTransport({ cwd: process.cwd(), closeTimeoutMs: 20 });
    await transport.openSession({ kind: "create" });

    await expect(transport.close()).rejects.toThrow(/did not exit after SIGKILL/i);
    expect(childHarness.lastChild?.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(transport.isClosed).toBe(false);
    await expect(transport.cancel()).rejects.toThrow("Kimi ACP session is not available");

    childHarness.lastChild?.exitWithSignal("SIGKILL");
    await expect(transport.close()).resolves.toBeUndefined();
    expect(transport.isClosed).toBe(true);
  });

  it("is idempotent when closed before spawn or after the child already exited", async () => {
    const unstarted = new KimiAcpTransport({ cwd: process.cwd(), closeTimeoutMs: 20 });
    await expect(unstarted.close()).resolves.toBeUndefined();
    expect(unstarted.isClosed).toBe(true);

    childHarness.mode = "ignore-sigkill";
    const transport = new KimiAcpTransport({ cwd: process.cwd(), closeTimeoutMs: 20 });
    await transport.openSession({ kind: "create" });
    childHarness.lastChild?.exitWithCode(0);
    await expect(transport.close()).resolves.toBeUndefined();
    expect(childHarness.lastChild?.signals).toEqual([]);
    expect(transport.isClosed).toBe(true);
  });
});
