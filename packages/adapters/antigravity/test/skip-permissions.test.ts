import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { HarnessOutput } from "@codexhost/harness-adapter";
import { hostTurnIdSchema } from "@codexhost/shared-contracts";
import { expect, it } from "vitest";

import { AntigravityAdapter } from "../src/antigravity-adapter.js";

// Emulates CLI Hook dispatch, not agy's permission policy. The test checks that
// codexhost installs no ordinary-tool gate and still bridges a late Question.
const script = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.AGY_TEST_LOG, JSON.stringify(args) + "\n");
if (args.includes("models")) {
  console.log("gemini-3.1-pro-high\tGemini 3.1 Pro High");
  process.exit(0);
}
if (args.includes("--print=/usage")) process.exit(0);
if (!args.includes("--dangerously-skip-permissions")) throw Error("Missing native skip flag");
if (args.some(arg => arg === "--print=/config" || arg === "--print=/hooks")) throw Error("Unexpected permission probe");
const config = JSON.parse(fs.readFileSync(path.join(args[args.lastIndexOf("--add-dir") + 1], ".agents", "hooks.json"), "utf8"));
const handlers = Object.values(config).flatMap(hook => hook.PreToolUse);
if (handlers.length !== 1 || handlers[0].matcher !== "^ask_question$") throw Error("Unexpected tool gate");
const emit = value => console.log(JSON.stringify(value));
const conversationId = "skip-regression";
emit({ event: "init", conversation_id: conversationId, init: { permission_mode: "dangerously-skip-permissions" } });
for (let stepIdx = 0; stepIdx < 160; stepIdx++) {
  const toolCall = { name: "view_file", args: { AbsolutePath: "/outside/workspace/file.txt" } };
  for (const handler of handlers) {
    if (new RegExp(handler.matcher).test(toolCall.name)) {
      execSync(handler.hooks[0].command, { input: JSON.stringify({ conversationId, stepIdx, toolCall }) });
      throw Error("Ordinary tool entered question bridge");
    }
  }
  emit({ event: "step_update", step_update: { conversation_id: conversationId, step_index: stepIdx, state: "ACTIVE", step_type: "tool", tool_name: toolCall.name, tool_info: { parameters: toolCall.args } } });
  emit({ event: "step_update", step_update: { conversation_id: conversationId, step_index: stepIdx, state: "DONE", step_type: "tool", tool_info: { output: "fixture contents" } } });
}
const answer = JSON.parse(execSync(handlers[0].hooks[0].command, {
  input: JSON.stringify({ conversationId, stepIdx: 160, toolCall: { name: "ask_question", args: { questions: [{ question: "Continue?", options: ["Yes", "No"] }] } } }),
  encoding: "utf8",
}));
if (answer.decision !== "deny" || !answer.reason.includes('"Yes"')) throw Error("Question lost after 160 tools");
emit({ event: "result", result: { conversation_id: conversationId, status: "SUCCESS", num_turns: 1, response: "Finished 160 tools and a question" } });
`;

it("runs more than 128 tools without Host approvals or permission probes, then answers a Question", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agy-skip-test-"));
  const cwd = path.join(directory, "workspace");
  await mkdir(cwd);
  const log = path.join(directory, "calls.jsonl");
  const jsPath = path.join(directory, "agy.cjs");
  await writeFile(jsPath, script);
  const command = path.join(directory, process.platform === "win32" ? "agy.cmd" : "agy");
  await writeFile(
    command,
    process.platform === "win32" ? `@node "${jsPath}" %*\r\n` : `#!/usr/bin/env node\n${script}`,
  );
  await chmod(command, 0o755);
  const adapter = new AntigravityAdapter({
    command,
    environment: {
      ...process.env,
      AGY_TEST_LOG: log,
      CODEXHOST_HOME: path.join(directory, "host"),
    },
  });
  try {
    const opened = await adapter.open({ kind: "create", cwd });
    if (!opened.ok) throw new Error(opened.error.message);
    const session = opened.value;
    const outputs: HarnessOutput[] = [];
    expect(
      await session.execute({
        type: "turn.start",
        turnId: hostTurnIdSchema.parse("many-tools"),
        input: [{ type: "text", text: "Read files then ask a question" }],
      }),
    ).toMatchObject({ ok: true });
    for await (const output of session.outputs) {
      outputs.push(output);
      if (output.kind === "interaction") {
        expect(output.interaction.type).toBe("question");
        expect(
          await session.execute({
            type: "interaction.respond",
            interactionId: output.interaction.interactionId,
            response: { type: "question", answers: { q1: ["Yes"] } },
          }),
        ).toMatchObject({ ok: true });
      }
      if (output.kind === "event" && output.event.type === "turn.completed") {
        expect(output.event.outcome).toMatchObject({ status: "succeeded" });
        break;
      }
    }
    expect(outputs.filter((output) => output.kind === "interaction")).toHaveLength(1);
    expect(
      outputs.filter(
        (output) =>
          output.kind === "event" &&
          output.event.type === "item.completed" &&
          output.event.snapshot.item.type === "toolExecution" &&
          output.event.snapshot.item.toolName === "view_file",
      ),
    ).toHaveLength(160);
    const calls: string[][] = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(
      calls.filter((args) => !args.includes("models") && !args.includes("--print=/usage")),
    ).toHaveLength(1);
    expect(
      calls.some((args) => args.includes("--print=/config") || args.includes("--print=/hooks")),
    ).toBe(false);
  } finally {
    await adapter.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}, 20_000);
