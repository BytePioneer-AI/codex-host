import { describe, expect, it } from "vitest";

import { parseClaudeOmniRouteCredits, type OmniRouteStorageData } from "../src/claude-credits.js";

describe("Claude Code OmniRoute credits parsing", () => {
  it("parses pooled Antigravity (agy) Gemini Flash and Claude model quotas", () => {
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

    const credits = parseClaudeOmniRouteCredits(data);
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

  it("parses Grok and Codex quotas when configured as gateway upstream", () => {
    const data: OmniRouteStorageData = {
      connections: [
        { id: "conn-grok", provider: "grok-cli", isActive: true },
        { id: "conn-codex", provider: "codex", isActive: true },
      ],
      caches: {
        "conn-grok": {
          quotas: {
            weekly: { used: 40, total: 100, resetAt: "2026-09-04T05:00:00.000Z" },
            product_grok_build: { used: 35, total: 100, resetAt: "2026-09-04T05:00:00.000Z" },
          },
        },
        "conn-codex": {
          quotas: {
            session: { used: 10, total: 100, resetAt: "2026-08-31T16:00:00.000Z" },
          },
        },
      },
    };

    const credits = parseClaudeOmniRouteCredits(data);
    expect(credits).toEqual({
      usedPercent: 40,
      periodType: "weekly",
      resetsAt: "2026-09-04T05:00:00.000Z",
      productUsage: [
        {
          product: "Grok Build",
          usagePercent: 35,
          resetsAt: "2026-09-04T05:00:00.000Z",
          accounts: [
            {
              accountName: "Account (conn-gro)",
              usagePercent: 35,
              resetsAt: "2026-09-04T05:00:00.000Z",
            },
          ],
        },
        {
          product: "Codex (5h)",
          usagePercent: 10,
          resetsAt: "2026-08-31T16:00:00.000Z",
          accounts: [
            {
              accountName: "Account (conn-cod)",
              usagePercent: 10,
              resetsAt: "2026-08-31T16:00:00.000Z",
            },
          ],
        },
      ],
    });
  });

  it("returns null when no active connections exist", () => {
    expect(parseClaudeOmniRouteCredits({ connections: [], caches: {} })).toBeNull();
  });
});
