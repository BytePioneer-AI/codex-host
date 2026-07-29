import { randomUUID } from "node:crypto";

import { scenarioResult, scenarioStatus } from "./contracts.mjs";
import { collectQuery, writeRawScenario } from "./live-helpers.mjs";
import { claudeOptions } from "./runtime.mjs";
import { createProbeWorkspace, removeSyntheticProject } from "./workspace.mjs";

async function queryWithSources({ executable, workspace, settingSources }) {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const activeQuery = query({
    prompt: "Reply with exactly AUTH_SOURCE_READY. Do not use tools.",
    options: {
      ...claudeOptions({
        cwd: workspace.cwd,
        executable,
        sessionId: randomUUID(),
        settingSources,
      }),
      maxTurns: 1,
      maxBudgetUsd: 0.05,
    },
  });
  try {
    return await collectQuery(activeQuery);
  } catch (error) {
    return {
      messages: [],
      summary: {
        terminal: { outcome: "failed", reason: "authentication_exception" },
        resultCount: 0,
      },
      error: {
        name: error instanceof Error ? error.name : "UnknownError",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

export async function runAuthSourcesScenario({ repositoryRoot, executable }) {
  const workspace = createProbeWorkspace(repositoryRoot, "live", "auth-setting-sources");
  try {
    const empty = await queryWithSources({ executable, workspace, settingSources: [] });
    const user = await queryWithSources({ executable, workspace, settingSources: ["user"] });
    const authenticated = user.summary.terminal.outcome === "succeeded";
    const checks = {
      userSourceAuthenticated: authenticated,
      emptySourceClassified: empty.summary.terminal.outcome !== "invalid",
    };
    const facts = {
      emptySourceOutcome: empty.summary.terminal.outcome,
      emptySourceReason: empty.summary.terminal.reason,
      userSourceOutcome: user.summary.terminal.outcome,
    };
    const result = scenarioResult({
      id: "live-auth-setting-sources",
      profile: "live",
      required: true,
      status: authenticated ? scenarioStatus(checks) : "BLOCKED",
      checks: authenticated ? checks : {},
      facts,
      ...(!authenticated
        ? {
            blocker: {
              category: "authentication",
              resolution: "Restore working Claude Code authentication and rerun the Live profile",
            },
          }
        : {}),
    });
    writeRawScenario(repositoryRoot, workspace, "auth-setting-sources", {
      empty,
      user,
      result,
    });
    return result;
  } finally {
    removeSyntheticProject(workspace);
  }
}
