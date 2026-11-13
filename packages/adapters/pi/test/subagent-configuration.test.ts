import { gotgenesRecord, mergeGotgenesRecord } from "../src/pi-gotgenes-subagents.js";
import { expect, it } from "vitest";
import { configureSubagentEvent } from "@codexhost/harness-adapter";
import type { HostEvent } from "@codexhost/harness-adapter";
import { hostItemIdSchema, hostTurnIdSchema } from "@codexhost/shared-contracts";
import { PiSubagents, parsePiSubagentStatus } from "../src/pi-subagents.js";

it("retains per-child Pi widget configuration across sparse updates", () => {
  const events: HostEvent[] = [];
  const tracker = new PiSubagents((event) =>
    events.push(configureSubagentEvent(event, { model: "parent", reasoningEffort: "high" })),
  );
  const runs = parsePiSubagentStatus({
    type: "extension_ui_request",
    method: "setWidget",
    widgetKey: "subagent-async",
    widgetLines: [
      "PI_SUBAGENT_ASYNC_JSON:" +
        JSON.stringify({
          version: 1,
          kind: "pi-subagents.async-status-snapshot",
          runs: [
            {
              id: "run",
              kind: "subagent",
              label: "Research",
              state: "running",
              model: "native",
              thinking: "low",
            },
          ],
        }),
    ],
  });
  expect(runs).not.toBeNull();
  if (!runs) throw new Error("Expected widget runs");
  tracker.observe(runs);
  tracker.start(
    hostTurnIdSchema.parse("turn"),
    "subagent",
    { details: { mode: "single", asyncId: "run", asyncDir: "/not-read" } },
    hostItemIdSchema.parse("call"),
  );
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "item.started",
      item: expect.objectContaining({
        subagents: [expect.objectContaining({ model: "native", reasoningEffort: "low" })],
      }),
    }),
  );
  tracker.observe([{ id: "run", kind: "subagent", label: "Research", state: "complete" }]);
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "item.updated",
      update: expect.objectContaining({
        subagents: [
          expect.objectContaining({ model: "native", reasoningEffort: "low", status: "completed" }),
        ],
      }),
    }),
  );
});

it("prefers Pi gotgenes observed model names and preserves effort through sparse receipts", () => {
  const observed = gotgenesRecord({
    id: "worker",
    type: "explorer",
    description: "Inspect",
    status: "running",
    model: "requested",
    modelName: "observed",
    thinking: "low",
  });
  const sparse = gotgenesRecord({
    id: "worker",
    type: "explorer",
    description: "Inspect",
    status: "running",
  });
  if (!observed || !sparse) throw new Error("Expected native gotgenes records");
  expect(observed.child).toMatchObject({ model: "observed", reasoningEffort: "low" });
  expect(mergeGotgenesRecord(observed, sparse).child).toMatchObject({
    model: "observed",
    reasoningEffort: "low",
  });
});
