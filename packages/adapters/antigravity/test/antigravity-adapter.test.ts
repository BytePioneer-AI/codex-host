import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  resolveAntigravityContextWindow,
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
      contextWindowTokens: 1_048_576,
    });
    expect(parseAntigravityContextUsage(metadata, "gemini-3.7-flash-high")).toEqual({
      contextUsedTokens: 19_505,
      contextWindowTokens: 1_048_576,
    });
    expect(parseAntigravityContextUsage(metadata, "claude-sonnet-4-6")).toEqual({
      contextUsedTokens: 19_505,
      contextWindowTokens: 200_000,
    });
    const chunkMetadata = {
      trajectory: {
        generatorMetadata: [
          {
            chatModel: {
              chatStartMetadata: {
                contextWindowMetadata: {
                  estimatedTokensUsed: 12_000,
                  maxContextTokens: 128_000,
                },
              },
            },
          },
        ],
      },
    };
    expect(parseAntigravityContextUsage(chunkMetadata, "gemini-2.5-flash")).toEqual({
      contextUsedTokens: 12_000,
      contextWindowTokens: 1_048_576,
    });
    expect(parseAntigravityContextUsage(chunkMetadata)).toEqual({
      contextUsedTokens: 12_000,
      contextWindowTokens: 1_048_576,
    });
    expect(parseAntigravityContextUsage(chunkMetadata, "claude-3-7-sonnet")).toEqual({
      contextUsedTokens: 12_000,
      contextWindowTokens: 200_000,
    });
    expect(parseAntigravityContextUsage({ generatorMetadata: [] })).toBeNull();
  });

  it("resolves context window sizes by model family with 1M Gemini default", () => {
    expect(resolveAntigravityContextWindow()).toBe(1_048_576);
    expect(resolveAntigravityContextWindow("gemini-3.7-flash-high")).toBe(1_048_576);
    expect(resolveAntigravityContextWindow("gemini-1.5-pro", 128_000)).toBe(1_048_576);
    expect(resolveAntigravityContextWindow("claude-sonnet-4-6")).toBe(200_000);
    expect(resolveAntigravityContextWindow("claude-3-5-sonnet", 128_000)).toBe(200_000);
    expect(resolveAntigravityContextWindow("gpt-oss-120b", 128_000)).toBe(128_000);
    expect(resolveAntigravityContextWindow("gpt-oss-120b")).toBe(1_048_576);
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

        // Event 3: item.started for write_to_file. Without a reachable agy
        // Language Server the applied patch is unknowable, so the step stays a
        // Tool Execution instead of becoming an empty File Change card.
        const fileStarted = await nextEvent(iterator);
        expect(fileStarted).toMatchObject({
          type: "item.started",
          turnId,
          item: { type: "toolExecution", toolName: "write_to_file" },
        });

        // Event 4: item.completed for write_to_file
        const fileCompleted = await nextEvent(iterator);
        expect(fileCompleted).toMatchObject({
          type: "item.completed",
          turnId,
          snapshot: {
            item: { type: "toolExecution", toolName: "write_to_file" },
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

    it("correctly handles cumulative text snapshots without duplicating text", async () => {
      const streamLines = [
        JSON.stringify({
          event: "init",
          init: { permission_mode: "default" },
          conversation_id: "conv-cumulative",
        }),
        JSON.stringify({
          event: "step_update",
          step_update: {
            conversation_id: "conv-cumulative",
            step_index: 1,
            state: "ACTIVE",
            step_type: "agent_response",
            text: "Hello",
          },
        }),
        JSON.stringify({
          event: "step_update",
          step_update: {
            conversation_id: "conv-cumulative",
            step_index: 2,
            state: "DONE",
            step_type: "agent_response",
            text: "Hello world",
          },
        }),
        JSON.stringify({
          event: "result",
          result: {
            conversation_id: "conv-cumulative",
            status: "SUCCESS",
            num_turns: 1,
            response: "Hello world!",
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
        const turnId = hostTurnIdSchema.parse("turn-cumul");

        await session.execute({
          type: "turn.start",
          turnId,
          input: [{ type: "text", text: "hi" }],
        });

        expect((await nextEvent(iterator)).type).toBe("turn.started");
        expect((await nextEvent(iterator)).type).toBe("session.state.changed");

        // Step 1: started with "Hello"
        const started = await nextEvent(iterator);
        expect(started).toMatchObject({
          type: "item.started",
          turnId,
          item: { type: "agentMessage", text: "Hello" },
        });

        // Step 2: updated with cumulative delta " world"
        const updated1 = await nextEvent(iterator);
        expect(updated1).toMatchObject({
          type: "item.updated",
          turnId,
          update: { type: "text.append", text: " world" },
        });

        // Result: updated with cumulative delta "!"
        const updated2 = await nextEvent(iterator);
        expect(updated2).toMatchObject({
          type: "item.updated",
          turnId,
          update: { type: "text.append", text: "!" },
        });

        // Completed item has final full text "Hello world!"
        const completed = await nextEvent(iterator);
        expect(completed).toMatchObject({
          type: "item.completed",
          turnId,
          snapshot: {
            item: { type: "agentMessage", text: "Hello world!" },
            outcome: { status: "succeeded" },
          },
        });

        await session.close();
      } finally {
        await adapter.close();
        await cleanup();
      }
    });

    it("passes --add-dir <cwd> and strictly binds child process cwd to thread project directory", async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-agy-inspect-"));
      const projectCwd = await mkdtemp(path.join(os.tmpdir(), "codexhost-agy-proj-"));
      const capturedArgsFile = path.join(directory, "captured_args.json");
      const cleanup = async (): Promise<void> => {
        for (const target of [directory, projectCwd]) {
          await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
        }
      };

      const streamLines = [
        JSON.stringify({
          event: "init",
          init: { permission_mode: "dangerously-skip-permissions" },
          conversation_id: "conv-inspect-cwd",
        }),
        JSON.stringify({
          event: "result",
          result: {
            conversation_id: "conv-inspect-cwd",
            status: "SUCCESS",
            num_turns: 1,
            response: "done",
          },
        }),
      ];

      const scriptContent = `
const fs = require("node:fs");
const lines = ${JSON.stringify(streamLines)};
if (process.argv.includes("models")) {
  process.stdout.write("gemini-3.7-flash-high\\tGemini 3.7 Flash High\\n");
  process.exit(0);
}
if (process.argv.some(a => a === "--print=/usage" || a.startsWith("--print=/"))) {
  process.stdout.write(JSON.stringify({
    event: "command_result",
    command: { name: "usage", data: { groups: [] } }
  }) + "\\n");
  process.stdout.write(JSON.stringify({
    event: "result",
    result: { conversation_id: "conv-usage", status: "SUCCESS", num_turns: 0 }
  }) + "\\n");
  process.exit(0);
}
fs.writeFileSync(${JSON.stringify(capturedArgsFile)}, JSON.stringify({
  argv: process.argv,
  cwd: process.cwd(),
}));
for (const line of lines) {
  process.stdout.write(line + "\\n");
}
setTimeout(() => { process.exit(0); }, 50);
`;
      const jsPath = path.join(directory, "agy.cjs");
      await writeFile(jsPath, scriptContent);
      let command: string;
      if (process.platform === "win32") {
        command = path.join(directory, "agy.cmd");
        await writeFile(command, `@node "${jsPath}" %*\r\n`);
      } else {
        command = path.join(directory, "agy");
        await writeFile(command, `#!/usr/bin/env node\n${scriptContent}`);
        await chmod(command, 0o755);
      }

      const adapter = new AntigravityAdapter({ command });
      try {
        const opened = await adapter.open({ kind: "create", cwd: projectCwd });
        expect(opened.ok).toBe(true);
        if (!opened.ok) return;

        const session = opened.value;
        const iterator = session.outputs[Symbol.asyncIterator]();
        const turnId = hostTurnIdSchema.parse("turn-inspect-add-dir");
        await session.execute({
          type: "turn.start",
          turnId,
          input: [{ type: "text", text: "inspect args" }],
        });

        expect((await nextEvent(iterator)).type).toBe("turn.started");
        expect((await nextEvent(iterator)).type).toBe("session.state.changed");

        const captured = JSON.parse(await readFile(capturedArgsFile, "utf8")) as {
          argv: string[];
          cwd: string;
        };

        const addDirIndex = captured.argv.indexOf("--add-dir");
        expect(addDirIndex).toBeGreaterThan(-1);
        expect(captured.argv[addDirIndex + 1]).toBe(projectCwd);

        const expectedResolvedCwd = path.resolve(projectCwd).toLowerCase();
        const actualResolvedCwd = path.resolve(captured.cwd).toLowerCase();
        expect(actualResolvedCwd).toBe(expectedResolvedCwd);

        await session.close();
      } finally {
        await adapter.close();
        await cleanup();
      }
    });

    it("projects file steps as Tool Executions when the applied patch cannot be read", async () => {
      const streamLines = [
        JSON.stringify({
          event: "init",
          init: { permission_mode: "dangerously-skip-permissions" },
          conversation_id: "conv-multi-diff",
        }),
        JSON.stringify({
          event: "step_update",
          step_update: {
            conversation_id: "conv-multi-diff",
            step_index: 1,
            state: "DONE",
            step_type: "tool",
            tool_name: "write_to_file",
            tool_info: {
              parameters: {
                TargetFile: "src/file1.ts",
                CodeContent: "export const a = 1;\nexport const b = 2;\n",
              },
            },
          },
        }),
        JSON.stringify({
          event: "step_update",
          step_update: {
            conversation_id: "conv-multi-diff",
            step_index: 2,
            state: "DONE",
            step_type: "tool",
            tool_name: "replace_file_content",
            tool_info: {
              parameters: {
                TargetFile: "src/file2.ts",
                TargetContent: "old line 1\nold line 2\n",
                ReplacementContent: "new line 1\nnew line 2\nnew line 3\n",
              },
            },
          },
        }),
        JSON.stringify({
          event: "result",
          result: {
            conversation_id: "conv-multi-diff",
            status: "SUCCESS",
            num_turns: 1,
            response: "Files created and modified successfully.",
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
        const turnId = hostTurnIdSchema.parse("turn-multi-diff");

        await session.execute({
          type: "turn.start",
          turnId,
          input: [{ type: "text", text: "modify multiple files" }],
        });

        expect((await nextEvent(iterator)).type).toBe("turn.started");
        expect((await nextEvent(iterator)).type).toBe("session.state.changed");

        // agy's stream never carries file content, so with no Language Server
        // to read the applied patch from there is no diff to show — and the
        // Adapter must not invent one.
        const fc1Started = await nextEvent(iterator);
        expect(fc1Started).toMatchObject({
          type: "item.started",
          turnId,
          item: { type: "toolExecution", toolName: "write_to_file" },
        });
        const fc1Completed = await nextEvent(iterator);
        expect(fc1Completed).toMatchObject({
          type: "item.completed",
          turnId,
          snapshot: {
            item: { type: "toolExecution", toolName: "write_to_file" },
            outcome: { status: "succeeded" },
          },
        });

        const fc2Started = await nextEvent(iterator);
        expect(fc2Started).toMatchObject({
          type: "item.started",
          turnId,
          item: { type: "toolExecution", toolName: "replace_file_content" },
        });
        const fc2Completed = await nextEvent(iterator);
        expect(fc2Completed).toMatchObject({
          type: "item.completed",
          turnId,
          snapshot: {
            item: { type: "toolExecution", toolName: "replace_file_content" },
            outcome: { status: "succeeded" },
          },
        });

        await session.close();
      } finally {
        await adapter.close();
        await cleanup();
      }
    });

    it("dynamically switches between Gemini (1M) and Claude (200k) models within the same session", async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-agy-model-switch-"));
      const cwd = await mkdtemp(path.join(os.tmpdir(), "codexhost-agy-model-switch-cwd-"));
      const cleanup = async (): Promise<void> => {
        for (const target of [directory, cwd]) {
          await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
        }
      };
      const runsDir = path.join(directory, "runs");
      const jsPath = path.join(directory, "agy.cjs");
      const scriptContent = `
const fs = require('fs');
const path = require('path');
if (process.argv.includes("models")) {
  process.stdout.write("gemini-3.7-flash-high\\tGemini 3.7 Flash High\\nclaude-3-7-sonnet\\tClaude 3.7 Sonnet\\n");
  process.exit(0);
}
const runsDir = ${JSON.stringify(runsDir)};
fs.mkdirSync(runsDir, { recursive: true });
const count = fs.readdirSync(runsDir).length;
fs.writeFileSync(path.join(runsDir, "run-" + count + ".txt"), "");

if (count === 0) {
  process.stdout.write(JSON.stringify({ event: "init", conversation_id: "conv-switch", init: { permission_mode: "dangerously-skip-permissions" } }) + "\\n");
  process.stdout.write(JSON.stringify({ event: "step_update", step_update: { conversation_id: "conv-switch", step_index: 1, state: "DONE", step_type: "agent_response", text_delta: "Hello from Gemini", usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 } } }) + "\\n");
  process.stdout.write(JSON.stringify({ event: "result", result: { conversation_id: "conv-switch", status: "SUCCESS", num_turns: 1, response: "Hello from Gemini", usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 } } }) + "\\n");
} else if (count === 1) {
  process.stdout.write(JSON.stringify({ event: "init", conversation_id: "conv-switch", init: { permission_mode: "dangerously-skip-permissions" } }) + "\\n");
  process.stdout.write(JSON.stringify({ event: "step_update", step_update: { conversation_id: "conv-switch", step_index: 2, state: "DONE", step_type: "agent_response", text_delta: "Hello from Claude", usage: { input_tokens: 250, output_tokens: 40, total_tokens: 290 } } }) + "\\n");
  process.stdout.write(JSON.stringify({ event: "result", result: { conversation_id: "conv-switch", status: "SUCCESS", num_turns: 2, response: "Hello from Claude", usage: { input_tokens: 250, output_tokens: 40, total_tokens: 290 } } }) + "\\n");
} else {
  process.stdout.write(JSON.stringify({ event: "init", conversation_id: "conv-switch", init: { permission_mode: "dangerously-skip-permissions" } }) + "\\n");
  process.stdout.write(JSON.stringify({ event: "step_update", step_update: { conversation_id: "conv-switch", step_index: 3, state: "DONE", step_type: "agent_response", text_delta: "Back to Gemini", usage: { input_tokens: 300, output_tokens: 50, total_tokens: 350 } } }) + "\\n");
  process.stdout.write(JSON.stringify({ event: "result", result: { conversation_id: "conv-switch", status: "SUCCESS", num_turns: 3, response: "Back to Gemini", usage: { input_tokens: 300, output_tokens: 50, total_tokens: 350 } } }) + "\\n");
}
`;
      await writeFile(jsPath, scriptContent);
      let command: string;
      if (process.platform === "win32") {
        command = path.join(directory, "agy.cmd");
        await writeFile(command, `@node "${jsPath}" %*\r\n`);
      } else {
        command = path.join(directory, "agy");
        await writeFile(command, `#!/usr/bin/env node\n${scriptContent}`);
        await chmod(command, 0o755);
      }

      const adapter = new AntigravityAdapter({ command });
      try {
        const opened = await adapter.open({
          kind: "create",
          cwd,
          model: harnessModelRefSchema.parse({ id: "gemini-3.7-flash-high" }),
        });
        expect(opened.ok).toBe(true);
        if (!opened.ok) return;
        const session = opened.value;
        const iterator = session.outputs[Symbol.asyncIterator]();

        // Turn 1: Gemini (1M window)
        const turn1Id = hostTurnIdSchema.parse("turn-switch-1");
        await session.execute({
          type: "turn.start",
          turnId: turn1Id,
          input: [{ type: "text", text: "hi gemini" }],
        });

        let turn1Usage: Record<string, unknown> | null = null;
        while (true) {
          const ev = await nextEvent(iterator);
          if (ev.type === "session.usage.changed") turn1Usage = ev.usage as Record<string, unknown>;
          if (ev.type === "turn.completed") break;
        }
        expect(turn1Usage).not.toBeNull();
        expect(turn1Usage?.contextWindowTokens).toBe(1_048_576);

        // Switch to Claude (200k window)
        const selectClaude = await session.execute({
          type: "model.select",
          model: harnessModelRefSchema.parse({ id: "claude-3-7-sonnet" }),
        });
        expect(selectClaude.ok).toBe(true);

        // Turn 2: Claude
        const turn2Id = hostTurnIdSchema.parse("turn-switch-2");
        await session.execute({
          type: "turn.start",
          turnId: turn2Id,
          input: [{ type: "text", text: "hi claude" }],
        });

        let turn2Usage: Record<string, unknown> | null = null;
        while (true) {
          const ev = await nextEvent(iterator);
          if (ev.type === "session.usage.changed") turn2Usage = ev.usage as Record<string, unknown>;
          if (ev.type === "turn.completed") break;
        }
        expect(turn2Usage).not.toBeNull();
        expect(turn2Usage?.contextWindowTokens).toBe(200_000);

        // Switch back to Gemini
        const selectGemini = await session.execute({
          type: "model.select",
          model: harnessModelRefSchema.parse({ id: "gemini-3.7-flash-high" }),
        });
        expect(selectGemini.ok).toBe(true);

        // Turn 3: Gemini
        const turn3Id = hostTurnIdSchema.parse("turn-switch-3");
        await session.execute({
          type: "turn.start",
          turnId: turn3Id,
          input: [{ type: "text", text: "back to gemini" }],
        });

        let turn3Usage: Record<string, unknown> | null = null;
        while (true) {
          const ev = await nextEvent(iterator);
          if (ev.type === "session.usage.changed") turn3Usage = ev.usage as Record<string, unknown>;
          if (ev.type === "turn.completed") break;
        }
        expect(turn3Usage).not.toBeNull();
        expect(turn3Usage?.contextWindowTokens).toBe(1_048_576);

        await session.close();
      } finally {
        await adapter.close();
        await cleanup();
      }
    });
  });
});
