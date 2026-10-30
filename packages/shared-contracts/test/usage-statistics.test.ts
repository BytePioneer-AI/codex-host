import { describe, expect, it } from "vitest";
import { usageStatisticsParamsSchema } from "../src/usage-statistics.js";

describe("usage statistics query timezone", () => {
  it.each(["UTC", "Asia/Shanghai", "America/New_York", "Asia/Kathmandu"])(
    "accepts the display timezone %s",
    (timeZone) => {
      expect(usageStatisticsParamsSchema.parse({ range: "today", timeZone })).toEqual({
        range: "today",
        timeZone,
      });
    },
  );

  it.each(["", "not/a-timezone", "x".repeat(129), null, 480])(
    "rejects an invalid timezone %j instead of silently using the Host zone",
    (timeZone) => {
      expect(usageStatisticsParamsSchema.safeParse({ range: "today", timeZone }).success).toBe(
        false,
      );
    },
  );

  it("retains the legacy query without a timezone", () => {
    expect(usageStatisticsParamsSchema.parse({ range: "today" })).toEqual({ range: "today" });
  });
});
