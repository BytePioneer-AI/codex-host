#!/usr/bin/env node
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { AntigravityAdapter, resolveAntigravityContextWindow } from "../packages/adapters/antigravity/dist/index.js";
import { CodexTurnProjector } from "../packages/protocol-core/dist/index.js";
import {
  syncRendererNativeContextUsage,
  formatRendererNativeContextUsageDetails,
} from "../packages/renderer-extension/dist/index.js";

async function main() {
  console.log("================================================================================");
  console.log("🚀 [CODEXHOST] Antigravity CLI End-to-End Real Simulation Test");
  console.log("================================================================================");

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "codexhost-real-simulation-"));
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "codexhost-project-simulation-"));

  const streamLines = [
    JSON.stringify({
      event: "init",
      conversation_id: "conv-simulation-real",
      init: { permission_mode: "dangerously-skip-permissions" },
    }),
    // 1. write_to_file with JSON string quoted parameters
    JSON.stringify({
      event: "step_update",
      step_update: {
        conversation_id: "conv-simulation-real",
        step_index: 1,
        state: "ACTIVE",
        step_type: "tool",
        tool_name: "write_to_file",
        tool_info: {
          parameters: {
            TargetFile: "\"snake.py\"",
            CodeContent: "\"import pygame\\nimport sys\\n\\ndef main():\\n    print('Snake game')\\n    pygame.init()\\n\"",
            Overwrite: "true",
          },
        },
      },
    }),
    JSON.stringify({
      event: "step_update",
      step_update: {
        conversation_id: "conv-simulation-real",
        step_index: 1,
        state: "DONE",
        step_type: "tool",
        duration_seconds: 0.28,
        tool_info: { output: "File written successfully." },
      },
    }),
    // 2. replace_file_content with JSON string quoted parameters
    JSON.stringify({
      event: "step_update",
      step_update: {
        conversation_id: "conv-simulation-real",
        step_index: 2,
        state: "ACTIVE",
        step_type: "tool",
        tool_name: "replace_file_content",
        tool_info: {
          parameters: {
            TargetFile: "\"snake.py\"",
            TargetContent: "\"print('Snake game')\"",
            ReplacementContent: "\"print('Snake game v2.0')\\n    print('Score: 0')\"",
          },
        },
      },
    }),
    JSON.stringify({
      event: "step_update",
      step_update: {
        conversation_id: "conv-simulation-real",
        step_index: 2,
        state: "DONE",
        step_type: "tool",
        duration_seconds: 0.15,
        tool_info: { output: "Content replaced successfully." },
      },
    }),
    // 3. run_command with JSON string quoted parameters
    JSON.stringify({
      event: "step_update",
      step_update: {
        conversation_id: "conv-simulation-real",
        step_index: 3,
        state: "ACTIVE",
        step_type: "tool",
        tool_name: "run_command",
        tool_info: {
          parameters: {
            CommandLine: "\"python snake.py\"",
            Cwd: "\"D:\\\\CodeProject\\\\test\"",
          },
        },
      },
    }),
    JSON.stringify({
      event: "step_update",
      step_update: {
        conversation_id: "conv-simulation-real",
        step_index: 3,
        state: "DONE",
        step_type: "tool",
        duration_seconds: 0.85,
        tool_info: { output: "Snake game v2.0\nScore: 0\n" },
      },
    }),
    // 4. agent response
    JSON.stringify({
      event: "step_update",
      step_update: {
        conversation_id: "conv-simulation-real",
        step_index: 4,
        state: "ACTIVE",
        step_type: "agent_response",
        text_delta: "Snake game v2.0 with scoring has been implemented and tested.",
      },
    }),
    // 5. result
    JSON.stringify({
      event: "result",
      result: {
        conversation_id: "conv-simulation-real",
        status: "SUCCESS",
        num_turns: 1,
        response: "Snake game v2.0 with scoring has been implemented and tested.",
        usage: {
          input_tokens: 3500,
          output_tokens: 450,
          cache_read_tokens: 1800,
          total_tokens: 3950,
        },
      },
    }),
  ];

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

  let command;
  if (process.platform === "win32") {
    command = path.join(tmpDir, "agy.cmd");
    await writeFile(command, `@node "${jsPath}" %*\r\n`);
  } else {
    command = path.join(tmpDir, "agy");
    await writeFile(command, `#!/usr/bin/env node\n${scriptContent}`);
    await chmod(command, 0o755);
  }

  try {
    console.log(`[SETUP] Project CWD: ${projectDir}`);
    console.log(`[SETUP] Simulated CLI: ${command}`);

    const adapter = new AntigravityAdapter({ command });
    const sessionResult = await adapter.open({
      kind: "create",
      cwd: projectDir,
      permissionModeId: "dangerously-skip-permissions",
    });

    if (!sessionResult.ok) {
      console.error("[FAIL] Failed to open session:", sessionResult.error);
      process.exit(1);
    }

    const session = sessionResult.value;
    const iterator = session.outputs[Symbol.asyncIterator]();

    const turnId = "turn-sim-100";
    const projector = new CodexTurnProjector({
      threadId: "thread-sim-100",
      turnId,
      cwd: projectDir,
      startedAtMs: Date.now(),
      initialInput: [{ type: "text", text: "Create and update snake.py" }],
    });

    const wireMessages = [];
    let latestUsage = null;
    let turnCompleted = false;

    await session.execute({
      type: "turn.start",
      turnId,
      input: [{ type: "text", text: "Create and update snake.py" }],
    });

    console.log("\n--- [STREAMING PHASE] Events received from Adapter & projected to Desktop ---");

    while (!turnCompleted) {
      const item = await iterator.next();
      if (item.done) break;
      const output = item.value;
      if (output.kind === "event") {
        const event = output.event;

        if (event.type === "session.usage.changed") {
          latestUsage = event.usage;
          console.log(`[EVENT: USAGE] Context Window: ${event.usage.contextWindowTokens}, Used: ${event.usage.contextUsedTokens ?? 0}`);
          continue;
        }

        if (event.type === "session.state.changed") {
          continue;
        }

        if ("turnId" in event && event.turnId === turnId) {
          const projection = projector.project(event);
          for (const msg of projection.messages) {
            wireMessages.push(msg);
            if (msg.method === "item/started") {
              const itm = msg.params.item;
              if (itm.type === "fileChange") {
                console.log(`  ▶ [DESKTOP WIRE] item/started (fileChange) -> path: "${itm.changes[0]?.path}", kind: "${itm.changes[0]?.kind?.type}"`);
              } else if (itm.type === "commandExecution") {
                console.log(`  ▶ [DESKTOP WIRE] item/started (commandExecution) -> command: "${itm.command}"`);
              }
            } else if (msg.method === "item/completed") {
              const itm = msg.params.item;
              console.log(`  ✔ [DESKTOP WIRE] item/completed (${itm.type})`);
            } else if (msg.method === "turn/diff/updated") {
              console.log(`  📄 [DESKTOP WIRE] turn/diff/updated -> patch updated`);
            }
          }
        }

        if (event.type === "turn.completed") {
          turnCompleted = true;
          console.log(`[EVENT: TURN COMPLETED] Status: ${event.outcome.status}`);
        }
      }
    }

    await session.close();

    console.log("\n--- [VERIFICATION SUMMARY] ---");

    // 1. Check Context Window
    const ctxWin = latestUsage?.contextWindowTokens;
    const resolvedContextWindow = resolveAntigravityContextWindow("gemini-3.7-flash-high");
    const is1M = ctxWin === 1_048_576 && resolvedContextWindow === 1_048_576;
    console.log(`1. [CONTEXT WINDOW]: ${ctxWin} tokens ${is1M ? "✅ (1M Standard Verified!)" : "❌ (FAILED: expected 1048576)"}`);
    if (!is1M) throw new Error(`Expected context window 1048576, got ${ctxWin}`);

    // 2. Check File Edit Diff Line Counts
    const diffMessages = wireMessages.filter((m) => m.method === "turn/diff/updated");
    const finalDiff = diffMessages[diffMessages.length - 1]?.params?.diff || "";
    const addedLines = finalDiff.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).length;
    const removedLines = finalDiff.split("\n").filter((l) => l.startsWith("-") && !l.startsWith("---")).length;

    console.log(`2. [BOTTOM FILE EDIT SUMMARY CARD]:`);
    console.log(`   File: snake.py`);
    console.log(`   Git header: diff --git a/snake.py b/snake.py`);
    console.log(`   Line count diff: +${addedLines} -${removedLines}`);
    const isLineCountValid = addedLines === 8 && removedLines === 1;
    console.log(`   Status: ${isLineCountValid ? "✅ (Accurate +8 -1 line modification, NOT +0 -0!)" : "❌ (FAILED: got +0 -0 or wrong lines)"}`);
    if (!isLineCountValid) throw new Error(`Expected +8 -1, got +${addedLines} -${removedLines}`);

    // 3. Check Native Context Tooltip Usage Injection
    const tooltipChildren = [];
    const tooltipElement = {
      tagName: "DIV",
      classList: { contains: () => true },
      querySelectorAll: () => [tooltipElement],
      append: (c) => tooltipChildren.push(c),
    };
    const rootTooltip = {
      tagName: "DIV",
      getAttribute: () => "tooltip",
      querySelectorAll: () => [tooltipElement],
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 50 }),
    };
    const mockDocument = {
      createElement: (tag) => ({
        tagName: tag.toUpperCase(),
        dataset: {},
        style: {},
        parentElement: tooltipElement,
        isConnected: true,
        replaceChildren: () => {},
        remove: () => {},
      }),
      getElementById: () => rootTooltip,
      body: { querySelectorAll: () => [rootTooltip] },
      defaultView: {},
    };
    rootTooltip.ownerDocument = mockDocument;

    const attributes = new Map([["aria-describedby", "ctx-tip"]]);
    const nativeContextEl = {
      ownerDocument: mockDocument,
      parentElement: null,
      hidden: false,
      getAttribute: (k) => attributes.get(k) ?? null,
      setAttribute: (k, v) => attributes.set(k, v),
      removeAttribute: (k) => attributes.delete(k),
    };

    const threadUsageSnapshot = {
      contextWindowTokens: 1_048_576,
      contextUsedTokens: 3500,
      cachedInputTokens: 1800,
      totalTokens: 3950,
      inputTokens: 3500,
      outputTokens: 450,
      cacheHitRatePercent: Math.round((1800 / 3500) * 100),
      totalCostUsd: 0.008,
    };

    syncRendererNativeContextUsage(nativeContextEl, threadUsageSnapshot, "zh-CN");
    const injectedTextZh = tooltipChildren[0]?.dataset?.codexhostNativeUsageDetailsText || "";

    console.log(`3. [NATIVE CONTEXT TOOLTIP INJECTION]:`);
    console.log(injectedTextZh.split("\n").map((l) => `   ${l}`).join("\n"));
    const detailsEn = formatRendererNativeContextUsageDetails(threadUsageSnapshot, "en");
    const tooltipValid =
      injectedTextZh.includes("Token 总数: 4k") &&
      injectedTextZh.includes("最近缓存命中率: CH 51%") &&
      detailsEn.includes("Total tokens: 4k");
    console.log(`   Status: ${tooltipValid ? "✅ (Native tooltip successfully injected with external usage!)" : "❌ (FAILED)"}`);
    if (!tooltipValid) throw new Error("Tooltip injection failed");

    console.log("\n================================================================================");
    console.log("🎉 ALL REAL END-TO-END VERIFICATIONS PASSED SUCCESSFULLY!");
    console.log("================================================================================");
  } finally {
    for (const target of [tmpDir, projectDir]) {
      await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }
}

main().catch((err) => {
  console.error("FATAL ERROR:", err);
  process.exit(1);
});
