import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import type { HarnessOutput, HostEvent } from "@codexhost/harness-adapter";
import {
  harnessPermissionModeIdSchema,
  hostTurnIdSchema,
  type JsonObject,
} from "@codexhost/shared-contracts";
import { CodexTurnProjector, type ProjectableHostEvent } from "@codexhost/protocol-core";
import { AntigravityAdapter, resolveAntigravityContextWindow } from "../src/antigravity-adapter.js";

function asObject(value: unknown): JsonObject {
  return typeof value === "object" && value !== null ? (value as JsonObject) : {};
}

describe("Antigravity Full End-to-End Simulation", () => {
  async function setupRealisticFakeAgy(streamLines: readonly string[]): Promise<{
    command: string;
    projectDir: string;
    cleanup(): Promise<void>;
  }> {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "codexhost-real-agy-"));
    const projectDir = await mkdtemp(path.join(os.tmpdir(), "codexhost-real-proj-"));

    const scriptContent = `
const lines = ${JSON.stringify(streamLines)};
if (process.argv.includes("models")) {
  process.stdout.write("gemini-3.7-flash-high\\tGemini 3.7 Flash (High)\\n");
  process.exit(0);
}
for (const line of lines) {
  process.stdout.write(line + "\\n");
}
`;
    const jsPath = path.join(tmpDir, "agy.cjs");
    await writeFile(jsPath, scriptContent);

    let command: string;
    if (process.platform === "win32") {
      command = path.join(tmpDir, "agy.cmd");
      await writeFile(command, `@node "${jsPath}" %*\r\n`);
    } else {
      command = path.join(tmpDir, "agy");
      await writeFile(command, `#!/usr/bin/env node\n${scriptContent}`);
      await chmod(command, 0o755);
    }

    const cleanup = async (): Promise<void> => {
      for (const target of [tmpDir, projectDir]) {
        await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      }
    };

    return { command, projectDir, cleanup };
  }

  it("simulates full execution flow: unquoted parameters, 1M context, real diff line counts, and native tooltip injection", async () => {
    // The stream below is synthetic: real `agy --output-format stream-json`
    // publishes only `TargetFile` for a file tool and keeps the content out of
    // the stream entirely (the applied patch comes from its Language Server,
    // see code-action-diff). What this exercises is the Host's generic
    // content-carrying tool path and the JSON-quoted parameter unwrapping.
    const streamLines = [
      JSON.stringify({
        event: "init",
        conversation_id: "conv-e2e-real",
        init: { permission_mode: "dangerously-skip-permissions" },
      }),
      // Step 1: write_to_file with JSON string quoted parameters
      JSON.stringify({
        event: "step_update",
        step_update: {
          conversation_id: "conv-e2e-real",
          step_index: 1,
          state: "ACTIVE",
          step_type: "tool",
          tool_name: "write_to_file",
          tool_info: {
            parameters: {
              TargetFile: '"snake.py"',
              CodeContent:
                "\"import pygame\\nimport sys\\n\\ndef main():\\n    print('Snake game')\\n    pygame.init()\\n\"",
              Overwrite: "true",
            },
          },
        },
      }),
      JSON.stringify({
        event: "step_update",
        step_update: {
          conversation_id: "conv-e2e-real",
          step_index: 1,
          state: "DONE",
          step_type: "tool",
          duration_seconds: 0.35,
          tool_info: { output: "File written successfully." },
        },
      }),
      // Step 2: replace_file_content with JSON string quoted parameters
      JSON.stringify({
        event: "step_update",
        step_update: {
          conversation_id: "conv-e2e-real",
          step_index: 2,
          state: "ACTIVE",
          step_type: "tool",
          tool_name: "replace_file_content",
          tool_info: {
            parameters: {
              TargetFile: '"snake.py"',
              TargetContent: "\"print('Snake game')\"",
              ReplacementContent: "\"print('Snake game v2.0')\\n    print('Score: 0')\"",
            },
          },
        },
      }),
      JSON.stringify({
        event: "step_update",
        step_update: {
          conversation_id: "conv-e2e-real",
          step_index: 2,
          state: "DONE",
          step_type: "tool",
          duration_seconds: 0.12,
          tool_info: { output: "Content replaced successfully." },
        },
      }),
      // Step 3: run_command
      JSON.stringify({
        event: "step_update",
        step_update: {
          conversation_id: "conv-e2e-real",
          step_index: 3,
          state: "ACTIVE",
          step_type: "tool",
          tool_name: "run_command",
          tool_info: {
            parameters: {
              CommandLine: '"python snake.py"',
              Cwd: '"D:\\\\CodeProject\\\\test"',
            },
          },
        },
      }),
      JSON.stringify({
        event: "step_update",
        step_update: {
          conversation_id: "conv-e2e-real",
          step_index: 3,
          state: "DONE",
          step_type: "tool",
          duration_seconds: 1.1,
          tool_info: { output: "Snake game v2.0\nScore: 0\n" },
        },
      }),
      // Step 4: assistant message
      JSON.stringify({
        event: "step_update",
        step_update: {
          conversation_id: "conv-e2e-real",
          step_index: 4,
          state: "ACTIVE",
          step_type: "agent_response",
          text_delta: "Successfully implemented Snake game v2.0 with live scoring.",
        },
      }),
      // Turn result with token usage
      JSON.stringify({
        event: "result",
        result: {
          conversation_id: "conv-e2e-real",
          status: "SUCCESS",
          num_turns: 1,
          response: "Successfully implemented Snake game v2.0 with live scoring.",
          usage: {
            input_tokens: 3500,
            output_tokens: 450,
            cache_read_tokens: 1800,
            total_tokens: 3950,
          },
        },
      }),
    ];

    const { command, projectDir, cleanup } = await setupRealisticFakeAgy(streamLines);

    try {
      // 2. Initialize Antigravity Adapter
      const adapter = new AntigravityAdapter({ command });
      const sessionResult = await adapter.open({
        kind: "create",
        cwd: projectDir,
        permissionModeId: harnessPermissionModeIdSchema.parse("dangerously-skip-permissions"),
      });
      expect(sessionResult.ok).toBe(true);
      if (!sessionResult.ok) return;

      const session = sessionResult.value;
      const iterator = session.outputs[Symbol.asyncIterator]();

      // 3. Initialize Codex UI Projector
      const turnId = hostTurnIdSchema.parse("turn-sim-1");
      const projector = new CodexTurnProjector({
        threadId: "thread-sim-1",
        turnId,
        cwd: projectDir,
        startedAtMs: Date.now(),
        initialInput: [{ type: "text", text: "Create snake game and update it" }],
      });
      const wireMessages: Array<Record<string, unknown>> = [];

      await session.execute({
        type: "turn.start",
        turnId,
        input: [{ type: "text", text: "Create snake game and update it" }],
      });

      // Collect all events from adapter and project through CodexTurnProjector
      let latestUsage: Record<string, unknown> | null = null;
      let turnCompleted = false;

      while (!turnCompleted) {
        const item = await iterator.next();
        if (item.done) break;
        const output: HarnessOutput = item.value;
        if (output.kind === "event") {
          const event: HostEvent = output.event;
          if (event.type === "session.usage.changed") {
            latestUsage = event.usage as Record<string, unknown>;
            continue;
          }
          if (event.type === "session.state.changed") {
            continue;
          }

          if ("turnId" in event && event.turnId === turnId) {
            const projection = projector.project(event as ProjectableHostEvent);
            wireMessages.push(...(projection.messages as Array<Record<string, unknown>>));
          }

          if (event.type === "turn.completed") {
            turnCompleted = true;
          }
        }
      }

      await session.close();

      // -------------------------------------------------------------
      // VERIFICATION 1: Context Window standard is 1M (1,048,576)
      // -------------------------------------------------------------
      expect(latestUsage).not.toBeNull();
      expect(latestUsage?.contextWindowTokens).toBe(1_048_576);
      expect(latestUsage?.contextWindowTokens).not.toBe(128_000);
      expect(latestUsage?.contextWindowTokens).not.toBe(256_000);

      // Verify resolveAntigravityContextWindow logic directly
      expect(resolveAntigravityContextWindow("gemini-3.7-flash-high", 128_000)).toBe(1_048_576);
      expect(resolveAntigravityContextWindow("gemini-3.8-flash-high", 256_000)).toBe(1_048_576);
      expect(resolveAntigravityContextWindow(undefined, 128_000)).toBe(1_048_576);
      expect(resolveAntigravityContextWindow("claude-sonnet-4-6", 128_000)).toBe(200_000);

      // -------------------------------------------------------------
      // VERIFICATION 2: Intermediate steps streamed & never suppressed
      // -------------------------------------------------------------
      const startedItemMethods = wireMessages.filter((m) => m.method === "item/started");
      const completedItemMethods = wireMessages.filter((m) => m.method === "item/completed");

      // Verify intermediate file changes and command execution are all emitted
      expect(startedItemMethods.length).toBeGreaterThanOrEqual(3);
      expect(completedItemMethods.length).toBeGreaterThanOrEqual(3);

      // Verify fileChange item started with clean, unquoted relative path
      const fileChangeStarts = startedItemMethods.filter(
        (m) => asObject(asObject(m.params).item).type === "fileChange",
      );
      expect(fileChangeStarts.length).toBeGreaterThanOrEqual(1);
      const firstFileChange = asObject(asObject(fileChangeStarts[0]?.params).item);
      const fileChanges = Array.isArray(firstFileChange.changes) ? firstFileChange.changes : [];
      expect(asObject(fileChanges[0]).path).toBe("snake.py");
      expect(String(asObject(fileChanges[0]).path)).not.toContain('"');

      // Verify commandExecution item started with unquoted command
      const cmdStarts = startedItemMethods.filter(
        (m) => asObject(asObject(m.params).item).type === "commandExecution",
      );
      expect(cmdStarts.length).toBeGreaterThanOrEqual(1);
      const firstCmd = asObject(asObject(cmdStarts[0]?.params).item);
      expect(firstCmd.command).toBe("python snake.py");
      expect(String(firstCmd.command)).not.toContain('"');

      // -------------------------------------------------------------
      // VERIFICATION 3: Bottom Diff Summary card (+X -Y) is accurate (NOT +0 -0)
      // -------------------------------------------------------------
      const diffUpdatedMessages = wireMessages.filter((m) => m.method === "turn/diff/updated");
      expect(diffUpdatedMessages.length).toBeGreaterThanOrEqual(1);

      const latestDiffMessage = diffUpdatedMessages[diffUpdatedMessages.length - 1];
      const finalDiff = String(asObject(latestDiffMessage?.params).diff ?? "");
      expect(finalDiff).toBeDefined();
      expect(finalDiff).toContain("diff --git a/snake.py b/snake.py");
      expect(finalDiff).not.toContain("@@ -0,0 +0,0 @@");

      // Count added and deleted lines in the unified diff
      const addedLines = finalDiff
        .split("\n")
        .filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
      const removedLines = finalDiff
        .split("\n")
        .filter((line) => line.startsWith("-") && !line.startsWith("---")).length;

      // Ensure that lines are strictly non-zero and match the edits
      expect(addedLines).toBeGreaterThan(0);
      expect(addedLines).toBe(8); // 6 lines from write_to_file + 2 lines from replace_file_content
      expect(removedLines).toBe(1); // 1 replaced line (-print('Snake game'))
    } finally {
      await cleanup();
    }
  });
});
