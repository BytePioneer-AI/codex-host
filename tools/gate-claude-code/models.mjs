import { randomUUID } from "node:crypto";

import { scenarioResult, scenarioStatus } from "./contracts.mjs";
import { PushableInput } from "./live-helpers.mjs";
import { assertTrackedSummarySafe } from "./privacy.mjs";
import {
  CLIENT_APP,
  closeQuery,
  createTrackedSpawner,
  inspectClaudeInstallation,
  processIsAlive,
  waitFor,
  withTimeout,
} from "./runtime.mjs";
import { createProbeWorkspace, removeSyntheticProject } from "./workspace.mjs";

function nonBlank(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function summarizeRuntimeModels(models, currentModel, setModelAvailable) {
  const rows = Array.isArray(models) ? models : [];
  const structured = rows.every(
    (row) =>
      row !== null && typeof row === "object" && nonBlank(row.value) && nonBlank(row.displayName),
  );
  const values = rows.flatMap((row) => (nonBlank(row?.value) ? [row.value] : []));
  const resolved = rows.flatMap((row) => (nonBlank(row?.resolvedModel) ? [row.resolvedModel] : []));
  const resolutionCounts = new Map();
  for (const value of resolved) resolutionCounts.set(value, (resolutionCounts.get(value) ?? 0) + 1);
  const knownActual = new Set([...values, ...resolved]);
  const checks = {
    catalogNonEmpty: rows.length > 0,
    rowsStructured: structured,
    selectableValuesUnique: values.length === rows.length && new Set(values).size === values.length,
    defaultPresent: values.includes("default"),
    actualModelReadbackAvailable: nonBlank(currentModel),
    setterAvailable: setModelAvailable === true,
  };
  return {
    checks,
    facts: {
      modelCount: rows.length,
      defaultCount: values.filter((value) => value === "default").length,
      resolvedCount: resolved.length,
      sharedResolutionGroups: [...resolutionCounts.values()].filter((count) => count > 1).length,
      effortRows: rows.filter(
        (row) => Array.isArray(row?.supportedEffortLevels) && row.supportedEffortLevels.length > 0,
      ).length,
      currentMatchesKnownResolution: nonBlank(currentModel) && knownActual.has(currentModel),
    },
  };
}

function blockedResult(category, resolution) {
  return scenarioResult({
    id: "inspect-runtime-model-catalog",
    profile: "inspect",
    required: true,
    status: "BLOCKED",
    checks: {},
    facts: {},
    blocker: { category, resolution },
  });
}

export async function runModelCatalogScenario({ repositoryRoot }) {
  const workspace = createProbeWorkspace(repositoryRoot, "inspect", "runtime-model-catalog");
  const input = new PushableInput();
  let activeQuery;
  let tracker;
  try {
    const { executable } = inspectClaudeInstallation();
    const { getSessionInfo, query } = await import("@anthropic-ai/claude-agent-sdk");
    const sessionId = randomUUID();
    const before = await getSessionInfo(sessionId, { dir: workspace.cwd });
    tracker = createTrackedSpawner();
    activeQuery = query({
      prompt: input,
      options: {
        cwd: workspace.cwd,
        sessionId,
        pathToClaudeCodeExecutable: executable,
        settingSources: ["user"],
        permissionMode: "default",
        tools: [],
        persistSession: false,
        includePartialMessages: false,
        env: {
          ...process.env,
          CLAUDE_AGENT_SDK_CLIENT_APP: CLIENT_APP,
        },
        spawnClaudeCodeProcess: tracker.spawnClaudeCodeProcess,
      },
    });
    const initialized = await withTimeout(
      activeQuery.initializationResult(),
      35_000,
      "Claude Model initialization",
    );
    const context = await withTimeout(
      activeQuery.getContextUsage(),
      15_000,
      "Claude actual Model readback",
    );
    const summarized = summarizeRuntimeModels(
      initialized.models,
      context?.model,
      typeof activeQuery.setModel === "function",
    );
    input.end();
    await closeQuery(activeQuery);
    activeQuery = undefined;
    const processesExited = await waitFor(
      () => tracker.processes.every(({ pid }) => !processIsAlive(pid)),
      { timeoutMs: 5_000 },
    );
    const after = await getSessionInfo(sessionId, { dir: workspace.cwd });
    const checks = {
      ...summarized.checks,
      noSessionBefore: before === undefined,
      noSessionAfterClose: after === undefined,
      oneProcessOwned: tracker.processes.length === 1,
      processExited: processesExited,
    };
    const result = scenarioResult({
      id: "inspect-runtime-model-catalog",
      profile: "inspect",
      required: true,
      status: scenarioStatus(checks),
      checks,
      facts: { ...summarized.facts, processCount: tracker.processes.length },
    });
    assertTrackedSummarySafe(result);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message.toLowerCase() : "";
    if (error?.code === "CLAUDE_NOT_FOUND") {
      return blockedResult("installation", "Install Claude Code or set CODEXHOST_CLAUDE_COMMAND");
    }
    if (message.includes("auth") || message.includes("not logged in")) {
      return blockedResult("authentication", "Restore Claude Code authentication and rerun");
    }
    return scenarioResult({
      id: "inspect-runtime-model-catalog",
      profile: "inspect",
      required: true,
      status: "FAIL",
      checks: { runtimeCatalogCompleted: false },
      facts: {},
    });
  } finally {
    input.end();
    if (activeQuery) await closeQuery(activeQuery).catch(() => undefined);
    for (const child of tracker?.processes ?? []) {
      if (processIsAlive(child.pid)) child.kill("SIGTERM");
    }
    await waitFor(() => (tracker?.processes ?? []).every(({ pid }) => !processIsAlive(pid)), {
      timeoutMs: 5_000,
    }).catch(() => false);
    for (const child of tracker?.processes ?? []) {
      if (processIsAlive(child.pid)) child.kill("SIGKILL");
    }
    removeSyntheticProject(workspace);
  }
}
