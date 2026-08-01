import { describe, expect, it } from "vitest";

import { runModelSwitchScenario } from "./model-live.mjs";
import { summarizeRuntimeModels } from "./models.mjs";
import { assertTrackedSummarySafe } from "./privacy.mjs";

const repositoryRoot = new URL("../..", import.meta.url).pathname;

describe("Claude runtime Model Gates", () => {
  it("summarizes alias/default/custom relationships without Model names", () => {
    const summary = summarizeRuntimeModels(
      [
        { value: "default", displayName: "Default", resolvedModel: "runtime-custom" },
        { value: "family", displayName: "Family", resolvedModel: "runtime-custom" },
        {
          value: "custom",
          displayName: "Custom",
          resolvedModel: "runtime-custom",
          supportedEffortLevels: ["low", "high"],
          account: "private",
        },
      ],
      "runtime-custom",
      true,
    );

    expect(summary).toEqual({
      checks: {
        catalogNonEmpty: true,
        rowsStructured: true,
        selectableValuesUnique: true,
        defaultPresent: true,
        actualModelReadbackAvailable: true,
        setterAvailable: true,
      },
      facts: {
        modelCount: 3,
        defaultCount: 1,
        resolvedCount: 3,
        sharedResolutionGroups: 1,
        effortRows: 1,
        currentMatchesKnownResolution: true,
      },
    });
    expect(JSON.stringify(summary)).not.toContain("runtime-custom");
    expect(assertTrackedSummarySafe(summary)).toBe(summary);
  });

  it("fails structural checks for malformed or duplicate runtime rows", () => {
    expect(
      summarizeRuntimeModels(
        [
          { value: "same", displayName: "First" },
          { value: "same", displayName: "Second" },
        ],
        undefined,
        false,
      ).checks,
    ).toMatchObject({
      selectableValuesUnique: false,
      defaultPresent: false,
      actualModelReadbackAvailable: false,
      setterAvailable: false,
    });
  });

  it("keeps the quota-using switch Gate blocked without explicit opt-in", async () => {
    const prior = process.env.CODEXHOST_CLAUDE_LIVE;
    delete process.env.CODEXHOST_CLAUDE_LIVE;
    try {
      await expect(runModelSwitchScenario({ repositoryRoot })).resolves.toMatchObject({
        status: "BLOCKED",
        blocker: { category: "quota" },
      });
    } finally {
      if (prior === undefined) delete process.env.CODEXHOST_CLAUDE_LIVE;
      else process.env.CODEXHOST_CLAUDE_LIVE = prior;
    }
  });
});
