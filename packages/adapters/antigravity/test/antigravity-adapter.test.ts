import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { HarnessOutput, HostEvent } from "@codexhost/harness-adapter";
import {
  accountCreditsSnapshotSchema,
  harnessModelRefSchema,
  harnessThinkingOptionIdSchema,
  hostTurnIdSchema,
} from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";

import {
  AntigravityAdapter,
  antigravityAvailableThinkingOptions,
  antigravityModelArguments,
  antigravityToolErrorMessage,
  fetchAntigravityQuota,
  isAntigravityPermissionDenial,
  parseAntigravityContextUsage,
  parseAntigravityModels,
  parseAntigravityStreamLine,
  parseAntigravityUsageCommand,
  permissionDeniedTurnError,
} from "../src/index.js";

const FETCHED_AT = "2026-08-31T14:40:00.000Z";

/** Captured from `agy --print=/usage --output-format stream-json` (CLI v1.1.22). */
const USAGE_COMMAND = {
  name: "usage",
  data: {
    description: "Within each group, models share a weekly limit and a 5-hour limit.",
    groups: [
      {
        name: "Gemini Models",
        description: "Models within this group: Gemini Flash, Gemini Pro",
        buckets: [
          {
            id: "gemini-weekly",
            name: "Weekly Limit Remaining",
            window: "weekly",
            remaining_fraction: 0.9735029339790344,
            reset_time: "2026-09-01T03:17:57Z",
          },
          {
            id: "gemini-5h",
            name: "Five Hour Limit Remaining",
            window: "5h",
            remaining_fraction: 1,
            reset_time: "2026-08-31T19:38:13Z",
          },
        ],
      },
      {
        name: "Claude and GPT models",
        description: "Models within this group: Claude Opus, Claude Sonnet, GPT-OSS",
        buckets: [
          {
            id: "3p-weekly",
            name: "Weekly Limit Remaining",
            window: "weekly",
            remaining_fraction: 1,
            reset_time: "2026-09-07T14:38:13Z",
          },
        ],
      },
    ],
  },
} as const;

/**
 * Writes a stand-in for `agy models` so `open()` can be exercised without the
 * real CLI. `commandInvocation` wraps `.cmd` through cmd.exe on Windows, so a
 * batch shim is executable there and a shell script elsewhere.
 */
async function fakeAgy(lines: readonly string[]): Promise<{
  command: string;
  cwd: string;
  cleanup(): Promise<void>;
}> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-agy-"));
  // The Session's cwd stays outside the shim directory; Windows keeps a handle
  // on a directory it has executed from and cleanup would hit EBUSY.
  const cwd = await mkdtemp(path.join(os.tmpdir(), "codexhost-agy-cwd-"));
  const cleanup = async (): Promise<void> => {
    for (const target of [directory, cwd]) {
      await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  };
  if (process.platform === "win32") {
    const command = path.join(directory, "agy.cmd");
    await writeFile(
      command,
      `@echo off\r\n${lines.map((line) => `echo ${line}`).join("\r\n")}\r\n`,
    );
    return { command, cwd, cleanup };
  }
  const command = path.join(directory, "agy");
  await writeFile(command, `#!/bin/sh\ncat <<'MODELS'\n${lines.join("\n")}\nMODELS\n`);
  await chmod(command, 0o755);
  return { command, cwd, cleanup };
}

// Labels stay free of parentheses so the batch shim does not need escaping;
// the label-suffix handling is covered by the Catalog tests above.
const FAKE_MODELS = [
  "gemini-3.1-pro-high\tGemini 3.1 Pro High",
  "gemini-3.1-pro-low\tGemini 3.1 Pro Low",
  "claude-sonnet-4-6\tClaude Sonnet 4.6 Thinking",
] as const;

describe("Antigravity Adapter", () => {
  it("parses the CLI Model catalog", () => {
    expect(
      parseAntigravityModels(
        [
          "gemini-3.7-flash-high\tGemini 3.7 Flash (High)",
          "gemini-3.7-flash-medium\tGemini 3.7 Flash (Medium)",
          "gemini-3.7-flash-low\tGemini 3.7 Flash (Low)",
          "gemini-3.1-pro-high\tGemini 3.1 Pro (High)",
          "gemini-3.1-pro-low\tGemini 3.1 Pro (Low)",
          "claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)",
          "",
        ].join("\n"),
      ),
    ).toMatchObject({
      models: [
        {
          ref: { id: "gemini-3.7-flash" },
          label: "Gemini 3.7 Flash",
          supportedThinkingOptionIds: ["low", "medium", "high"],
        },
        // The CLI rejects `--effort medium` for Pro, so it must not be offered.
        {
          ref: { id: "gemini-3.1-pro" },
          label: "Gemini 3.1 Pro",
          supportedThinkingOptionIds: ["low", "high"],
        },
        { ref: { id: "claude-sonnet-4-6" }, label: "Claude Sonnet 4.6 (Thinking)" },
      ],
      defaultModel: { id: "gemini-3.7-flash" },
      thinkingOptions: [
        { id: "low", label: "Low" },
        { id: "medium", label: "Medium" },
        { id: "high", label: "High" },
      ],
      defaultThinkingOptionId: "high",
    });
  });

  it("leaves Models without effort variants free of Thinking options", () => {
    const catalog = parseAntigravityModels(
      "claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\nclaude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)\n",
    );
    // `-thinking` is not an effort suffix, so the ID must stay intact.
    expect(catalog.models.map(({ ref }) => ref.id)).toEqual([
      "claude-sonnet-4-6",
      "claude-opus-4-6-thinking",
    ]);
    expect(catalog.models.every((model) => !model.supportedThinkingOptionIds)).toBe(true);
    expect(catalog.thinkingOptions).toEqual([]);
    expect(catalog.defaultThinkingOptionId).toBeUndefined();
  });

  it("passes effort as its own flag and never alongside a suffixed Model ID", () => {
    const ref = (id: string) => harnessModelRefSchema.parse({ id });
    const effort = (id: string) => harnessThinkingOptionIdSchema.parse(id);
    expect(antigravityModelArguments(ref("gemini-3.1-pro"), effort("low"))).toEqual([
      "--model",
      "gemini-3.1-pro",
      "--effort",
      "low",
    ]);
    // A Thread stored before efforts were split keeps its suffixed ID, and the
    // CLI fails that ID outright when `--effort` is also present.
    expect(antigravityModelArguments(ref("gemini-3.1-pro-low"), effort("high"))).toEqual([
      "--model",
      "gemini-3.1-pro-low",
    ]);
    expect(antigravityModelArguments(ref("claude-sonnet-4-6"), undefined)).toEqual([
      "--model",
      "claude-sonnet-4-6",
    ]);
    expect(antigravityModelArguments(undefined, effort("high"))).toEqual([]);
  });

  it("refuses an initial effort the Model does not accept", async () => {
    const { command, cwd, cleanup } = await fakeAgy(FAKE_MODELS);
    const adapter = new AntigravityAdapter({ command });
    try {
      // `thread/start` reaches open() directly, so refusing here is what keeps
      // the CLI from failing on `--effort` only once the first Turn runs.
      const opened = await adapter.open({
        kind: "create",
        cwd,
        model: harnessModelRefSchema.parse({ id: "claude-sonnet-4-6" }),
        thinkingOptionId: harnessThinkingOptionIdSchema.parse("high"),
      });
      expect(opened.ok).toBe(false);
      if (opened.ok) return;
      expect(opened.error.code).toBe("invalidRequest");
      expect(opened.error.message).toContain("high");
    } finally {
      await adapter.close();
      await cleanup();
    }
  });

  it("opens with an effort the Model accepts and reports it as effective", async () => {
    const { command, cwd, cleanup } = await fakeAgy(FAKE_MODELS);
    const adapter = new AntigravityAdapter({ command });
    try {
      const opened = await adapter.open({
        kind: "create",
        cwd,
        model: harnessModelRefSchema.parse({ id: "gemini-3.1-pro" }),
        thinkingOptionId: harnessThinkingOptionIdSchema.parse("low"),
      });
      expect(opened.ok).toBe(true);
      if (!opened.ok) return;
      // No inspect() ran first, so the Catalog had to be fetched inside open().
      expect(opened.value.initialState.effectiveThinkingOptionId).toBe("low");
      expect(opened.value.initialState.availableThinkingOptions).toEqual([
        { id: "low", label: "Low" },
        { id: "high", label: "High" },
      ]);
      await opened.value.close();
    } finally {
      await adapter.close();
      await cleanup();
    }
  });

  it("reports only the efforts the selected Model accepts", () => {
    const catalog = parseAntigravityModels(
      [
        "gemini-3.1-pro-high\tGemini 3.1 Pro (High)",
        "gemini-3.1-pro-low\tGemini 3.1 Pro (Low)",
        "claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)",
      ].join("\n"),
    );
    expect(
      antigravityAvailableThinkingOptions(
        catalog,
        harnessModelRefSchema.parse({ id: "gemini-3.1-pro" }),
      ),
    ).toEqual([
      { id: "low", label: "Low" },
      { id: "high", label: "High" },
    ]);
    expect(
      antigravityAvailableThinkingOptions(
        catalog,
        harnessModelRefSchema.parse({ id: "claude-sonnet-4-6" }),
      ),
    ).toBeUndefined();
  });

  it("accepts typed stream events and ignores terminal noise", () => {
    expect(
      parseAntigravityStreamLine(
        '{"event":"step_update","step_update":{"conversation_id":"c1","step_index":1,"state":"ACTIVE","step_type":"agent_response","text_delta":"hi"}}',
      ),
    ).toMatchObject({ event: "step_update", step_update: { text_delta: "hi" } });
    expect(parseAntigravityStreamLine("permission warning")).toBeNull();
  });

  it("parses real Language Server context metadata", () => {
    const metadata = {
      trajectory: {
        generatorMetadata: [
          {
            chatModel: {
              chatStartMetadata: {
                contextWindowMetadata: {
                  estimatedTokensUsed: 19_505,
                  maxContextTokens: 256_000,
                  tokenBreakdown: { totalTokens: 19_505 },
                },
              },
            },
          },
        ],
      },
    };
    expect(parseAntigravityContextUsage(metadata)).toEqual({
      contextUsedTokens: 19_505,
      contextWindowTokens: 256_000,
    });
    expect(parseAntigravityContextUsage(metadata, "gemini-3.7-flash-high")).toEqual({
      contextUsedTokens: 19_505,
      contextWindowTokens: 1_048_576,
    });
    expect(parseAntigravityContextUsage(metadata, "claude-sonnet-4-6")).toEqual({
      contextUsedTokens: 19_505,
      contextWindowTokens: 256_000,
    });
    expect(parseAntigravityContextUsage({ generatorMetadata: [] })).toBeNull();
  });

  it("projects the CLI /usage command into an account credits snapshot", () => {
    const snapshot = parseAntigravityUsageCommand(USAGE_COMMAND, FETCHED_AT);
    // The Gemini weekly bucket is the most consumed, so it leads the pill.
    // Labels come from the window, not the CLI's "… Remaining" naming, because
    // the values are consumed percentages.
    expect(snapshot).toEqual({
      usedPercent: 2.65,
      periodType: "weekly",
      resetsAt: "2026-09-01T03:17:57Z",
      fetchedAt: FETCHED_AT,
      productUsage: [
        {
          product: "Gemini Models · 5-hour window",
          usagePercent: 0,
          resetsAt: "2026-08-31T19:38:13Z",
        },
        {
          product: "Claude and GPT models · Weekly window",
          usagePercent: 0,
          resetsAt: "2026-09-07T14:38:13Z",
        },
      ],
    });
  });

  it("never labels a consumed percentage as remaining", () => {
    const snapshot = parseAntigravityUsageCommand(USAGE_COMMAND, FETCHED_AT);
    const labels = (snapshot?.productUsage ?? []).map(({ product }) => product);
    expect(labels).not.toHaveLength(0);
    for (const label of labels) expect(label).not.toMatch(/remaining/iu);
  });

  it("keeps the quota snapshot valid against the Host credits contract", () => {
    const snapshot = parseAntigravityUsageCommand(USAGE_COMMAND, FETCHED_AT);
    expect(snapshot).not.toBeNull();
    // The Host strips `fetchedAt` before validating against the strict schema.
    const rest: Record<string, unknown> = { ...(snapshot as NonNullable<typeof snapshot>) };
    delete rest.fetchedAt;
    expect(accountCreditsSnapshotSchema.safeParse(rest).success).toBe(true);
  });

  it("rejects payloads that are not a /usage command result", () => {
    expect(parseAntigravityUsageCommand({ name: "credits", data: {} })).toBeNull();
    expect(parseAntigravityUsageCommand({ name: "usage", data: { groups: [] } })).toBeNull();
    expect(
      parseAntigravityUsageCommand({ name: "usage", data: { groups: [{ buckets: [{}] }] } }),
    ).toBeNull();
  });

  it("reads quota from the dedicated --print=/usage invocation", async () => {
    const calls: string[][] = [];
    const stdout = [
      JSON.stringify({ event: "command_result", command: USAGE_COMMAND }),
      JSON.stringify({
        event: "result",
        result: { conversation_id: "", status: "SUCCESS", num_turns: 0 },
      }),
    ].join("\n");
    const snapshot = await fetchAntigravityQuota((arguments_) => {
      calls.push([...arguments_]);
      return Promise.resolve(stdout);
    }, new Date(FETCHED_AT));
    expect(calls).toEqual([["--print=/usage", "--output-format", "stream-json"]]);
    expect(snapshot).toMatchObject({ usedPercent: 2.65, periodType: "weekly" });
  });

  it("degrades to null when the CLI cannot answer /usage", async () => {
    await expect(
      fetchAntigravityQuota(() => Promise.reject(new Error("agy is not installed"))),
    ).resolves.toBeNull();
    await expect(fetchAntigravityQuota(() => Promise.resolve("not json"))).resolves.toBeNull();
  });

  it("recognises the headless permission denial the CLI reports as a tool error", () => {
    const denial =
      'permission check failed for command "Get-Location": user denied permission to run command:\nGet-Location';
    expect(antigravityToolErrorMessage({ type: "TOOL_ERROR", message: denial })).toBe(denial);
    expect(isAntigravityPermissionDenial(denial)).toBe(true);
    expect(antigravityToolErrorMessage({ type: "TOOL_ERROR" })).toBeNull();
    expect(isAntigravityPermissionDenial("file not found")).toBe(false);
  });

  it("redacts credentials echoed by the denied command line", () => {
    const denial =
      "permission check failed for command \"curl -H 'Authorization: Bearer sk-live-abc123' https://api.example.com\": " +
      "user denied permission to run command";
    const error = permissionDeniedTurnError("request-review", denial);
    // The exact redaction shape belongs to sanitizeDiagnosticTail's own tests;
    // what matters here is that the Adapter routes the denial through it.
    expect(error.diagnostic).not.toContain("sk-live-abc123");
    expect(error.diagnostic).toContain("[redacted]");
    expect(error.message).toContain("'request-review'");
    expect(error.retryable).toBe(false);
  });

  describe("Session Lifecycle & Tool Streaming", () => {
    async function fakeStreamingAgy(streamLines: readonly string[]): Promise<{
      command: string;
      cwd: string;
      cleanup(): Promise<void>;
    }> {
      const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-agy-stream-"));
      const cwd = await mkdtemp(path.join(os.tmpdir(), "codexhost-agy-stream-cwd-"));
      const cleanup = async (): Promise<void> => {
        for (const target of [directory, cwd]) {
          await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
        }
      };
      const scriptContent = `
const lines = ${JSON.stringify(streamLines)};
if (process.argv.includes("models")) {
  process.stdout.write("gemini-3.7-flash-high\\tGemini 3.7 Flash High\\n");
  process.exit(0);
}
for (const line of lines) {
  process.stdout.write(line + "\\n");
}
`;
      const jsPath = path.join(directory, "agy.cjs");
      await writeFile(jsPath, scriptContent);
      if (process.platform === "win32") {
        const command = path.join(directory, "agy.cmd");
        await writeFile(command, `@node "${jsPath}" %*\r\n`);
        return { command, cwd, cleanup };
      }
      const command = path.join(directory, "agy");
      await writeFile(command, `#!/usr/bin/env node\n${scriptContent}`);
      await chmod(command, 0o755);
      return { command, cwd, cleanup };
    }

    async function nextEvent(iterator: AsyncIterator<HarnessOutput>): Promise<HostEvent> {
      const result = await iterator.next();
      if (result.done) throw new Error("Output stream ended unexpectedly");
      if (result.value.kind !== "event") throw new Error("Expected an event output");
      return result.value.event;
    }

    it("executes a turn projecting write_to_file, run_command, and agentMessage", async () => {
      const streamLines = [
        JSON.stringify({
          event: "init",
          init: { permission_mode: "dangerously-skip-permissions" },
          conversation_id: "conv-123",
        }),
        JSON.stringify({
          event: "step_update",
          step_update: {
            conversation_id: "conv-123",
            step_index: 1,
            state: "ACTIVE",
            step_type: "tool",
            tool_name: "write_to_file",
            tool_info: {
              parameters: {
                TargetFile: "test.ts",
                CodeContent: "export const x = 42;\n",
              },
            },
          },
        }),
        JSON.stringify({
          event: "step_update",
          step_update: {
            conversation_id: "conv-123",
            step_index: 1,
            state: "DONE",
            step_type: "tool",
            duration_seconds: 0.2,
            tool_info: { output: "File written" },
          },
        }),
        JSON.stringify({
          event: "step_update",
          step_update: {
            conversation_id: "conv-123",
            step_index: 2,
            state: "ACTIVE",
            step_type: "tool",
            tool_name: "run_command",
            tool_info: {
              parameters: {
                CommandLine: "npm test",
                Cwd: "/workspace",
              },
            },
          },
        }),
        JSON.stringify({
          event: "step_update",
          step_update: {
            conversation_id: "conv-123",
            step_index: 2,
            state: "DONE",
            step_type: "tool",
            duration_seconds: 1.5,
            tool_info: { output: "PASS test.ts\n" },
          },
        }),
        JSON.stringify({
          event: "step_update",
          step_update: {
            conversation_id: "conv-123",
            step_index: 3,
            state: "ACTIVE",
            step_type: "agent_response",
            text_delta: "All tests passed!",
          },
        }),
        JSON.stringify({
          event: "result",
          result: {
            conversation_id: "conv-123",
            status: "SUCCESS",
            num_turns: 1,
            response: "All tests passed!",
          },
        }),
      ];

      const { command, cwd, cleanup } = await fakeStreamingAgy(streamLines);
      const adapter = new AntigravityAdapter({ command });
      try {
        const opened = await adapter.open({ kind: "create", cwd });
        expect(opened.ok).toBe(true);
        if (!opened.ok) return;

        const session = opened.value;
        const iterator = session.outputs[Symbol.asyncIterator]();
        const turnId = hostTurnIdSchema.parse("turn-1");

        const executed = await session.execute({
          type: "turn.start",
          turnId,
          input: [{ type: "text", text: "Please create test.ts and run it" }],
        });
        expect(executed.ok).toBe(true);

        // Event 1: turn.started
        const turnStarted = await nextEvent(iterator);
        expect(turnStarted).toEqual({ type: "turn.started", turnId });

        // Event 2: session.state.changed (from init)
        const stateChanged = await nextEvent(iterator);
        expect(stateChanged.type).toBe("session.state.changed");

        // Event 3: item.started for write_to_file (toolExecution)
        const fileStarted = await nextEvent(iterator);
        expect(fileStarted).toMatchObject({
          type: "item.started",
          turnId,
          item: {
            type: "toolExecution",
            toolName: "write_to_file",
          },
        });

        // Event 4: item.completed for write_to_file
        const fileCompleted = await nextEvent(iterator);
        expect(fileCompleted).toMatchObject({
          type: "item.completed",
          turnId,
          snapshot: {
            item: { type: "fileChange" },
            outcome: { status: "succeeded" },
          },
        });

        // Event 5: item.started for run_command (commandExecution)
        const cmdStarted = await nextEvent(iterator);
        expect(cmdStarted).toMatchObject({
          type: "item.started",
          turnId,
          item: {
            type: "commandExecution",
            command: "npm test",
            cwd: "/workspace",
          },
        });

        // Event 6: item.completed for run_command
        const cmdCompleted = await nextEvent(iterator);
        expect(cmdCompleted).toMatchObject({
          type: "item.completed",
          turnId,
          snapshot: {
            item: {
              type: "commandExecution",
              command: "npm test",
              output: "PASS test.ts\n",
              exitCode: 0,
              durationMs: 1500,
            },
            outcome: { status: "succeeded" },
          },
        });

        // Event 7: item.started for agent response
        const agentStarted = await nextEvent(iterator);
        expect(agentStarted).toMatchObject({
          type: "item.started",
          turnId,
          item: {
            type: "agentMessage",
            text: "All tests passed!",
          },
        });

        // Event 8: item.completed for agent response
        const agentCompleted = await nextEvent(iterator);
        expect(agentCompleted).toMatchObject({
          type: "item.completed",
          turnId,
          snapshot: {
            item: {
              type: "agentMessage",
              text: "All tests passed!",
            },
            outcome: { status: "succeeded" },
          },
        });

        // Event 9: turn.completed with succeeded
        const turnCompleted = await nextEvent(iterator);
        expect(turnCompleted).toMatchObject({
          type: "turn.completed",
          turnId,
          outcome: { status: "succeeded" },
        });

        await session.close();
      } finally {
        await adapter.close();
        await cleanup();
      }
    });

    it("emits turn.completed with failed outcome on CLI error", async () => {
      const streamLines = [
        JSON.stringify({
          event: "init",
          init: { permission_mode: "default" },
          conversation_id: "conv-err",
        }),
        JSON.stringify({
          event: "result",
          result: {
            conversation_id: "conv-err",
            status: "ERROR",
            num_turns: 1,
          },
        }),
      ];

      const { command, cwd, cleanup } = await fakeStreamingAgy(streamLines);
      const adapter = new AntigravityAdapter({ command });
      try {
        const opened = await adapter.open({ kind: "create", cwd });
        expect(opened.ok).toBe(true);
        if (!opened.ok) return;

        const session = opened.value;
        const iterator = session.outputs[Symbol.asyncIterator]();
        const turnId = hostTurnIdSchema.parse("turn-err");

        await session.execute({
          type: "turn.start",
          turnId,
          input: [{ type: "text", text: "trigger error" }],
        });

        const started = await nextEvent(iterator);
        expect(started.type).toBe("turn.started");

        const stateChanged = await nextEvent(iterator);
        expect(stateChanged.type).toBe("session.state.changed");

        const completed = await nextEvent(iterator);
        expect(completed).toMatchObject({
          type: "turn.completed",
          turnId,
          outcome: { status: "failed" },
        });

        await session.close();
      } finally {
        await adapter.close();
        await cleanup();
      }
    });

    it("emits turn.completed with cancelled outcome on session close while active", async () => {
      // Stream that does not emit result immediately (simulates long turn)
      const streamLines = [
        JSON.stringify({
          event: "init",
          init: { permission_mode: "default" },
          conversation_id: "conv-close",
        }),
        JSON.stringify({
          event: "step_update",
          step_update: {
            conversation_id: "conv-close",
            step_index: 1,
            state: "ACTIVE",
            step_type: "agent_response",
            text_delta: "Working on it...",
          },
        }),
      ];

      const { command, cwd, cleanup } = await fakeStreamingAgy(streamLines);
      const adapter = new AntigravityAdapter({ command });
      try {
        const opened = await adapter.open({ kind: "create", cwd });
        expect(opened.ok).toBe(true);
        if (!opened.ok) return;

        const session = opened.value;
        const iterator = session.outputs[Symbol.asyncIterator]();
        const turnId = hostTurnIdSchema.parse("turn-close");

        await session.execute({
          type: "turn.start",
          turnId,
          input: [{ type: "text", text: "long running" }],
        });

        expect((await nextEvent(iterator)).type).toBe("turn.started");
        expect((await nextEvent(iterator)).type).toBe("session.state.changed");
        expect((await nextEvent(iterator)).type).toBe("item.started");

        // Close session while active
        await session.close();

        const itemCompleted = await nextEvent(iterator);
        expect(itemCompleted).toMatchObject({
          type: "item.completed",
          turnId,
          snapshot: { outcome: { status: "cancelled", reason: "Session closed" } },
        });

        const turnCompleted = await nextEvent(iterator);
        expect(turnCompleted).toMatchObject({
          type: "turn.completed",
          turnId,
          outcome: { status: "cancelled", reason: "Session closed" },
        });
      } finally {
        await adapter.close();
        await cleanup();
      }
    });
  });
});
