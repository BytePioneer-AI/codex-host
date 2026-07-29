import { randomUUID } from "node:crypto";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { scenarioResult, scenarioStatus } from "./contracts.mjs";
import {
  allSessionsMatch,
  collectTurn,
  nativeToolUses,
  PushableInput,
  sdkUserMessage,
  writeRawScenario,
} from "./live-helpers.mjs";
import { claudeOptions, closeQuery, processIsAlive, waitFor, withTimeout } from "./runtime.mjs";
import { createProbeWorkspace, removeSyntheticProject } from "./workspace.mjs";

async function fileExists(file) {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export async function runStreamingCancelScenario({ repositoryRoot, executable }) {
  const workspace = createProbeWorkspace(repositoryRoot, "live", "streaming-cancel");
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const sessionId = randomUUID();
  const input = new PushableInput();
  const activeQuery = query({
    prompt: input,
    options: {
      ...claudeOptions({ cwd: workspace.cwd, executable, sessionId }),
      maxTurns: 1,
      maxBudgetUsd: 0.05,
    },
  });
  const messages = [];
  let interruptIssued = false;
  try {
    await activeQuery.initializationResult();
    input.push(
      sdkUserMessage(
        sessionId,
        "Write a plain text response of at least 300 words. Do not use tools.",
      ),
    );
    for (;;) {
      const next = await withTimeout(activeQuery.next(), 90_000, "streaming cancel result");
      if (next.done) throw new Error("Claude Query ended before streaming cancel result");
      messages.push(next.value);
      if (!interruptIssued && next.value.type === "stream_event") {
        interruptIssued = true;
        await activeQuery.interrupt();
      }
      if (next.value.type === "result") break;
    }
  } finally {
    input.end();
    await closeQuery(activeQuery);
  }
  const summary = (await import("./terminal.mjs")).summarizeNativeMessages(messages, {
    cancelRequested: interruptIssued,
  });
  const checks = {
    partialStreamingObserved: (summary.typeCounts.stream_event ?? 0) > 0,
    interruptIssued,
    nativeCancelledTerminal: summary.terminal.outcome === "cancelled",
    exactlyOneResult: summary.resultCount === 1,
    sessionMatched: allSessionsMatch(messages, sessionId),
  };
  const result = scenarioResult({
    id: "live-streaming-cancel",
    profile: "live",
    required: true,
    status: scenarioStatus(checks),
    checks,
    facts: {
      streamEventCount: summary.typeCounts.stream_event ?? 0,
      terminalOutcome: summary.terminal.outcome,
      terminalReason: summary.terminal.reason,
    },
  });
  writeRawScenario(repositoryRoot, workspace, "streaming-cancel", { messages, result });
  removeSyntheticProject(workspace);
  return result;
}

export async function runToolCancelScenario({ repositoryRoot, executable }) {
  const workspace = createProbeWorkspace(repositoryRoot, "live", "tool-cancel");
  const script = path.join(workspace.cwd, "long-task.mjs");
  const taskPidFile = path.join(workspace.cwd, "task.pid");
  const completedFile = path.join(workspace.cwd, "completed.txt");
  await writeFile(
    script,
    [
      'import { writeFile } from "node:fs/promises";',
      'await writeFile("task.pid", String(process.pid), "utf8");',
      "await new Promise((resolve) => setTimeout(resolve, 30000));",
      'await writeFile("completed.txt", "completed\\n", "utf8");',
      "",
    ].join("\n"),
    "utf8",
  );
  await Promise.all([rm(taskPidFile, { force: true }), rm(completedFile, { force: true })]);

  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const sessionId = randomUUID();
  const input = new PushableInput();
  const activeQuery = query({
    prompt: input,
    options: {
      ...claudeOptions({ cwd: workspace.cwd, executable, sessionId }),
      permissionMode: "dontAsk",
      tools: ["Bash"],
      allowedTools: ["Bash"],
      maxTurns: 4,
    },
  });
  input.push(
    sdkUserMessage(
      sessionId,
      "Use Bash to run exactly: node long-task.mjs . Do not run another command. Wait for it, then reply DONE.",
    ),
  );
  const firstMessages = [];
  let interruptIssued = false;
  let taskStarted = false;
  let interruptAt;
  let resultAt;
  for (;;) {
    const next = await withTimeout(activeQuery.next(), 90_000, "Tool cancel result");
    if (next.done) throw new Error("Claude Query ended before Tool cancel result");
    firstMessages.push(next.value);
    if (!interruptIssued && nativeToolUses([next.value]).some(({ name }) => name === "Bash")) {
      taskStarted = await waitFor(() => fileExists(taskPidFile), { timeoutMs: 10_000 });
      if (taskStarted) await new Promise((resolve) => setTimeout(resolve, 1_000));
      interruptAt = Date.now();
      await activeQuery.interrupt();
      interruptIssued = true;
    }
    if (next.value.type === "result") {
      resultAt = Date.now();
      break;
    }
  }
  const firstSummary = (await import("./terminal.mjs")).summarizeNativeMessages(firstMessages, {
    cancelRequested: interruptIssued,
  });
  let taskPid;
  if (await fileExists(taskPidFile)) {
    taskPid = Number.parseInt((await readFile(taskPidFile, "utf8")).trim(), 10);
  }
  const taskExited = await waitFor(() => !processIsAlive(taskPid), { timeoutMs: 5_000 });
  const completionAbsent = !(await fileExists(completedFile));

  input.push(sdkUserMessage(sessionId, "Reply with exactly AFTER_CANCEL. Do not use tools."));
  const recovery = await collectTurn(activeQuery);
  input.end();
  await closeQuery(activeQuery);

  const checks = {
    bashToolObserved: nativeToolUses(firstMessages).some(({ name }) => name === "Bash"),
    taskProcessStarted: taskStarted,
    interruptIssued,
    nativeCancelledTerminal: firstSummary.terminal.outcome === "cancelled",
    interruptConvergedWithinBound:
      interruptAt !== undefined && resultAt !== undefined && resultAt - interruptAt < 5_000,
    taskProcessExited: taskExited,
    completionSideEffectAbsent: completionAbsent,
    sameSessionRecovered: allSessionsMatch(recovery.messages, sessionId),
    recoverySucceeded: recovery.summary.terminal.outcome === "succeeded",
  };
  const result = scenarioResult({
    id: "live-tool-cancel",
    profile: "live",
    required: true,
    status: scenarioStatus(checks),
    checks,
    facts: {
      resultAfterInterruptMs:
        interruptAt !== undefined && resultAt !== undefined ? resultAt - interruptAt : -1,
      toolProgressCount: firstSummary.typeCounts.tool_progress ?? 0,
      terminalReason: firstSummary.terminal.reason,
    },
  });
  writeRawScenario(repositoryRoot, workspace, "tool-cancel", {
    taskPid,
    firstMessages,
    recovery: recovery.messages,
    result,
  });
  removeSyntheticProject(workspace);
  return result;
}

export async function runInteractionCancelScenario({ repositoryRoot, executable }) {
  const workspace = createProbeWorkspace(repositoryRoot, "live", "interaction-cancel");
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  let callbackCount = 0;
  let callbackSettled = false;
  let callbackSignalAborted = false;
  let notifyCallback;
  const callbackStarted = new Promise((resolve) => {
    notifyCallback = resolve;
  });
  const activeQuery = query({
    prompt: "Use AskUserQuestion to ask: Continue? Use header Continue and options Yes and No.",
    options: {
      ...claudeOptions({ cwd: workspace.cwd, executable }),
      sessionId: undefined,
      permissionMode: "default",
      tools: ["AskUserQuestion"],
      maxTurns: 2,
      canUseTool: async (_toolName, input, options) => {
        callbackCount += 1;
        notifyCallback();
        return new Promise((resolve) => {
          options.signal.addEventListener(
            "abort",
            () => {
              callbackSignalAborted = true;
              callbackSettled = true;
              resolve({ behavior: "deny", message: "Synthetic interaction cancelled", input });
            },
            { once: true },
          );
        });
      },
    },
  });
  const messages = [];
  const consume = (async () => {
    for (;;) {
      const next = await activeQuery.next();
      if (next.done) break;
      messages.push(next.value);
      if (next.value.type === "result") break;
    }
  })();
  await withTimeout(callbackStarted, 90_000, "pending Interaction callback");
  await activeQuery.interrupt();
  await withTimeout(consume, 10_000, "pending Interaction cancel result");
  await closeQuery(activeQuery);
  const summary = (await import("./terminal.mjs")).summarizeNativeMessages(messages, {
    cancelRequested: true,
  });
  const checks = {
    exactlyOneCallback: callbackCount === 1,
    callbackSignalAborted,
    callbackSettled,
    nativeCancelledTerminal: summary.terminal.outcome === "cancelled",
    exactlyOneResult: summary.resultCount === 1,
  };
  const result = scenarioResult({
    id: "live-interaction-cancel",
    profile: "live",
    required: true,
    status: scenarioStatus(checks),
    checks,
    facts: {
      callbackCount,
      terminalReason: summary.terminal.reason,
    },
  });
  writeRawScenario(repositoryRoot, workspace, "interaction-cancel", { messages, result });
  removeSyntheticProject(workspace);
  return result;
}
