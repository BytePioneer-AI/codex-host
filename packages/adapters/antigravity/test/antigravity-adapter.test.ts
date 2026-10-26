import { access, chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { HarnessOutput, HarnessSession, HostEvent } from "@codexhost/harness-adapter";
import type { NativeSessionRef } from "@codexhost/shared-contracts";
import {
  accountCreditsSnapshotSchema,
  harnessModelRefSchema,
  harnessPermissionModeIdSchema,
  harnessThinkingOptionIdSchema,
  hostTurnIdSchema,
  nativeSessionRefSchema,
} from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";

import {
  ANTIGRAVITY_WORKSPACE_FILE_INSTRUCTION,
  AntigravityAdapter,
  antigravityAvailableThinkingOptions,
  antigravityModelArguments,
  antigravityToolErrorMessage,
  fetchAntigravityQuota,
  formatAntigravityTurnPrompt,
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
  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, -1])(
    "rejects invalid Subagent observation timeout %s",
    (subagentObservationTimeoutMs) => {
      expect(() => new AntigravityAdapter({ subagentObservationTimeoutMs })).toThrow(
        new RangeError("subagentObservationTimeoutMs must be a finite positive number"),
      );
    },
  );

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])(
    "rejects invalid Turn cleanup wait %s",
    (turnCleanupWaitMs) => {
      expect(() => new AntigravityAdapter({ turnCleanupWaitMs })).toThrow(
        new RangeError("turnCleanupWaitMs must be a finite non-negative number"),
      );
    },
  );

  it("reads account quota without a Thread and hides it after native authentication stops returning data", async () => {
    const fixture = await fakeAgy([
      JSON.stringify({ event: "command_result", command: USAGE_COMMAND }),
    ]);
    const adapter = new AntigravityAdapter({ command: fixture.command, environment: process.env });
    try {
      expect(await adapter.inspectAccount()).toMatchObject({
        credits: { label: "Gemini Models · 5-hour window", usedPercent: 0 },
      });
      expect(adapter.credits()).not.toBeNull();
      await writeFile(
        fixture.command,
        process.platform === "win32" ? "@echo off\r\nexit /b 0\r\n" : "#!/bin/sh\nexit 0\n",
      );
      expect(await adapter.inspectAccount()).toBeNull();
    } finally {
      await adapter.close();
      await fixture.cleanup();
    }
  });
  it.each(["configured", "desktop-approvals"])(
    "rejects obsolete %s on create, resume, rollback and live selection",
    async (mode) => {
      const { command, cwd, cleanup } = await fakeAgy(FAKE_MODELS);
      const adapter = new AntigravityAdapter({ command });
      const permissionModeId = harnessPermissionModeIdSchema.parse(mode);
      const nativeRef = nativeSessionRefSchema.parse({
        harnessId: "antigravity",
        nativeSessionId: "old-session",
        formatVersion: 1,
      });
      const rejected = {
        ok: false,
        error: {
          code: "invalidRequest",
          message: expect.stringContaining("Explicitly select Skip permissions"),
        },
      };
      try {
        expect(await adapter.open({ kind: "create", cwd, permissionModeId })).toMatchObject(
          rejected,
        );
        expect(
          await adapter.open({ kind: "resume", cwd, nativeRef, permissionModeId }),
        ).toMatchObject(rejected);
        expect(
          await adapter.open({
            kind: "rollbackLastTurn",
            cwd,
            sourceRef: nativeRef,
            permissionModeId,
          }),
        ).toMatchObject(rejected);
        const opened = await adapter.open({ kind: "create", cwd });
        if (!opened.ok) throw new Error(opened.error.message);
        expect(opened.value.initialState?.effectivePermissionModeId).toBe(
          "dangerously-skip-permissions",
        );
        expect(
          await opened.value.execute({ type: "permissionMode.select", permissionModeId }),
        ).toMatchObject(rejected);
        expect(
          await opened.value.execute({
            type: "permissionMode.select",
            permissionModeId: harnessPermissionModeIdSchema.parse("dangerously-skip-permissions"),
          }),
        ).toMatchObject({ ok: true });
      } finally {
        await adapter.close();
        await cleanup();
      }
    },
  );

  it("advertises only native Skip permissions, marked dangerous and default", async () => {
    const { command, cwd, cleanup } = await fakeAgy(FAKE_MODELS);
    const adapter = new AntigravityAdapter({ command });
    try {
      const inspection = await adapter.inspect({ cwd });
      if (inspection.status !== "ready") throw new Error("Fixture CLI is not ready");
      expect(inspection.permissionModes).toMatchObject({
        defaultModeId: "dangerously-skip-permissions",
        modes: [{ id: "dangerously-skip-permissions", dangerous: true }],
      });
      expect(inspection.permissionModes?.modes).toHaveLength(1);
    } finally {
      await adapter.close();
      await cleanup();
    }
  });

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
    // The 5-hour window leads (it is the most actionable and resets soonest).
    // Labels come from the window, not the CLI's "… Remaining" naming, because
    // the values are consumed percentages.
    expect(snapshot).toEqual({
      label: "Gemini Models · 5-hour window",
      scope: { id: "Gemini Models", label: "Gemini Models" },
      usedPercent: 0,
      periodType: "five_hour",
      resetsAt: "2026-08-31T19:38:13Z",
      fetchedAt: FETCHED_AT,
      productUsage: [
        {
          product: "Gemini Models · Weekly window",
          periodType: "weekly",
          scope: { id: "Gemini Models", label: "Gemini Models" },
          usagePercent: 2.65,
          resetsAt: "2026-09-01T03:17:57Z",
        },
        {
          product: "Claude and GPT models · Weekly window",
          periodType: "weekly",
          scope: { id: "Claude and GPT models", label: "Claude and GPT models" },
          usagePercent: 0,
          resetsAt: "2026-09-07T14:38:13Z",
        },
      ],
    });
  });

  it("prefers the 5-hour window over weekly even when weekly usage is higher", () => {
    const commandWithHigherWeekly = {
      name: "usage",
      data: {
        groups: [
          {
            name: "Gemini Models",
            buckets: [
              {
                id: "gemini-weekly",
                window: "weekly",
                remaining_fraction: 0.46,
                reset_time: "2026-09-15T00:56:00Z",
              },
              {
                id: "gemini-5h",
                window: "5h",
                remaining_fraction: 0.799,
                reset_time: "2026-09-11T08:47:00Z",
              },
            ],
          },
        ],
      },
    };
    const snapshot = parseAntigravityUsageCommand(commandWithHigherWeekly, FETCHED_AT);
    expect(snapshot).toMatchObject({
      label: "Gemini Models · 5-hour window",
      periodType: "five_hour",
      usedPercent: 20.1,
    });
    expect(snapshot?.productUsage).toEqual([
      {
        product: "Gemini Models · Weekly window",
        periodType: "weekly",
        scope: { id: "Gemini Models", label: "Gemini Models" },
        usagePercent: 54,
        resetsAt: "2026-09-15T00:56:00Z",
      },
    ]);
  });

  it("falls back to the most consumed window when no 5-hour window is present", () => {
    const commandWithout5h = {
      name: "usage",
      data: {
        groups: [
          {
            name: "Gemini Models",
            buckets: [
              {
                id: "gemini-weekly",
                window: "weekly",
                remaining_fraction: 0.46,
                reset_time: "2026-09-15T00:56:00Z",
              },
            ],
          },
        ],
      },
    };
    const snapshot = parseAntigravityUsageCommand(commandWithout5h, FETCHED_AT);
    expect(snapshot).toMatchObject({
      label: "Gemini Models · Weekly window",
      periodType: "weekly",
      usedPercent: 54,
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
    expect(snapshot).toMatchObject({ usedPercent: 0, periodType: "five_hour" });
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
    expect(error.message).toContain("Check Antigravity CLI diagnostics and native Hooks");
    expect(error.retryable).toBe(false);
  });

  describe("Session Lifecycle & Tool Streaming", () => {
    async function fakeStreamingAgy(
      streamLines: readonly string[],
      keepAlive = false,
    ): Promise<{
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
if (${keepAlive}) {
  process.stdin.resume();
  process.stdin.on("end", () => process.exit(0));
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

    it.each([
      ["Synthetic native failure detail", true],
      ["UNAVAILABLE (code 503): upstream temporarily unavailable", true],
      ["FAILED_PRECONDITION (code 400): User location is not supported for the API use.", false],
      ["Individual quota reached. Resets in 4h52m37s.", false],
    ])("preserves native error %s with retryable=%s", async (nativeError, retryable) => {
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
            error: nativeError,
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
          outcome: {
            status: "failed",
            error: {
              code: "nativeFailure",
              message: `Antigravity Turn ended with status ERROR: ${nativeError}`,
              retryable,
            },
          },
        });
        expect(JSON.stringify(completed)).toContain(nativeError);

        await session.close();
      } finally {
        await adapter.close();
        await cleanup();
      }
    });

    it.each([
      ["create", "ERROR"],
      ["create", "SUCCESS"],
      ["resume", "ERROR"],
      ["resume", "SUCCESS"],
    ] as const)(
      "rejects another Conversation's result during %s (%s) before projecting it",
      async (kind, status) => {
        const conversationId = "conv-current";
        const streamLines = [
          ...(kind === "create"
            ? [JSON.stringify({ event: "init", conversation_id: conversationId })]
            : []),
          JSON.stringify({
            event: "result",
            result: {
              conversation_id: "conv-other",
              status,
              error: "User location is not supported for the API use.",
              response: "Another Conversation's response",
              usage: { input_tokens: 100 },
              num_turns: 7,
            },
          }),
        ];
        const { command, cwd, cleanup } = await fakeStreamingAgy(streamLines);
        const adapter = new AntigravityAdapter({
          command,
          environment: { ...process.env, CODEXHOST_DATA_DIR: cwd },
        });
        try {
          const opened = await adapter.open(
            kind === "create"
              ? { kind, cwd }
              : {
                  kind,
                  cwd,
                  nativeRef: nativeSessionRefSchema.parse({
                    harnessId: "antigravity",
                    nativeSessionId: conversationId,
                    formatVersion: 1,
                  }),
                },
          );
          if (!opened.ok) throw new Error(opened.error.message);
          const session = opened.value;
          const iterator = session.outputs[Symbol.asyncIterator]();
          await session.execute({
            type: "turn.start",
            turnId: hostTurnIdSchema.parse("turn-result-isolation"),
            input: [{ type: "text", text: "Continue this Conversation" }],
          });
          const events: HostEvent[] = [];
          let event: HostEvent;
          do {
            event = await nextEvent(iterator);
            events.push(event);
          } while (event.type !== "turn.completed");
          expect(event).toMatchObject({
            outcome: {
              status: "failed",
              error: { code: "protocolError", retryable: false },
            },
          });
          expect(event).not.toHaveProperty("nativeTurnRef");
          expect(
            events.some(({ type }) => type === "item.started" || type === "session.usage.changed"),
          ).toBe(false);
          expect(JSON.stringify(events)).not.toContain("User location is not supported");
          const snapshot = await session.readSnapshot();
          if (!snapshot.ok) throw new Error(snapshot.error.message);
          expect(snapshot.value.turns).toEqual([]);
          expect(snapshot.value.state?.nativeRef?.nativeSessionId).toBe(conversationId);
        } finally {
          await adapter.close();
          await cleanup();
        }
      },
    );

    it.each(["conv-success", ""])(
      "does not turn a successful result for %s into an error based on its text",
      async (resultConversationId) => {
        const response =
          "The previous request reported: User location is not supported for the API use.";
        const { command, cwd, cleanup } = await fakeStreamingAgy([
          JSON.stringify({ event: "init", conversation_id: "conv-success" }),
          JSON.stringify({
            event: "result",
            result: {
              conversation_id: resultConversationId,
              status: "SUCCESS",
              response,
              num_turns: 1,
            },
          }),
        ]);
        const adapter = new AntigravityAdapter({
          command,
          environment: { ...process.env, CODEXHOST_DATA_DIR: cwd },
        });
        try {
          const opened = await adapter.open({ kind: "create", cwd });
          if (!opened.ok) throw new Error(opened.error.message);
          const iterator = opened.value.outputs[Symbol.asyncIterator]();
          await opened.value.execute({
            type: "turn.start",
            turnId: hostTurnIdSchema.parse("turn-success-text"),
            input: [{ type: "text", text: "Summarize the previous error" }],
          });
          let event: HostEvent;
          do {
            event = await nextEvent(iterator);
          } while (event.type !== "turn.completed");
          expect(event.outcome.status).toBe("succeeded");
          expect(event.nativeTurnRef?.nativeSessionId).toBe("conv-success");
          const snapshot = await opened.value.readSnapshot();
          if (!snapshot.ok) throw new Error(snapshot.error.message);
          expect(snapshot.value.turns[0]?.items[0]?.item).toMatchObject({
            type: "agentMessage",
            text: response,
          });
        } finally {
          await adapter.close();
          await cleanup();
        }
      },
    );

    it("releases a completed Turn when its Subagent cannot be observed", async () => {
      const childId = "30dce1a0-bc56-4c5d-a50d-264f235f09a9";
      const conversationId = "conv-unobservable-child";
      const streamLines = [
        JSON.stringify({ event: "init", conversation_id: conversationId }),
        JSON.stringify({
          event: "step_update",
          step_update: {
            conversation_id: conversationId,
            step_index: 1,
            step_type: "subagent",
            state: "DONE",
            subagent_info: {
              subagents: [{ conversation_id: childId, type_name: "browser" }],
            },
          },
        }),
        JSON.stringify({
          event: "result",
          result: { conversation_id: conversationId, status: "SUCCESS", num_turns: 1 },
        }),
      ];
      const { command, cwd, cleanup } = await fakeStreamingAgy(streamLines, true);
      const adapter = new AntigravityAdapter({ command, subagentObservationTimeoutMs: 25 });
      try {
        const opened = await adapter.open({ kind: "create", cwd });
        expect(opened.ok).toBe(true);
        if (!opened.ok) return;
        const session = opened.value;
        const iterator = session.outputs[Symbol.asyncIterator]();
        const turnId = hostTurnIdSchema.parse("turn-unobservable-child");
        await session.execute({
          type: "turn.start",
          turnId,
          input: [{ type: "text", text: "Delegate to browser" }],
        });
        let event: HostEvent;
        do {
          event = await nextEvent(iterator);
        } while (event.type !== "turn.completed");
        expect(event.outcome.status).toBe("succeeded");

        const deadline = Date.now() + 1_000;
        while (
          (session as typeof session & { isActive: boolean }).isActive &&
          Date.now() < deadline
        ) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect((session as typeof session & { isActive: boolean }).isActive).toBe(false);
        const snapshot = await session.readSnapshot();
        expect(snapshot.ok).toBe(true);
        if (snapshot.ok) {
          const delegation = snapshot.value.turns[0]?.items.find(
            ({ item }) => item.type === "subagentDelegation",
          )?.item;
          expect(delegation).toMatchObject({
            type: "subagentDelegation",
            subagents: [{ nativeSubagentId: childId, status: "interrupted" }],
          });
        }
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

        // macOS exposes its temporary directory through `/var`, while a child
        // process can report the same directory through the `/private/var`
        // symlink target. Compare canonical filesystem paths rather than the
        // two valid spellings.
        const expectedResolvedCwd = (await realpath(projectCwd)).toLowerCase();
        const actualResolvedCwd = (await realpath(captured.cwd)).toLowerCase();
        expect(actualResolvedCwd).toBe(expectedResolvedCwd);

        await session.close();
      } finally {
        await adapter.close();
        await cleanup();
      }
    });

    it("keeps one Question Hook directory per Thread across Turns and a resumed Session", async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-agy-hooks-"));
      const cwd = await mkdtemp(path.join(os.tmpdir(), "codexhost-agy-hooks-cwd-"));
      const dataDir = await mkdtemp(path.join(os.tmpdir(), "codexhost-agy-hooks-data-"));
      const runs = path.join(directory, "runs.jsonl");
      const cleanup = async (): Promise<void> => {
        for (const target of [directory, cwd, dataDir]) {
          await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
        }
      };
      // Records each Turn's --add-dir values and prompt, then answers like agy resuming one
      // Conversation.
      const scriptContent = `
const fs = require("node:fs");
if (process.argv.includes("models")) {
  process.stdout.write("gemini-3.7-flash-high\\tGemini 3.7 Flash High\\n");
  process.exit(0);
}
// The quota probe runs as --print=/usage; Turns carry --print-timeout instead.
if (process.argv.some((value) => value.startsWith("--print="))) process.exit(0);
const addDirs = process.argv.filter((_, index, all) => all[index - 1] === "--add-dir");
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    const prompt = JSON.parse(line).message.content;
    fs.appendFileSync(${JSON.stringify(runs)}, JSON.stringify({ addDirs, prompt }) + "\\n");
    const turn = fs.readFileSync(${JSON.stringify(runs)}, "utf8").trim().split("\\n").length;
    for (const event of [
      { event: "init", conversation_id: "conv-hooks", init: { permission_mode: "dangerously-skip-permissions" } },
      { event: "result", result: { conversation_id: "conv-hooks", status: "SUCCESS", num_turns: turn, response: "ok" } },
    ]) {
      process.stdout.write(JSON.stringify(event) + "\\n");
    }
  }
});
process.stdin.on("end", () => process.exit(0));
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

      const runTurns = async (session: HarnessSession, turnIds: readonly string[]) => {
        const iterator = session.outputs[Symbol.asyncIterator]();
        for (const turnId of turnIds) {
          const started = await session.execute({
            type: "turn.start",
            turnId: hostTurnIdSchema.parse(turnId),
            input: [{ type: "text", text: "hello" }],
          });
          expect(started.ok).toBe(true);
          while ((await nextEvent(iterator)).type !== "turn.completed") {
            // This Turn's remaining events are not under test.
          }
        }
      };
      // The Host names the Thread when it opens or resumes the Session.
      const threadEnvironment = { CODEXHOST_THREAD_ID: "thread-hooks" };
      const hookDirectory = path.join(dataDir, "antigravity-history", "hooks", "thread-hooks");
      const adapter = new AntigravityAdapter({
        command,
        environment: { ...process.env, CODEXHOST_DATA_DIR: dataDir },
      });
      try {
        const created = await adapter.open({ kind: "create", cwd, environment: threadEnvironment });
        if (!created.ok) throw new Error(created.error.message);
        await runTurns(created.value, ["turn-hooks-1", "turn-hooks-2"]);
        await created.value.close();
        await expect(access(path.join(hookDirectory, ".agents", "hooks.json"))).resolves.toBe(
          undefined,
        );

        const resumed = await adapter.open({
          kind: "resume",
          cwd,
          environment: threadEnvironment,
          nativeRef: nativeSessionRefSchema.parse({
            harnessId: "antigravity",
            nativeSessionId: "conv-hooks",
            formatVersion: 1,
          }),
        });
        if (!resumed.ok) throw new Error(resumed.error.message);
        await runTurns(resumed.value, ["turn-hooks-3"]);
        await resumed.value.close();

        const recorded = (await readFile(runs, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { addDirs: string[]; prompt: string });
        expect(recorded.map(({ addDirs }) => addDirs)).toEqual([
          [cwd, hookDirectory],
          [cwd, hookDirectory],
          [cwd, hookDirectory],
        ]);
        for (const { prompt } of recorded) {
          expect(prompt).toContain(`The project working directory is ${JSON.stringify(cwd)}.`);
          expect(prompt.endsWith("hello")).toBe(true);
        }
        await expect(access(path.join(hookDirectory, "question-hook.cjs"))).resolves.toBe(
          undefined,
        );
      } finally {
        await adapter.close();
        await cleanup();
      }
    });

    it.each([
      // A Thread's kept Hook directory waits for the previous cleanup, which gives up on the
      // held output after the bound.
      { scenario: "for a Thread", threadId: "thread-linger", turnCleanupWaitMs: 200 },
      // A private per-Turn directory never waits, however long that cleanup may take.
      { scenario: "without a Thread ID", threadId: undefined, turnCleanupWaitMs: 60_000 },
    ])(
      "starts the next Turn $scenario when the previous Turn's agy keeps its output open",
      async ({ threadId, turnCleanupWaitMs }) => {
        const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-agy-linger-"));
        const cwd = await mkdtemp(path.join(os.tmpdir(), "codexhost-agy-linger-cwd-"));
        const dataDir = await mkdtemp(path.join(os.tmpdir(), "codexhost-agy-linger-data-"));
        const runs = path.join(directory, "runs.txt");
        const holderPidFile = path.join(directory, "holder.pid");
        const cleanup = async (): Promise<void> => {
          for (const target of [directory, cwd, dataDir]) {
            await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
          }
        };
        // The first Turn leaves a child holding its output pipes, as a lingering native helper
        // would, so that Turn's process does not report closing until the child is stopped.
        const scriptContent = `
const fs = require("node:fs");
const { spawn } = require("node:child_process");
if (process.argv.includes("models")) {
  process.stdout.write("gemini-3.7-flash-high\\tGemini 3.7 Flash High\\n");
  process.exit(0);
}
if (process.argv.some((value) => value.startsWith("--print="))) process.exit(0);
let buffer = "";
process.stdin.resume();
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\\n")) >= 0) {
    buffer = buffer.slice(newline + 1);
    fs.appendFileSync(${JSON.stringify(runs)}, "run\\n");
    const turn = fs.readFileSync(${JSON.stringify(runs)}, "utf8").trim().split("\\n").length;
    if (turn === 1) {
      // Detached so it outlives this process on Windows too, where a child otherwise ends with it.
      const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
        detached: true,
        stdio: ["ignore", "inherit", "inherit"],
        windowsHide: true,
      });
      fs.writeFileSync(${JSON.stringify(holderPidFile)}, String(holder.pid));
    }
    for (const event of [
      { event: "init", conversation_id: "conv-linger", init: { permission_mode: "dangerously-skip-permissions" } },
      { event: "result", result: { conversation_id: "conv-linger", status: "SUCCESS", num_turns: turn, response: "ok" } },
    ]) {
      process.stdout.write(JSON.stringify(event) + "\\n");
    }
  }
});
process.stdin.on("end", () => process.exit(0));
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

        // The test process may itself run inside a Host Thread.
        const environment = Object.fromEntries(
          Object.entries(process.env).filter(
            ([name]) => name !== "CODEXHOST_THREAD_ID" && name !== "CODEXHOST_DELEGATION_THREAD_ID",
          ),
        );
        const adapter = new AntigravityAdapter({
          command,
          environment: { ...environment, CODEXHOST_DATA_DIR: dataDir },
          turnCleanupWaitMs,
        });
        let holderPid: number | undefined;
        try {
          const opened = await adapter.open({
            kind: "create",
            cwd,
            environment: threadId ? { CODEXHOST_THREAD_ID: threadId } : {},
          });
          if (!opened.ok) throw new Error(opened.error.message);
          const session = opened.value;
          const iterator = session.outputs[Symbol.asyncIterator]();
          for (const turnId of ["turn-linger-1", "turn-linger-2"]) {
            const started = await session.execute({
              type: "turn.start",
              turnId: hostTurnIdSchema.parse(turnId),
              input: [{ type: "text", text: "hello" }],
            });
            expect(started.ok).toBe(true);
            while ((await nextEvent(iterator)).type !== "turn.completed") {
              // This Turn's remaining events are not under test.
            }
            holderPid ??= Number(await readFile(holderPidFile, "utf8"));
          }
          const holder = holderPid;
          if (holder === undefined) throw new Error("The first Turn did not start its child");
          // The second Turn ran while the first Turn's output was still held open.
          expect(() => process.kill(holder, 0)).not.toThrow();
          if (threadId) {
            // Every queued cleanup and close() finish while that output is still held open.
            await session.close();
            expect(() => process.kill(holder, 0)).not.toThrow();
          }
        } finally {
          if (holderPid !== undefined) {
            try {
              process.kill(holderPid);
            } catch {
              // Already stopped.
            }
          }
          await adapter.close();
          await cleanup();
        }
      },
      20_000,
    );

    it("reuses one native driver across successful Turns and releases it on model select", async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-agy-reuse-"));
      const cwd = await mkdtemp(path.join(os.tmpdir(), "codexhost-agy-reuse-cwd-"));
      const pids = path.join(directory, "pids.jsonl");
      const cleanup = async (): Promise<void> => {
        for (const target of [directory, cwd]) {
          await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
        }
      };
      // One process answers every Turn it is given, and records its own PID per Turn.
      const scriptContent = `
const fs = require("node:fs");
if (process.argv.includes("models")) {
  process.stdout.write("gemini-3.7-flash-high\\tGemini 3.7 Flash High\\ngemini-3.1-pro-high\\tGemini 3.1 Pro High\\n");
  process.exit(0);
}
if (process.argv.some((value) => value.startsWith("--print="))) process.exit(0);
// The Conversation keeps counting across processes, as agy reports num_turns for the
// Conversation rather than for the process.
let turn = fs.existsSync(${JSON.stringify(pids)})
  ? fs.readFileSync(${JSON.stringify(pids)}, "utf8").trim().split("\\n").length
  : 0;
let buffer = "";
function answer() {
  turn += 1;
  fs.appendFileSync(${JSON.stringify(pids)}, JSON.stringify({ pid: process.pid, turn }) + "\\n");
  for (const event of [
    { event: "init", conversation_id: "conv-reuse", init: { permission_mode: "dangerously-skip-permissions" } },
    { event: "result", result: { conversation_id: "conv-reuse", status: "SUCCESS", num_turns: turn, response: "reply " + turn } },
  ]) {
    process.stdout.write(JSON.stringify(event) + "\\n");
  }
}
process.stdin.resume();
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\\n")) >= 0) {
    buffer = buffer.slice(newline + 1);
    answer();
  }
});
process.stdin.on("end", () => process.exit(0));
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
        const opened = await adapter.open({ kind: "create", cwd });
        if (!opened.ok) throw new Error(opened.error.message);
        const session = opened.value;
        const iterator = session.outputs[Symbol.asyncIterator]();
        const runTurn = async (turnId: string): Promise<void> => {
          const started = await session.execute({
            type: "turn.start",
            turnId: hostTurnIdSchema.parse(turnId),
            input: [{ type: "text", text: turnId }],
          });
          expect(started.ok).toBe(true);
          while ((await nextEvent(iterator)).type !== "turn.completed") {
            // Remaining events are not under test.
          }
        };

        await runTurn("turn-reuse-1");
        await runTurn("turn-reuse-2");
        await runTurn("turn-reuse-3");
        const observed = (await readFile(pids, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { pid: number; turn: number });
        expect(observed).toHaveLength(3);
        expect(new Set(observed.map(({ pid }) => pid)).size).toBe(1);

        // A different model needs a different invocation, so the next Turn starts a new driver.
        await session.execute({
          type: "model.select",
          model: harnessModelRefSchema.parse({ id: "gemini-3.1-pro-high" }),
        });
        await runTurn("turn-reuse-4");
        const afterSelect = (await readFile(pids, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { pid: number; turn: number });
        expect(afterSelect).toHaveLength(4);
        expect(new Set(afterSelect.map(({ pid }) => pid)).size).toBe(2);

        const snapshot = await session.readSnapshot();
        expect(snapshot.ok).toBe(true);
        if (snapshot.ok) expect(snapshot.value.turns).toHaveLength(4);
        await session.close();
      } finally {
        await adapter.close();
        await cleanup();
      }
    });

    it("refuses a second turn.start that starts while the first is still preparing", async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-agy-race-"));
      const cwd = await mkdtemp(path.join(os.tmpdir(), "codexhost-agy-race-cwd-"));
      const cleanups = async (): Promise<void> => {
        for (const target of [directory, cwd]) {
          await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
        }
      };
      const scriptContent = `
if (process.argv.includes("models")) {
  process.stdout.write("gemini-3.7-flash-high\\tGemini 3.7 Flash High\\n");
  process.exit(0);
}
if (process.argv.some((value) => value.startsWith("--print="))) process.exit(0);
let buffer = "";
process.stdin.resume();
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\\n")) >= 0) {
    buffer = buffer.slice(newline + 1);
    process.stdout.write(JSON.stringify({ event: "init", conversation_id: "conv-race", init: { permission_mode: "dangerously-skip-permissions" } }) + "\\n");
    process.stdout.write(JSON.stringify({ event: "result", result: { conversation_id: "conv-race", status: "SUCCESS", num_turns: 1, response: "ok" } }) + "\\n");
  }
});
process.stdin.on("end", () => process.exit(0));
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
        const opened = await adapter.open({ kind: "create", cwd });
        if (!opened.ok) throw new Error(opened.error.message);
        const session = opened.value;
        // Both starts are issued before either can await anything.
        const [first, second] = await Promise.all([
          session.execute({
            type: "turn.start",
            turnId: hostTurnIdSchema.parse("turn-race-1"),
            input: [{ type: "text", text: "first" }],
          }),
          session.execute({
            type: "turn.start",
            turnId: hostTurnIdSchema.parse("turn-race-2"),
            input: [{ type: "text", text: "second" }],
          }),
        ]);
        expect(first.ok).toBe(true);
        expect(second).toMatchObject({ ok: false, error: { code: "sessionBusy" } });
        await session.close();
      } finally {
        await adapter.close();
        await cleanups();
      }
    });

    it("releases an idle driver that exits between turns", async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-agy-idle-"));
      const cwd = await mkdtemp(path.join(os.tmpdir(), "codexhost-agy-idle-cwd-"));
      const cleanup = async (): Promise<void> => {
        for (const target of [directory, cwd]) {
          await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
        }
      };
      const scriptContent = `
const fs = require("node:fs");
if (process.argv.includes("models")) {
  process.stdout.write("gemini-3.7-flash-high\\tGemini 3.7 Flash High\\n");
  process.exit(0);
}
if (process.argv.some((value) => value.startsWith("--print="))) process.exit(0);
// The log file is the driver's; its removal by the parent proves the release ran.
for (const arg of process.argv) {
  if (arg.endsWith(".log")) fs.writeFileSync(arg, "started\\n");
}
let served = false;
let buffer = "";
process.stdin.resume();
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\\n")) >= 0) {
    buffer = buffer.slice(newline + 1);
    served = true;
    process.stdout.write(JSON.stringify({ event: "init", conversation_id: "conv-idle", init: { permission_mode: "dangerously-skip-permissions" } }) + "\\n");
    process.stdout.write(JSON.stringify({ event: "result", result: { conversation_id: "conv-idle", status: "SUCCESS", num_turns: 1, response: "ok" } }) + "\\n");
    // Exit on its own once the Turn is answered, like a native driver that idles out.
    setTimeout(() => process.exit(0), 50);
  }
});
process.stdin.on("end", () => process.exit(served ? 0 : 1));
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
        const opened = await adapter.open({ kind: "create", cwd });
        if (!opened.ok) throw new Error(opened.error.message);
        const session = opened.value;
        const iterator = session.outputs[Symbol.asyncIterator]();
        await session.execute({
          type: "turn.start",
          turnId: hostTurnIdSchema.parse("turn-idle-1"),
          input: [{ type: "text", text: "one" }],
        });
        while ((await nextEvent(iterator)).type !== "turn.completed") {
          // Remaining events are not under test.
        }
        // The driver exits on its own shortly after answering; the next Turn must start a
        // fresh one rather than write into the dead process.
        await new Promise((resolve) => setTimeout(resolve, 400));
        const second = await session.execute({
          type: "turn.start",
          turnId: hostTurnIdSchema.parse("turn-idle-2"),
          input: [{ type: "text", text: "two" }],
        });
        expect(second.ok).toBe(true);
        while ((await nextEvent(iterator)).type !== "turn.completed") {
          // The replacement driver answers the second Turn.
        }
        await session.close();
      } finally {
        await adapter.close();
        await cleanup();
      }
    });

    it("refuses to copy the database while an idle driver has not confirmed exit", async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-agy-exit-"));
      const cwd = await mkdtemp(path.join(os.tmpdir(), "codexhost-agy-exit-cwd-"));
      // Best effort: this fixture deliberately leaves a driver that had to be SIGKILLed, and
      // Windows can keep its working directory locked a little longer than the process. The
      // assertions above already ran; failing the test on temp-directory cleanup would only
      // report the OS timing, and the runner's temp directory is disposable.
      const cleanup = async (): Promise<void> => {
        for (const target of [directory, cwd]) {
          await rm(target, {
            recursive: true,
            force: true,
            maxRetries: 20,
            retryDelay: 250,
          }).catch(() => undefined);
        }
      };
      // The driver ignores stdin ending and SIGTERM, so its exit cannot be confirmed within
      // the cleanup bound. It does exit on its own after a few seconds, which bounds the
      // test and lets the temp cwd be removed; the pid is recorded so cleanup can wait.
      const pidFile = path.join(directory, "driver.pid");
      const scriptContent = `
const fs = require("node:fs");
if (process.argv.includes("models")) {
  process.stdout.write("gemini-3.7-flash-high\\tGemini 3.7 Flash High\\n");
  process.exit(0);
}
if (process.argv.some((value) => value.startsWith("--print="))) process.exit(0);
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
process.on("SIGTERM", () => undefined);
// Outlives both bounded release waits, then ends so the test can clean up.
setTimeout(() => process.exit(0), 6000);
let buffer = "";
process.stdin.resume();
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\\n")) >= 0) {
    buffer = buffer.slice(newline + 1);
    process.stdout.write(JSON.stringify({ event: "init", conversation_id: "conv-exit", init: { permission_mode: "dangerously-skip-permissions" } }) + "\\n");
    process.stdout.write(JSON.stringify({ event: "result", result: { conversation_id: "conv-exit", status: "SUCCESS", num_turns: 1, response: "ok" } }) + "\\n");
  }
});
process.stdin.on("end", () => undefined);
setInterval(() => undefined, 1000);
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

      const adapter = new AntigravityAdapter({ command, turnCleanupWaitMs: 0 });
      try {
        const opened = await adapter.open({ kind: "create", cwd });
        if (!opened.ok) throw new Error(opened.error.message);
        const session = opened.value;
        const iterator = session.outputs[Symbol.asyncIterator]();
        await session.execute({
          type: "turn.start",
          turnId: hostTurnIdSchema.parse("turn-exit-1"),
          input: [{ type: "text", text: "one" }],
        });
        while ((await nextEvent(iterator)).type !== "turn.completed") {
          // Remaining events are not under test.
        }

        // The driver is retained and refuses to exit, so fork must not copy its database.
        const nativeRef = (session as unknown as { nativeRef?: NativeSessionRef }).nativeRef;
        if (!nativeRef) throw new Error("The Turn did not bind a native session");
        // A driver whose exit cannot be confirmed must keep reporting that, not report
        // success on the second ask while the process is still writing the database.
        const session2 = session as unknown as { releaseIdleDriver(): Promise<boolean> };
        expect(await session2.releaseIdleDriver()).toBe(false);
        expect(await session2.releaseIdleDriver()).toBe(false);

        // Two consecutive false results are the invariant under test. The fork below may run
        // after the escalation finally kills the driver, so its failure code is not asserted.
        const fork = await adapter.open({
          kind: "fork",
          cwd,
          sourceRef: nativeRef,
          checkpoint: nativeRef as never,
        });
        expect(fork.ok).toBe(false);
      } finally {
        await adapter.close();
        // The escalation SIGKILLs the driver; give it a moment to disappear before removing
        // its cwd, which Windows keeps locked while the process exists. Bounded and best
        // effort: the assertions above already ran, and the runner's temp dir is disposable.
        const pid = Number(await readFile(pidFile, "utf8").catch(() => "0"));
        if (Number.isInteger(pid) && pid > 0) {
          for (let attempt = 0; attempt < 80; attempt += 1) {
            try {
              process.kill(pid, 0);
            } catch {
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        }
        await cleanup();
      }
    }, 20_000);

    it("drops only the replayed steps of the previous turn, whatever their numbering", async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-agy-replay-"));
      const cwd = await mkdtemp(path.join(os.tmpdir(), "codexhost-agy-replay-cwd-"));
      const cleanup = async (): Promise<void> => {
        for (const target of [directory, cwd]) {
          await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
        }
      };
      // Turn 1 emits steps 1..2. Turn 2 replays those same lines and then emits its own
      // steps starting again at 1, the numbering an agy that restarts per stdin message
      // would use; a reused driver must keep exactly the new ones.
      const step = (index: number, tool: string) =>
        JSON.stringify({
          event: "step_update",
          step_update: {
            conversation_id: "conv-replay",
            step_index: index,
            state: "DONE",
            step_type: "tool",
            tool_name: tool,
            tool_info: { parameters: { Note: tool } },
          },
        });
      const turn1 = [
        JSON.stringify({
          event: "init",
          conversation_id: "conv-replay",
          init: { permission_mode: "dangerously-skip-permissions" },
        }),
        step(1, "first_tool"),
        step(2, "second_tool"),
        JSON.stringify({
          event: "result",
          result: {
            conversation_id: "conv-replay",
            status: "SUCCESS",
            num_turns: 1,
            response: "one",
          },
        }),
      ];
      const turn2 = [
        JSON.stringify({
          event: "init",
          conversation_id: "conv-replay",
          init: { permission_mode: "dangerously-skip-permissions" },
        }),
        step(1, "first_tool"),
        step(2, "second_tool"),
        step(1, "third_tool"),
        step(2, "fourth_tool"),
        JSON.stringify({
          event: "result",
          result: {
            conversation_id: "conv-replay",
            status: "SUCCESS",
            num_turns: 2,
            response: "two",
          },
        }),
      ];
      const turn3 = [
        JSON.stringify({
          event: "init",
          conversation_id: "conv-replay",
          init: { permission_mode: "dangerously-skip-permissions" },
        }),
        step(1, "third_tool"),
        step(2, "fourth_tool"),
        step(1, "first_tool"),
        step(2, "fifth_tool"),
        JSON.stringify({
          event: "result",
          result: {
            conversation_id: "conv-replay",
            status: "SUCCESS",
            num_turns: 3,
            response: "three",
          },
        }),
      ];
      // Turn 4 replays first_tool/fifth_tool and then emits first_tool again as its own
      // first step. Matching a replay must consume it, or this identical new step is lost.
      const turn4 = [
        JSON.stringify({
          event: "init",
          conversation_id: "conv-replay",
          init: { permission_mode: "dangerously-skip-permissions" },
        }),
        step(1, "first_tool"),
        step(2, "fifth_tool"),
        step(1, "first_tool"),
        step(2, "sixth_tool"),
        JSON.stringify({
          event: "result",
          result: {
            conversation_id: "conv-replay",
            status: "SUCCESS",
            num_turns: 4,
            response: "four",
          },
        }),
      ];
      const scriptContent = `
const turns = ${JSON.stringify([turn1, turn2, turn3, turn4])};
if (process.argv.includes("models")) {
  process.stdout.write("gemini-3.7-flash-high\\tGemini 3.7 Flash High\\n");
  process.exit(0);
}
if (process.argv.some((value) => value.startsWith("--print="))) process.exit(0);
let index = 0;
let buffer = "";
process.stdin.resume();
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\\n")) >= 0) {
    buffer = buffer.slice(newline + 1);
    const lines = turns[index] ?? [];
    index += 1;
    for (const line of lines) process.stdout.write(line + "\\n");
  }
});
process.stdin.on("end", () => process.exit(0));
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
        const opened = await adapter.open({ kind: "create", cwd });
        if (!opened.ok) throw new Error(opened.error.message);
        const session = opened.value;
        const iterator = session.outputs[Symbol.asyncIterator]();
        const toolNames = async (turnId: string, text: string): Promise<string[]> => {
          await session.execute({
            type: "turn.start",
            turnId: hostTurnIdSchema.parse(turnId),
            input: [{ type: "text", text }],
          });
          const names: string[] = [];
          while (true) {
            const event = await nextEvent(iterator);
            if (event.type === "item.started" && event.item.type === "toolExecution") {
              names.push(event.item.toolName);
            }
            if (event.type === "turn.completed") return names;
          }
        };

        expect(await toolNames("turn-replay-1", "one")).toEqual(["first_tool", "second_tool"]);
        // The replayed pair is dropped; the Turn's own two steps survive despite reusing
        // indices 1 and 2.
        expect(await toolNames("turn-replay-2", "two")).toEqual(["third_tool", "fourth_tool"]);
        // A third Turn replays third/fourth and then repeats first_tool verbatim as its own
        // first step: each replay is consumed once, so this one must still be delivered.
        expect(await toolNames("turn-replay-3", "three")).toEqual(["first_tool", "fifth_tool"]);
        expect(await toolNames("turn-replay-4", "four")).toEqual(["first_tool", "sixth_tool"]);
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

    it("does not fail a replied Turn that only repeats an earlier Turn's native error", async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-agy-sticky-error-"));
      const cwd = await mkdtemp(path.join(os.tmpdir(), "codexhost-agy-sticky-error-cwd-"));
      const cleanup = async (): Promise<void> => {
        for (const target of [directory, cwd]) {
          await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
        }
      };
      const stale =
        'request failed: Post "https://example.invalid/stream": proxyconnect tcp: connection refused';
      const runsDir = path.join(directory, "runs");
      // agy repeats the Conversation's first failure in every later result.
      const results = [
        { status: "ERROR", error: stale, num_turns: 1 },
        { status: "ERROR", error: stale, num_turns: 2, response: "1\n" },
        { status: "ERROR", error: "Individual quota reached.", num_turns: 3, response: "2\n" },
        // no new reply: the response only carries the earlier Turn's
        { status: "ERROR", error: stale, num_turns: 4, response: "2\n" },
      ];
      const scriptContent = `
const fs = require('fs');
const path = require('path');
if (process.argv.includes("models")) {
  process.stdout.write("gemini-3.7-flash-high\\tGemini 3.7 Flash High\\n");
  process.exit(0);
}
if (!process.argv.includes("--input-format")) process.exit(0);
const runsDir = ${JSON.stringify(runsDir)};
fs.mkdirSync(runsDir, { recursive: true });
const results = ${JSON.stringify(results)};
// One process serves every Turn, as the real CLI does: each stdin line advances the script.
let count = fs.readdirSync(runsDir).length;
let buffer = "";
function answer() {
  fs.writeFileSync(path.join(runsDir, "run-" + count + ".txt"), "");
  const result = results[count];
  count += 1;
  if (!result) return;
  process.stdout.write(JSON.stringify({ event: "init", conversation_id: "conv-sticky", init: { permission_mode: "default" } }) + "\\n");
  process.stdout.write(JSON.stringify({ event: "result", result: { conversation_id: "conv-sticky", ...result } }) + "\\n");
}
process.stdin.resume();
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\\n")) >= 0) {
    buffer = buffer.slice(newline + 1);
    answer();
  }
});
process.stdin.on("end", () => process.exit(0));
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
        const opened = await adapter.open({ kind: "create", cwd });
        expect(opened.ok).toBe(true);
        if (!opened.ok) return;
        const session = opened.value;
        const iterator = session.outputs[Symbol.asyncIterator]();
        const outcomes: unknown[] = [];
        const agentMessageTurns: string[] = [];
        for (const [index, text] of ["fails", "print:1", "print:2", "fails again"].entries()) {
          await session.execute({
            type: "turn.start",
            turnId: hostTurnIdSchema.parse(`turn-sticky-${String(index + 1)}`),
            input: [{ type: "text", text }],
          });
          while (true) {
            const event = await nextEvent(iterator);
            if (event.type === "item.started" && event.item.type === "agentMessage") {
              agentMessageTurns.push(event.turnId);
            }
            if (event.type === "turn.completed") {
              outcomes.push(event.outcome);
              break;
            }
          }
        }
        // the fourth Turn added no reply, so it must not get an agent message
        expect(agentMessageTurns).toEqual(["turn-sticky-2", "turn-sticky-3"]);
        expect(outcomes[0]).toMatchObject({
          status: "failed",
          error: { message: `Antigravity Turn ended with status ERROR: ${stale}` },
        });
        expect(outcomes[1]).toMatchObject({ status: "succeeded" });
        expect(outcomes[2]).toMatchObject({
          status: "failed",
          error: { message: "Antigravity Turn ended with status ERROR: Individual quota reached." },
        });
        expect(outcomes[3]).toMatchObject({
          status: "failed",
          error: { message: `Antigravity Turn ended with status ERROR: ${stale}` },
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
  process.stdout.write(JSON.stringify({ event: "step_update", step_update: { conversation_id: "conv-switch", step_index: 1, state: "DONE", step_type: "agent_response", text_delta: "Hello from Gemini", usage: { input_tokens: 100, output_tokens: 20, cache_read_tokens: 0, total_tokens: 120 } } }) + "\\n");
  process.stdout.write(JSON.stringify({ event: "result", result: { conversation_id: "conv-switch", status: "SUCCESS", num_turns: 1, response: "Hello from Gemini", usage: { input_tokens: 100, output_tokens: 20, cache_read_tokens: 0, total_tokens: 120 } } }) + "\\n");
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

        // Configure the next invocation while the first native process is still running.
        expect(
          await session.execute({
            type: "model.select",
            model: harnessModelRefSchema.parse({ id: "gemini-3.7-flash" }),
          }),
        ).toMatchObject({ ok: true });
        expect(
          await session.execute({
            type: "thinking.select",
            thinkingOptionId: harnessThinkingOptionIdSchema.parse("high"),
          }),
        ).toMatchObject({ ok: true });
        expect(
          await session.execute({
            type: "model.select",
            model: harnessModelRefSchema.parse({ id: "claude-3-7-sonnet" }),
          }),
        ).toMatchObject({ ok: true });

        let turn1Usage: Record<string, unknown> | null = null;
        while (true) {
          const ev = await nextEvent(iterator);
          if (ev.type === "session.usage.changed") turn1Usage = ev.usage as Record<string, unknown>;
          if (ev.type === "turn.completed") break;
        }
        expect(turn1Usage).not.toBeNull();
        expect(turn1Usage?.contextWindowTokens).toBe(1_048_576);
        expect(turn1Usage).not.toHaveProperty("cachedInputTokens");
        expect(turn1Usage).not.toHaveProperty("cacheHitRatePercent");

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

    it("estimates context from the latest request's prompt, not the Conversation's result totals", async () => {
      const streamLines = [
        JSON.stringify({
          event: "init",
          init: { permission_mode: "dangerously-skip-permissions" },
          conversation_id: "conv-context",
        }),
        JSON.stringify({
          event: "step_update",
          step_update: {
            conversation_id: "conv-context",
            step_index: 7,
            state: "DONE",
            step_type: "agent_response",
            text_delta: "Done.",
            // agy reports the cached part of this request's prompt separately.
            usage: {
              input_tokens: 2_751,
              cache_read_tokens: 80_432,
              output_tokens: 146,
              thinking_tokens: 0,
              total_tokens: 83_329,
            },
          },
        }),
        JSON.stringify({
          event: "result",
          result: {
            conversation_id: "conv-context",
            status: "SUCCESS",
            num_turns: 3,
            response: "Done.",
            // Totals over every request of the resumed Conversation, not one prompt.
            usage: {
              input_tokens: 120_418,
              cache_read_tokens: 412_903,
              output_tokens: 1_204,
              thinking_tokens: 0,
              total_tokens: 534_525,
            },
          },
        }),
      ];
      const { command, cwd, cleanup } = await fakeStreamingAgy(streamLines);
      const adapter = new AntigravityAdapter({ command });
      try {
        const opened = await adapter.open({ kind: "create", cwd });
        if (!opened.ok) throw new Error(opened.error.message);
        const session = opened.value;
        const iterator = session.outputs[Symbol.asyncIterator]();
        await session.execute({
          type: "turn.start",
          turnId: hostTurnIdSchema.parse("turn-context"),
          input: [{ type: "text", text: "continue" }],
        });
        const usages: Array<Record<string, unknown>> = [];
        while (true) {
          const event = await nextEvent(iterator);
          if (event.type === "session.usage.changed" && event.usage) {
            usages.push(event.usage as Record<string, unknown>);
          }
          if (event.type === "turn.completed") break;
        }
        expect(usages.map(({ contextUsedTokens }) => contextUsedTokens)).not.toContain(120_418);
        expect(usages.at(-1)).toMatchObject({
          contextUsedTokens: 83_183,
          contextWindowTokens: 1_048_576,
          inputTokens: 120_418,
          outputTokens: 1_204,
        });
        await session.close();
      } finally {
        await adapter.close();
        await cleanup();
      }
    });

    it("formats turn prompt with workspace file instructions and leaves slash commands untouched", () => {
      const normalPrompt = "Create a hello world python file";
      const formatted = formatAntigravityTurnPrompt(normalPrompt);
      expect(formatted).toBe(`${ANTIGRAVITY_WORKSPACE_FILE_INSTRUCTION}${normalPrompt}`);

      const slashCommand = "/plan refactor authentication";
      expect(formatAntigravityTurnPrompt(slashCommand)).toBe(slashCommand);

      // Idempotency: does not double-inject if instruction already present
      expect(formatAntigravityTurnPrompt(formatted)).toBe(formatted);

      // The Hook directory is also a workspace, so the project directory is named explicitly.
      const project = path.join(os.tmpdir(), "project dir");
      const located = formatAntigravityTurnPrompt(normalPrompt, project);
      expect(located.startsWith(ANTIGRAVITY_WORKSPACE_FILE_INSTRUCTION)).toBe(true);
      expect(located).toContain(
        `[System Instruction: The project working directory is ${JSON.stringify(project)}.`,
      );
      expect(located.endsWith(`]\n\n${normalPrompt}`)).toBe(true);
      expect(formatAntigravityTurnPrompt(slashCommand, project)).toBe(slashCommand);
      expect(formatAntigravityTurnPrompt(located, project)).toBe(located);
    });
  });
});
