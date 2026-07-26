const DEFINITIONS = [
  ["startup-shutdown", true, ["isolated-control-plane"]],
  ["stream", true, ["native-live-stream"]],
  ["tool", true, ["native-live-tool"]],
  ["question", true, ["extension-interactions", "native-live-question"]],
  ["cancel", true, ["native-live-cancel"]],
  ["history-resume", true, ["native-live-history", "native-live-native-append"]],
  ["stable-turn-ref", true, ["native-live-history", "native-live-native-append"]],
  ["model-switch", true, ["native-live-model-switch"]],
  ["precise-fork", true, ["native-live-fork"]],
  ["approval", false, ["native-live-question"]],
  ["reasoning", false, ["native-live-stream"]],
  ["reliable-edit-patch", false, ["native-live-tool"]],
];

export function deriveCapabilities(scenarios) {
  const byId = new Map(scenarios.map((scenario) => [scenario.id, scenario]));
  return DEFINITIONS.map(([id, required, scenarioIds]) => {
    const evidence = scenarioIds.filter((scenarioId) => byId.has(scenarioId));
    const observed = evidence.map((scenarioId) => byId.get(scenarioId));
    let status = "not-observed";
    if (observed.some((scenario) => scenario.status === "BLOCKED")) status = "blocked";
    else if (observed.some((scenario) => scenario.status === "FAIL")) status = "unsupported";
    else if (
      observed.length === scenarioIds.length &&
      observed.every((scenario) => scenario.status === "PASS")
    ) {
      status = "supported";
    }
    if (id === "approval" && observed.length > 0) {
      status = observed.some(({ checks }) => checks.nativeApprovalObserved)
        ? "supported"
        : "not-observed";
    }
    if (id === "reasoning" && observed.length > 0) {
      status = observed.some(({ checks }) => checks.reasoningObserved)
        ? "supported"
        : "not-observed";
    }
    if (id === "reliable-edit-patch" && observed.length > 0) {
      status = observed.some(({ checks }) => checks.reliableUnifiedPatch)
        ? "supported"
        : "not-observed";
    }
    return { id, required, status, evidence };
  });
}
