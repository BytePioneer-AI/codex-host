import os from "node:os";
import path from "node:path";

import { deriveCapabilities } from "./capabilities.mjs";
import {
  CLAUDE_PROBE_SCHEMA_VERSION,
  overallStatus,
  probeReportSchema,
  scenarioResult,
} from "./contracts.mjs";
import { runInspectScenario } from "./inspect.mjs";
import { runAuthSourcesScenario } from "./live-auth.mjs";
import {
  runInteractionCancelScenario,
  runStreamingCancelScenario,
  runToolCancelScenario,
} from "./live-cancel.mjs";
import { runTextHistoryScenarios } from "./live-text.mjs";
import { runQuestionScenario, runToolEditScenario } from "./live-tools.mjs";
import { assertTrackedSummarySafe } from "./privacy.mjs";
import { runWarmScenario } from "./warm.mjs";
import { writeLocalJson } from "./workspace.mjs";

const SCENARIOS = new Set(["auth", "text", "tool", "question", "cancel", "interaction-cancel"]);

function scenarioFailure(id, error) {
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  const blockedCodes = new Set(["CLAUDE_NOT_FOUND", "CLAUDE_COMMAND_FAILED"]);
  const authenticationBlocked =
    message.includes("not logged in") ||
    message.includes("invalid api key") ||
    message.includes("authentication");
  const blocked = blockedCodes.has(error?.code) || authenticationBlocked;
  return scenarioResult({
    id: `live-${id}`,
    profile: "live",
    required: true,
    status: blocked ? "BLOCKED" : "FAIL",
    checks: blocked ? {} : { scenarioCompleted: false },
    facts: {},
    ...(blocked
      ? {
          blocker: {
            category:
              error?.code === "CLAUDE_NOT_FOUND"
                ? "installation"
                : authenticationBlocked
                  ? "authentication"
                  : "launch",
            resolution: authenticationBlocked
              ? "Restore working Claude Code authentication and rerun the Live profile"
              : "Resolve the local Claude Code diagnostic before rerunning Live",
          },
        }
      : {}),
  });
}

async function runSelected(id, context) {
  try {
    switch (id) {
      case "auth":
        return [await runAuthSourcesScenario(context)];
      case "text":
        return await runTextHistoryScenarios(context);
      case "tool":
        return [await runToolEditScenario(context)];
      case "question":
        return [await runQuestionScenario(context)];
      case "cancel":
        return [await runStreamingCancelScenario(context), await runToolCancelScenario(context)];
      case "interaction-cancel":
        return [await runInteractionCancelScenario(context)];
      default:
        throw new Error(`unknown Claude Live scenario '${id}'`);
    }
  } catch (error) {
    console.error(`[gate:claude] ${id} failed: ${error instanceof Error ? error.message : error}`);
    return [scenarioFailure(id, error)];
  }
}

export async function runLiveProfile({ repositoryRoot, scenario = "all" }) {
  if (process.env.CODEXHOST_CLAUDE_LIVE !== "1") {
    throw new Error(
      "Claude Live is disabled; set CODEXHOST_CLAUDE_LIVE=1 after reviewing quota and native Session effects",
    );
  }
  if (scenario !== "all" && !SCENARIOS.has(scenario)) {
    throw new Error(`unknown Claude Live scenario '${scenario}'`);
  }

  console.error("[gate:claude] Live may use network/model quota and persist native Sessions.");
  console.error(
    "[gate:claude] Prompts, model text, complete IDs, and native paths stay in .codexhost/.",
  );
  const inspected = runInspectScenario();
  if (inspected.result.status !== "PASS") {
    return {
      status: inspected.result.status,
      scenarios: [inspected.result],
      capabilities: deriveCapabilities([inspected.result]),
    };
  }

  const selected = scenario === "all" ? [...SCENARIOS] : [scenario];
  const scenarios = [await runWarmScenario({ repositoryRoot })];
  if (scenarios[0].status !== "PASS") {
    console.error("[gate:claude] Live scenarios skipped because Warm did not pass.");
  }
  for (const id of scenarios[0].status === "PASS" ? selected : []) {
    const observed = await runSelected(id, {
      repositoryRoot,
      executable: inspected.inspection.executable,
    });
    scenarios.push(...observed);
    if (id === "auth" && observed.some(({ status }) => status === "BLOCKED")) break;
  }
  const summary = inspected.inspection.summary;
  const report = probeReportSchema.parse({
    schemaVersion: CLAUDE_PROBE_SCHEMA_VERSION,
    gate: "claude-code-adapter-semantics",
    status: overallStatus(scenarios),
    platform: process.platform,
    architecture: os.arch(),
    commandSource: summary.commandSource,
    sdkVersion: summary.sdkVersion,
    sdkClaudeCodeVersion: summary.claudeCodeVersion,
    cliVersion: summary.cliVersion,
    scenarios,
    capabilities: deriveCapabilities(scenarios),
  });
  assertTrackedSummarySafe(report);
  writeLocalJson(
    repositoryRoot,
    path.join(
      repositoryRoot,
      ".codexhost",
      "claude-code-probe",
      `${process.platform}-${os.arch()}`,
      "reports",
      `live-${scenario}.local.json`,
    ),
    report,
  );
  return report;
}
