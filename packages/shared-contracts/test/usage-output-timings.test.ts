import { expect, it } from "vitest";
import { mergeUsageOutputTimings, usageMeasurementsSchema } from "@codexhost/shared-contracts";

const timing = {
  version: 3 as const,
  requestId: "request",
  turnId: "turn",
  outputTokens: 100,
  startedAtMs: 1000,
  completedAtMs: 2000,
};

it("validates completed output intervals independently of latest display measurements", () => {
  expect(usageMeasurementsSchema.parse({ outputTimings: [timing] })).toEqual({
    outputTimings: [timing],
  });
  expect(
    usageMeasurementsSchema.parse({
      outputTokensPerSecond: { version: 3, value: 40, turnId: "turn", at: 2000 },
    }),
  ).not.toHaveProperty("outputTimings");
  for (const invalid of [
    { ...timing, outputTokens: -1 },
    { ...timing, startedAtMs: 1000.5 },
    { ...timing, completedAtMs: 1000 },
    { ...timing, requestId: "" },
    { ...timing, turnId: "" },
    { ...timing, running: true },
  ])
    expect(usageMeasurementsSchema.safeParse({ outputTimings: [invalid] }).success).toBe(false);
});

it("drops legacy speed without discarding independent latency or accepting a fake zero", () => {
  const latency = { value: 900, turnId: "turn", at: 2000 };
  const snapshot = usageMeasurementsSchema.parse({
    outputTokensPerSecond: { value: 432500, turnId: "turn", at: 2000 },
    timeToFirstOutputMs: latency,
  });
  expect(snapshot.outputTokensPerSecond).toBeUndefined();
  expect(snapshot.timeToFirstOutputMs).toEqual(latency);
  expect(
    usageMeasurementsSchema.parse({
      outputTokensPerSecond: { version: 3, value: 0, turnId: "turn", at: 2000 },
    }).outputTokensPerSecond?.value,
  ).toBe(0);
});

it("drops pre-fix speeds and intervals while retaining independent TTFT", () => {
  const oldTiming = { ...timing, version: undefined };
  const latency = { value: 900, turnId: "turn", at: 2000 };
  const parsed = usageMeasurementsSchema.parse({
    outputTokensPerSecond: { version: 2, value: 120, turnId: "turn", at: 2000 },
    outputTimings: [oldTiming, { ...timing, requestId: "new" }],
    timeToFirstOutputMs: latency,
  });
  expect(parsed.outputTokensPerSecond).toBeUndefined();
  expect(parsed.outputTimings).toEqual([{ ...timing, requestId: "new" }]);
  expect(parsed.timeToFirstOutputMs).toEqual(latency);
});

it("deduplicates concurrent observations deterministically using the earliest completion", () => {
  const delayed = { ...timing, completedAtMs: 2100 };
  expect(mergeUsageOutputTimings([delayed], [timing])).toEqual([timing]);
  expect(mergeUsageOutputTimings([timing], [delayed])).toEqual([timing]);
  expect(mergeUsageOutputTimings([timing], [timing])).toEqual([timing]);
});
