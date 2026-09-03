import { describe, expect, it } from "vitest";

import {
  executeModernCommand,
  listModernCommands,
  ModernCommandError,
  parseModernCommandDescriptors,
  parseModernCommandExecution,
  type ModernCommandRemote,
} from "../../src/modern/commands.js";
import {
  ModernRemoteConnectionError,
  type ModernRemoteConnectionErrorCode,
} from "../../src/modern/remote-connection.js";
import type { ModernRemoteResult } from "../../src/modern/wire.js";

interface RemoteCall {
  readonly endpoint: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly signal: AbortSignal | undefined;
  readonly options: { readonly timeoutMs?: number | null } | undefined;
}

class FakeRemote implements ModernCommandRemote {
  readonly calls: RemoteCall[] = [];

  constructor(readonly result: ModernRemoteResult<unknown> | Error) {}

  call<T>(
    endpoint: string,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
    options?: { readonly timeoutMs?: number | null },
  ): Promise<ModernRemoteResult<T>> {
    this.calls.push({ endpoint, args, signal, options });
    return this.result instanceof Error
      ? Promise.reject(this.result)
      : Promise.resolve(this.result as ModernRemoteResult<T>);
  }
}

describe("DeepSeek Harness Modern native commands", () => {
  it("lists the exact Session catalog and exposes only the shared reviewed whitelist", async () => {
    const signal = new AbortController().signal;
    const remote = new FakeRemote({
      ok: true,
      value: [
        {
          name: "goal",
          description: "Set or view the goal",
          input: { hint: "[objective]", images: true },
        },
        {
          name: "permission",
          description: "Select permissions",
          input: { hint: "<preset>" },
        },
        { name: "compact", description: "Compact context" },
        { name: "future", description: "Future command" },
        {
          name: "plan",
          description: "Enter or leave plan mode",
          input: { hint: "[off|message]", images: false },
        },
      ],
    });

    await expect(listModernCommands(remote, "session-1", signal)).resolves.toMatchObject({
      commands: [
        { id: "dsh.goal", invocation: "/dsh-goal", argumentMode: "text" },
        { id: "dsh.compact", invocation: "/compact", argumentMode: "none" },
        { id: "dsh.plan", invocation: "/plan", argumentMode: "text" },
      ],
    });
    expect(remote.calls).toEqual([
      {
        endpoint: "commands/list",
        args: { agentId: "session-1" },
        signal,
        options: undefined,
      },
    ]);
  });

  it("executes the complete native line once with empty images and no transport timeout", async () => {
    const signal = new AbortController().signal;
    const line = "/goal edit  preserve spacing  ";
    const remote = new FakeRemote({
      ok: true,
      value: {
        commandId: "cmd-1234abcd-1",
        result: { kind: "success", text: "updated", sourceEventSeq: 17 },
      },
    });

    await expect(executeModernCommand(remote, "session-1", line, signal)).resolves.toEqual({
      commandId: "cmd-1234abcd-1",
      result: { kind: "success", text: "updated", sourceEventSeq: 17 },
    });
    expect(remote.calls).toEqual([
      {
        endpoint: "commands/execute",
        args: { agentId: "session-1", line, images: [] },
        signal,
        options: { timeoutMs: null },
      },
    ]);
  });

  it("preserves undefined admission misses and strict native error results", async () => {
    const signal = new AbortController().signal;
    await expect(
      executeModernCommand(
        new FakeRemote({ ok: true, value: undefined }),
        "session-1",
        "/future",
        signal,
      ),
    ).resolves.toBeUndefined();
    await expect(
      executeModernCommand(
        new FakeRemote({
          ok: true,
          value: { commandId: "cmd-1234abcd-2", result: { kind: "error", text: "busy" } },
        }),
        "session-1",
        "/compact",
        signal,
      ),
    ).resolves.toEqual({
      commandId: "cmd-1234abcd-2",
      result: { kind: "error", text: "busy" },
    });
  });

  it.each([
    ["a non-array", {}],
    ["an extra descriptor field", [{ name: "compact", description: "Compact", extra: true }]],
    ["an invalid name", [{ name: "Compact", description: "Compact" }]],
    ["an oversized name", [{ name: `a${"x".repeat(128)}`, description: "Command" }]],
    ["a blank description", [{ name: "compact", description: " " }]],
    ["an oversized description", [{ name: "compact", description: "x".repeat(513) }]],
    [
      "an extra input field",
      [{ name: "goal", description: "Goal", input: { hint: "objective", extra: true } }],
    ],
    [
      "an invalid images flag",
      [{ name: "goal", description: "Goal", input: { hint: "objective", images: "yes" } }],
    ],
    [
      "duplicate names",
      [
        { name: "compact", description: "First" },
        { name: "compact", description: "Second" },
      ],
    ],
  ])("rejects %s in commands/list", (_label, value) => {
    expect(() => parseModernCommandDescriptors(value)).toThrowError(
      expect.objectContaining({ code: "protocolError" }),
    );
  });

  it("bounds the native catalog before parsing entries", () => {
    const value = Array.from({ length: 1_025 }, () => ({
      name: "compact",
      description: "Compact",
    }));
    expect(() => parseModernCommandDescriptors(value)).toThrowError(
      expect.objectContaining({ code: "limitExceeded" }),
    );
  });

  it.each([
    ["a non-record", null],
    ["an empty command id", { commandId: "", result: { kind: "success" } }],
    ["an oversized command id", { commandId: "x".repeat(513), result: { kind: "success" } }],
    ["an extra execution field", { commandId: "cmd-1", result: { kind: "success" }, extra: true }],
    ["an extra success field", { commandId: "cmd-1", result: { kind: "success", extra: true } }],
    [
      "a negative zero sequence",
      { commandId: "cmd-1", result: { kind: "success", sourceEventSeq: -0 } },
    ],
    [
      "a fractional sequence",
      { commandId: "cmd-1", result: { kind: "success", sourceEventSeq: 1.5 } },
    ],
    ["a blank error", { commandId: "cmd-1", result: { kind: "error", text: " " } }],
    [
      "a sequence on an error",
      { commandId: "cmd-1", result: { kind: "error", text: "failed", sourceEventSeq: 1 } },
    ],
    ["an unknown result kind", { commandId: "cmd-1", result: { kind: "future" } }],
  ])("rejects %s in commands/execute", (_label, value) => {
    expect(() => parseModernCommandExecution(value)).toThrowError(
      expect.objectContaining({ code: "protocolError" }),
    );
  });

  it("bounds command result text", () => {
    expect(() =>
      parseModernCommandExecution({
        commandId: "cmd-1",
        result: { kind: "success", text: "x".repeat(64 * 1_024 + 1) },
      }),
    ).toThrowError(expect.objectContaining({ code: "protocolError" }));
  });

  it.each([
    ["protocolError", "protocolError"],
    ["authenticationRequired", "authenticationRequired"],
    ["processExited", "processExited"],
    ["notInstalled", "notInstalled"],
    ["cancelled", "cancelled"],
    ["unavailable", "unavailable"],
  ] as const satisfies readonly (readonly [
    ModernRemoteConnectionErrorCode,
    ModernCommandError["code"],
  ])[])("preserves connection error %s as %s", async (sourceCode, expectedCode) => {
    const canary = "COMMAND_CONNECTION_SECRET_CANARY";
    const source = new ModernRemoteConnectionError(
      sourceCode,
      `secret=${canary}`,
      `api_key=${canary}`,
    );
    Object.defineProperty(source, "cause", { enumerable: true, value: new Error(canary) });

    const failure = await listModernCommands(new FakeRemote(source), "session-1").catch(
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({ code: expectedCode, nativeCode: "api_key=[redacted]" });
    expect((failure as Error).cause).toBeUndefined();
    expect(JSON.stringify(failure)).not.toContain(canary);
  });

  it("keeps only sanitized Remote failure code/message and never retries execution", async () => {
    const canary = "COMMAND_REMOTE_SECRET_CANARY";
    const remote = new FakeRemote({
      ok: false,
      error: {
        code: `api_key=${canary}`,
        message: `secret=${canary}`,
        details: { secret: canary },
      },
    });

    const failure = await executeModernCommand(
      remote,
      "session-1",
      "/compact",
      new AbortController().signal,
    ).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "remoteError", nativeCode: "api_key=[redacted]" });
    expect(failure).not.toHaveProperty("details");
    expect((failure as Error).cause).toBeUndefined();
    expect(JSON.stringify(failure)).not.toContain(canary);
    expect(remote.calls).toHaveLength(1);
  });

  it("forwards an already-aborted Signal and preserves typed cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    const remote = new FakeRemote(
      new ModernRemoteConnectionError("cancelled", "command request was cancelled"),
    );

    await expect(
      executeModernCommand(remote, "session-1", "/compact", controller.signal),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(remote.calls).toEqual([
      {
        endpoint: "commands/execute",
        args: { agentId: "session-1", line: "/compact", images: [] },
        signal: controller.signal,
        options: { timeoutMs: null },
      },
    ]);
  });

  it("drops raw exception messages and causes", async () => {
    const canary = "COMMAND_THROWN_SECRET_CANARY";
    const failure = await listModernCommands(
      new FakeRemote(new Error(`api_key=${canary}`, { cause: new Error(canary) })),
      "session-1",
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ModernCommandError);
    expect(failure).toMatchObject({ code: "unavailable" });
    expect((failure as Error).cause).toBeUndefined();
    expect(JSON.stringify(failure)).not.toContain(canary);
  });
});
