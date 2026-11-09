import assert from "node:assert/strict";
import { it } from "node:test";
import { defaultProjections, SessionLog } from "../src/session-log.ts";

it("does not fabricate context composition for Web sessions", () => {
  assert.equal("contextBreakdown" in defaultProjections(), false);
});

it("discards persisted placeholder composition without losing known context totals", () => {
  const pressure = { pressureTokens: 264_000, projectedTokens: 264_000, contextWindow: 1_000_000 };
  const log = new SessionLog(
    { version: 4, id: "context-test", createdAt: 0, isSeeded: false },
    {
      readLines: () => [],
      readJson: <T>() =>
        ({
          contextPressure: pressure,
          contextBreakdown: { systemTokens: 0, toolsTokens: 0, messageTokens: 0 },
        }) as T,
      writeLines: () => {},
      writeJson: () => {},
      appendLine: () => {},
    },
    () => {},
  );
  assert.equal("contextBreakdown" in log.projectionBaseline().values, false);
  assert.deepEqual(log.projections.contextPressure, pressure);
});
