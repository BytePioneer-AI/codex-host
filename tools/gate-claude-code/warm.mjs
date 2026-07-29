import { randomUUID } from "node:crypto";

import { scenarioResult, scenarioStatus } from "./contracts.mjs";
import { createProbeWorkspace, removeSyntheticProject } from "./workspace.mjs";
import {
  claudeOptions,
  createTrackedSpawner,
  inspectClaudeInstallation,
  processIsAlive,
  waitFor,
  withTimeout,
} from "./runtime.mjs";

export async function runWarmScenario({ repositoryRoot }) {
  const workspace = createProbeWorkspace(repositoryRoot, "inspect", "warm-no-prompt");
  try {
    const { executable } = inspectClaudeInstallation();
    const { getSessionInfo, startup } = await import("@anthropic-ai/claude-agent-sdk");
    const sessionId = randomUUID();
    const before = await getSessionInfo(sessionId, { dir: workspace.cwd });
    const tracker = createTrackedSpawner();
    const warm = await withTimeout(
      startup({
        initializeTimeoutMs: 30_000,
        options: {
          ...claudeOptions({ cwd: workspace.cwd, executable, sessionId }),
          spawnClaudeCodeProcess: tracker.spawnClaudeCodeProcess,
        },
      }),
      35_000,
      "Claude SDK startup",
    );
    const during = await getSessionInfo(sessionId, { dir: workspace.cwd });
    warm.close();
    await warm[Symbol.asyncDispose]?.();
    const processesExited = await waitFor(
      () => tracker.processes.every(({ pid }) => !processIsAlive(pid)),
      { timeoutMs: 5_000 },
    );
    const after = await getSessionInfo(sessionId, { dir: workspace.cwd });
    const checks = {
      startupSucceeded: true,
      noSessionBefore: before === undefined,
      noSessionDuring: during === undefined,
      noSessionAfterClose: after === undefined,
      oneProcessOwned: tracker.processes.length === 1,
      processExited: processesExited,
    };
    return scenarioResult({
      id: "warm-no-prompt",
      profile: "inspect",
      required: true,
      status: scenarioStatus(checks),
      checks,
      facts: { processCount: tracker.processes.length },
    });
  } catch (error) {
    return scenarioResult({
      id: "warm-no-prompt",
      profile: "inspect",
      required: true,
      status: "BLOCKED",
      checks: {},
      facts: {},
      blocker: {
        category: error?.code === "CLAUDE_NOT_FOUND" ? "installation" : "launch",
        resolution: "Verify Claude Code startup and local authentication",
      },
    });
  } finally {
    removeSyntheticProject(workspace);
  }
}
