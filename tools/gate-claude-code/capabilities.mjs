const DEFINITIONS = [
  ["startup-without-empty-session", true, ["warm-no-prompt"]],
  ["native-user-settings-auth", true, ["live-auth-setting-sources"]],
  ["multi-turn-stable-session", true, ["live-text-multiturn"]],
  ["caller-user-native-ref", true, ["live-text-multiturn", "live-resume"]],
  ["official-history-resume", true, ["live-resume"]],
  ["exact-context-fork", true, ["live-fork"]],
  ["tool-lifecycle", true, ["live-tool-edit"]],
  ["reliable-native-edit-patch", true, ["live-tool-edit"]],
  ["question-interaction", true, ["live-question"]],
  ["approval-interaction", true, ["live-tool-edit"]],
  ["streaming-interrupt", true, ["live-streaming-cancel"]],
  ["running-tool-interrupt", true, ["live-tool-cancel"]],
  ["pending-interaction-cancel", true, ["live-interaction-cancel"]],
  ["tool-progress", false, ["live-tool-edit", "live-tool-cancel"]],
  ["native-persistent-permission-actions", false, ["live-tool-edit"]],
];

export function deriveCapabilities(scenarios) {
  const byId = new Map(scenarios.map((scenario) => [scenario.id, scenario]));
  return DEFINITIONS.map(([id, required, scenarioIds]) => {
    const observed = scenarioIds.flatMap((scenarioId) =>
      byId.has(scenarioId) ? [byId.get(scenarioId)] : [],
    );
    let status = "not-observed";
    if (observed.some((scenario) => scenario.status === "FAIL")) status = "unsupported";
    else if (observed.some((scenario) => scenario.status === "BLOCKED")) status = "blocked";
    else if (
      observed.length === scenarioIds.length &&
      observed.every((scenario) => scenario.status === "PASS")
    ) {
      status = "supported";
    }
    if (id === "tool-progress" && observed.length > 0) {
      status = observed.some(({ facts }) => Number(facts.toolProgressCount) > 0)
        ? "supported"
        : "not-observed";
    }
    if (id === "native-persistent-permission-actions" && observed.length > 0) {
      status = observed.some(({ facts }) => Number(facts.permissionSuggestionCount) > 0)
        ? "supported"
        : "not-observed";
    }
    return { id, required, status, evidence: observed.map(({ id: scenarioId }) => scenarioId) };
  });
}
