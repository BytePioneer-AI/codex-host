import { randomUUID } from "node:crypto";

import { scenarioResult, scenarioStatus } from "./contracts.mjs";
import { collectTurn, PushableInput, sdkUserMessage } from "./live-helpers.mjs";
import { assertTrackedSummarySafe } from "./privacy.mjs";
import { claudeOptions, closeQuery, inspectClaudeInstallation } from "./runtime.mjs";
import { createProbeWorkspace, removeSyntheticProject } from "./workspace.mjs";

function succeeded(turn) {
  return turn.summary.resultCount === 1 && turn.summary.terminal.outcome === "succeeded";
}

function blocked(resolution) {
  return scenarioResult({
    id: "live-runtime-model-switch",
    profile: "live",
    required: true,
    status: "BLOCKED",
    checks: {},
    facts: {},
    blocker: { category: "quota", resolution },
  });
}

export async function runModelSwitchScenario({ repositoryRoot }) {
  if (process.env.CODEXHOST_CLAUDE_LIVE !== "1") {
    return blocked("Set CODEXHOST_CLAUDE_LIVE=1 after reviewing model quota effects");
  }
  const firstSelection = process.env.CODEXHOST_CLAUDE_MODEL_A;
  const secondSelection = process.env.CODEXHOST_CLAUDE_MODEL_B;
  if (!firstSelection || !secondSelection || firstSelection === secondSelection) {
    return blocked("Set two distinct callable selectable values in CODEXHOST_CLAUDE_MODEL_A/B");
  }

  const workspace = createProbeWorkspace(repositoryRoot, "live", "runtime-model-switch");
  const input = new PushableInput();
  let activeQuery;
  try {
    const { executable } = inspectClaudeInstallation();
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const sessionId = randomUUID();
    activeQuery = query({
      prompt: input,
      options: {
        ...claudeOptions({ cwd: workspace.cwd, executable, sessionId }),
        model: firstSelection,
        tools: [],
        maxTurns: 2,
        maxBudgetUsd: 0.2,
      },
    });
    await activeQuery.initializationResult();
    const firstBefore = await activeQuery.getContextUsage();
    input.push(sdkUserMessage(sessionId, "Reply with exactly OK.", randomUUID()));
    const firstTurn = await collectTurn(activeQuery);
    const firstAfter = await activeQuery.getContextUsage();

    await activeQuery.setModel(secondSelection);
    const secondBefore = await activeQuery.getContextUsage();
    input.push(sdkUserMessage(sessionId, "Reply with exactly OK.", randomUUID()));
    const secondTurn = await collectTurn(activeQuery);
    const secondAfter = await activeQuery.getContextUsage();

    const firstActual = firstAfter?.model ?? firstBefore?.model;
    const secondActual = secondAfter?.model ?? secondBefore?.model;
    const checks = {
      firstTurnCallable: succeeded(firstTurn),
      secondTurnCallable: succeeded(secondTurn),
      firstActualReadable: typeof firstActual === "string" && firstActual.length > 0,
      secondActualReadable: typeof secondActual === "string" && secondActual.length > 0,
      actualModelsDiffer: firstActual !== secondActual,
    };
    const result = scenarioResult({
      id: "live-runtime-model-switch",
      profile: "live",
      required: true,
      status: scenarioStatus(checks),
      checks,
      facts: {
        firstEventCount: firstTurn.messages.length,
        secondEventCount: secondTurn.messages.length,
        actualModelsDistinct: firstActual !== secondActual,
      },
    });
    assertTrackedSummarySafe(result);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message.toLowerCase() : "";
    if (message.includes("auth") || message.includes("not logged in")) {
      return scenarioResult({
        id: "live-runtime-model-switch",
        profile: "live",
        required: true,
        status: "BLOCKED",
        checks: {},
        facts: {},
        blocker: {
          category: "authentication",
          resolution: "Restore Claude Code authentication and rerun the Model live Gate",
        },
      });
    }
    return scenarioResult({
      id: "live-runtime-model-switch",
      profile: "live",
      required: true,
      status: "FAIL",
      checks: { modelSwitchCompleted: false },
      facts: {},
    });
  } finally {
    input.end();
    if (activeQuery) await closeQuery(activeQuery).catch(() => undefined);
    removeSyntheticProject(workspace);
  }
}
