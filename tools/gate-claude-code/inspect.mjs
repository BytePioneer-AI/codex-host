import { scenarioResult, scenarioStatus } from "./contracts.mjs";
import { assertTrackedSummarySafe } from "./privacy.mjs";
import { inspectClaudeInstallation } from "./runtime.mjs";

function blockerFor(error) {
  const installation = error?.code === "CLAUDE_NOT_FOUND";
  return {
    category: installation ? "installation" : "launch",
    resolution: installation
      ? "Install Claude Code or set CODEXHOST_CLAUDE_COMMAND"
      : "Run Claude Code version and auth diagnostics locally",
  };
}

export function runInspectScenario() {
  try {
    const inspection = inspectClaudeInstallation();
    const checks = {
      versionParsed: /^\d+\.\d+\.\d+$/u.test(inspection.summary.cliVersion),
      sdkVersionParsed: /^\d+\.\d+\.\d+$/u.test(inspection.summary.sdkVersion),
      sdkCliCompatibilityMatched:
        inspection.summary.cliVersion === inspection.summary.claudeCodeVersion,
      authenticationAvailable: inspection.summary.auth.loggedIn,
    };
    const result = scenarioResult({
      id: "inspect-installation-auth",
      profile: "inspect",
      required: true,
      status: scenarioStatus(checks),
      checks,
      facts: {
        commandSource: inspection.summary.commandSource,
        cliVersion: inspection.summary.cliVersion,
        sdkVersion: inspection.summary.sdkVersion,
        sdkClaudeCodeVersion: inspection.summary.claudeCodeVersion,
        authAvailable: inspection.summary.auth.loggedIn,
        authMethod: inspection.summary.auth.authMethod,
        apiProvider: inspection.summary.auth.apiProvider,
      },
    });
    assertTrackedSummarySafe(result);
    return { result, inspection };
  } catch (error) {
    const result = scenarioResult({
      id: "inspect-installation-auth",
      profile: "inspect",
      required: true,
      status: "BLOCKED",
      checks: {},
      facts: {},
      blocker: blockerFor(error),
    });
    return { result, error };
  }
}
