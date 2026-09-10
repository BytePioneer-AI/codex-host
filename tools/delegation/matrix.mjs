/** Required TEST_MATRIX.md IDs and the modes they apply to. */
export const SCENARIOS = {
  "ENTRY-01": { hermetic: true, live: false, task: "T01" },
  "ENTRY-02": { hermetic: true, live: false, task: "T01" },
  "ENTRY-03": { hermetic: true, live: false, task: "T01" },
  "SMOKE-01": { hermetic: false, live: true, task: "T01" },
  "CREATION-01": { hermetic: true, live: true, task: "T02" },
  "CREATION-02": { hermetic: true, live: false, task: "T02" },
  "CREATION-03": { hermetic: true, live: false, task: "T02" },
  "RECOVERY-01": { hermetic: true, live: true, task: "T02" },
  "RECOVERY-02": { hermetic: true, live: false, task: "T02" },
  "TURN-01": { hermetic: true, live: true, task: "T03" },
  "TURN-02": { hermetic: true, live: false, task: "T03" },
  "TURN-03": { hermetic: true, live: true, task: "T03" },
  "TURN-04": { hermetic: true, live: false, task: "T03" },
  "TURN-05": { hermetic: true, live: true, task: "T03" },
  "RELEASE-01": { hermetic: true, live: true, task: "T04" },
  "RELEASE-02": { hermetic: true, live: false, task: "T04" },
  "RELEASE-03": { hermetic: true, live: false, task: "T04" },
  "RELEASE-04": { hermetic: true, live: true, task: "T04" },
  "OBSERVE-01": { hermetic: true, live: true, task: "T05" },
  "OBSERVE-02": { hermetic: true, live: false, task: "T05" },
  "OBSERVE-03": { hermetic: true, live: false, task: "T05" },
  "OBSERVE-04": { hermetic: true, live: false, task: "T05" },
  "INPUT-01": { hermetic: true, live: true, task: "T05" },
  "INPUT-02": { hermetic: true, live: false, task: "T05" },
  "EVIDENCE-01": { hermetic: true, live: true, task: "T06" },
  "EVIDENCE-02": { hermetic: true, live: false, task: "T06" },
  "EVIDENCE-03": { hermetic: true, live: false, task: "T06" },
  "EVIDENCE-04": { hermetic: true, live: true, task: "T06" },
  "SKILL-01": { hermetic: true, live: false, task: "T07" },
  "SKILL-02": { hermetic: true, live: false, task: "T07" },
  "SKILL-03": { hermetic: false, live: true, task: "T07" },
  "SKILL-04": { hermetic: false, live: true, task: "T07" },
  "FLOW-01": { hermetic: false, live: true, task: "T08" },
  "FLOW-02": { hermetic: false, live: true, task: "T08" },
  "FLOW-03": { hermetic: false, live: true, task: "T08" },
};

export function listScenarioIds() {
  return Object.keys(SCENARIOS);
}

export function expandScenarios(mode, requested) {
  if (requested.length === 1 && requested[0] === "all-required") {
    return listScenarioIds().filter((id) => SCENARIOS[id][mode]);
  }
  return requested;
}
