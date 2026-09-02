import { describe, expect, it } from "vitest";

import { parseOmniRouteCredits, type OmniRouteStorageData } from "../src/omp-credits.js";

describe("OMP OmniRoute credits parsing", () => {
  it("parses pooled Antigravity (agy) quotas into AccountCreditsSnapshot", () => {
    const data: OmniRouteStorageData = {
      connections: [
        { id: "conn-1", provider: "agy", isActive: true, email: "user1@example.com" },
        { id: "conn-2", provider: "agy", isActive: true, email: "user2@example.com" },
      ],
      caches: {
        "conn-1": {
          quotas: {
            "gemini-3.7-flash-tiered": {
              used: 200,
              total: 1000,
              remainingPercentage: 80,
              resetAt: "2026-08-31T16:00:00.000Z",
            },
            "claude-sonnet-4-6": {
              used: 100,
              total: 1000,
              remainingPercentage: 90,
              resetAt: "2026-08-31T17:00:00.000Z",
            },
          },
        },
        "conn-2": {
          quotas: {
            "gemini-3.7-flash-tiered": {
              used: 0,
              total: 1000,
              remainingPercentage: 100,
              resetAt: "2026-08-31T16:30:00.000Z",
            },
            "claude-sonnet-4-6": {
              used: 0,
              total: 1000,
              remainingPercentage: 100,
              resetAt: "2026-08-31T17:30:00.000Z",
            },
          },
        },
      },
    };

    const credits = parseOmniRouteCredits(data);
    expect(credits).toEqual({
      usedPercent: 10,
      periodType: "five_hour",
      resetsAt: "2026-08-31T16:00:00.000Z",
      productUsage: [
        {
          product: "Gemini Flash (5h)",
          usagePercent: 10,
          resetsAt: "2026-08-31T16:00:00.000Z",
          accounts: [
            {
              accountName: "user1@example.com",
              usagePercent: 20,
              resetsAt: "2026-08-31T16:00:00.000Z",
            },
            {
              accountName: "user2@example.com",
              usagePercent: 0,
              resetsAt: "2026-08-31T16:30:00.000Z",
            },
          ],
        },
        {
          product: "Claude (5h)",
          usagePercent: 5,
          resetsAt: "2026-08-31T17:00:00.000Z",
          accounts: [
            {
              accountName: "user1@example.com",
              usagePercent: 10,
              resetsAt: "2026-08-31T17:00:00.000Z",
            },
            {
              accountName: "user2@example.com",
              usagePercent: 0,
              resetsAt: "2026-08-31T17:30:00.000Z",
            },
          ],
        },
      ],
    });
  });

  it("parses Grok Build quotas", () => {
    const data: OmniRouteStorageData = {
      connections: [
        { id: "conn-grok", provider: "grok-cli", isActive: true, email: "grok@example.com" },
      ],
      caches: {
        "conn-grok": {
          quotas: {
            weekly: {
              used: 44,
              total: 100,
              resetAt: "2026-09-04T05:00:00.000Z",
            },
            product_grok_build: {
              used: 43,
              total: 100,
              resetAt: "2026-09-04T05:00:00.000Z",
            },
            product_grokchat: {
              used: 1,
              total: 100,
              resetAt: "2026-09-04T05:00:00.000Z",
            },
          },
        },
      },
    };

    const credits = parseOmniRouteCredits(data);
    expect(credits).toEqual({
      usedPercent: 44,
      periodType: "weekly",
      resetsAt: "2026-09-04T05:00:00.000Z",
      productUsage: [
        {
          product: "Grok Build",
          usagePercent: 43,
          resetsAt: "2026-09-04T05:00:00.000Z",
          accounts: [
            {
              accountName: "grok@example.com",
              usagePercent: 43,
              resetsAt: "2026-09-04T05:00:00.000Z",
            },
          ],
        },
      ],
    });
  });

  it("parses Codex 5h and 7d quotas", () => {
    const data: OmniRouteStorageData = {
      connections: [
        { id: "conn-codex", provider: "codex", isActive: true, email: "codex@example.com" },
      ],
      caches: {
        "conn-codex": {
          quotas: {
            session: {
              used: 25,
              total: 100,
              resetAt: "2026-08-31T16:00:00.000Z",
            },
            weekly: {
              used: 15,
              total: 100,
              resetAt: "2026-09-07T11:00:00.000Z",
            },
          },
        },
      },
    };

    const credits = parseOmniRouteCredits(data);
    expect(credits).toEqual({
      usedPercent: 25,
      periodType: "five_hour",
      resetsAt: "2026-08-31T16:00:00.000Z",
      productUsage: [
        {
          product: "Codex (5h)",
          usagePercent: 25,
          resetsAt: "2026-08-31T16:00:00.000Z",
          accounts: [
            {
              accountName: "codex@example.com",
              usagePercent: 25,
              resetsAt: "2026-08-31T16:00:00.000Z",
            },
          ],
        },
        {
          product: "Codex (7d)",
          usagePercent: 15,
          resetsAt: "2026-09-07T11:00:00.000Z",
          accounts: [
            {
              accountName: "codex@example.com",
              usagePercent: 15,
              resetsAt: "2026-09-07T11:00:00.000Z",
            },
          ],
        },
      ],
    });
  });

  it("returns null when no active connections or quotas exist", () => {
    expect(parseOmniRouteCredits({ connections: [], caches: {} })).toBeNull();
  });
});
