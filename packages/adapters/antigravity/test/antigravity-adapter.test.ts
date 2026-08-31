import { accountCreditsSnapshotSchema } from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";

import {
  antigravityToolErrorMessage,
  fetchAntigravityQuota,
  isAntigravityPermissionDenial,
  parseAntigravityContextUsage,
  parseAntigravityModels,
  parseAntigravityStreamLine,
  parseAntigravityUsageCommand,
} from "../src/index.js";

const FETCHED_AT = "2026-08-31T14:40:00.000Z";

/** Captured from `agy --print=/usage --output-format stream-json` (CLI v1.1.22). */
const USAGE_COMMAND = {
  name: "usage",
  data: {
    description: "Within each group, models share a weekly limit and a 5-hour limit.",
    groups: [
      {
        name: "Gemini Models",
        description: "Models within this group: Gemini Flash, Gemini Pro",
        buckets: [
          {
            id: "gemini-weekly",
            name: "Weekly Limit Remaining",
            window: "weekly",
            remaining_fraction: 0.9735029339790344,
            reset_time: "2026-09-01T03:17:57Z",
          },
          {
            id: "gemini-5h",
            name: "Five Hour Limit Remaining",
            window: "5h",
            remaining_fraction: 1,
            reset_time: "2026-08-31T19:38:13Z",
          },
        ],
      },
      {
        name: "Claude and GPT models",
        description: "Models within this group: Claude Opus, Claude Sonnet, GPT-OSS",
        buckets: [
          {
            id: "3p-weekly",
            name: "Weekly Limit Remaining",
            window: "weekly",
            remaining_fraction: 1,
            reset_time: "2026-09-07T14:38:13Z",
          },
        ],
      },
    ],
  },
} as const;

describe("Antigravity Adapter", () => {
  it("parses the CLI Model catalog", () => {
    expect(
      parseAntigravityModels(
        "gemini-3.7-flash-high\tGemini 3.7 Flash (High)\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\n",
      ),
    ).toMatchObject({
      models: [
        { ref: { id: "gemini-3.7-flash-high" }, label: "Gemini 3.7 Flash (High)" },
        { ref: { id: "claude-sonnet-4-6" }, label: "Claude Sonnet 4.6 (Thinking)" },
      ],
      defaultModel: { id: "gemini-3.7-flash-high" },
      thinkingOptions: [],
    });
  });

  it("accepts typed stream events and ignores terminal noise", () => {
    expect(
      parseAntigravityStreamLine(
        '{"event":"step_update","step_update":{"conversation_id":"c1","step_index":1,"state":"ACTIVE","step_type":"agent_response","text_delta":"hi"}}',
      ),
    ).toMatchObject({ event: "step_update", step_update: { text_delta: "hi" } });
    expect(parseAntigravityStreamLine("permission warning")).toBeNull();
  });

  it("parses real Language Server context metadata", () => {
    const metadata = {
      trajectory: {
        generatorMetadata: [
          {
            chatModel: {
              chatStartMetadata: {
                contextWindowMetadata: {
                  estimatedTokensUsed: 19_505,
                  maxContextTokens: 256_000,
                  tokenBreakdown: { totalTokens: 19_505 },
                },
              },
            },
          },
        ],
      },
    };
    expect(parseAntigravityContextUsage(metadata)).toEqual({
      contextUsedTokens: 19_505,
      contextWindowTokens: 256_000,
    });
    expect(parseAntigravityContextUsage(metadata, "gemini-3.7-flash-high")).toEqual({
      contextUsedTokens: 19_505,
      contextWindowTokens: 1_048_576,
    });
    expect(parseAntigravityContextUsage(metadata, "claude-sonnet-4-6")).toEqual({
      contextUsedTokens: 19_505,
      contextWindowTokens: 256_000,
    });
    expect(parseAntigravityContextUsage({ generatorMetadata: [] })).toBeNull();
  });

  it("projects the CLI /usage command into an account credits snapshot", () => {
    const snapshot = parseAntigravityUsageCommand(USAGE_COMMAND, FETCHED_AT);
    // The Gemini weekly bucket is the most consumed, so it leads the pill.
    expect(snapshot).toEqual({
      usedPercent: 2.65,
      periodType: "weekly",
      resetsAt: "2026-09-01T03:17:57Z",
      fetchedAt: FETCHED_AT,
      productUsage: [
        {
          product: "Gemini Models · Five Hour Limit Remaining",
          usagePercent: 0,
          resetsAt: "2026-08-31T19:38:13Z",
        },
        {
          product: "Claude and GPT models · Weekly Limit Remaining",
          usagePercent: 0,
          resetsAt: "2026-09-07T14:38:13Z",
        },
      ],
    });
  });

  it("keeps the quota snapshot valid against the Host credits contract", () => {
    const snapshot = parseAntigravityUsageCommand(USAGE_COMMAND, FETCHED_AT);
    expect(snapshot).not.toBeNull();
    // The Host strips `fetchedAt` before validating against the strict schema.
    const rest: Record<string, unknown> = { ...(snapshot as NonNullable<typeof snapshot>) };
    delete rest.fetchedAt;
    expect(accountCreditsSnapshotSchema.safeParse(rest).success).toBe(true);
  });

  it("rejects payloads that are not a /usage command result", () => {
    expect(parseAntigravityUsageCommand({ name: "credits", data: {} })).toBeNull();
    expect(parseAntigravityUsageCommand({ name: "usage", data: { groups: [] } })).toBeNull();
    expect(
      parseAntigravityUsageCommand({ name: "usage", data: { groups: [{ buckets: [{}] }] } }),
    ).toBeNull();
  });

  it("reads quota from the dedicated --print=/usage invocation", async () => {
    const calls: string[][] = [];
    const stdout = [
      JSON.stringify({ event: "command_result", command: USAGE_COMMAND }),
      JSON.stringify({
        event: "result",
        result: { conversation_id: "", status: "SUCCESS", num_turns: 0 },
      }),
    ].join("\n");
    const snapshot = await fetchAntigravityQuota((arguments_) => {
      calls.push([...arguments_]);
      return Promise.resolve(stdout);
    }, new Date(FETCHED_AT));
    expect(calls).toEqual([["--print=/usage", "--output-format", "stream-json"]]);
    expect(snapshot).toMatchObject({ usedPercent: 2.65, periodType: "weekly" });
  });

  it("degrades to null when the CLI cannot answer /usage", async () => {
    await expect(
      fetchAntigravityQuota(() => Promise.reject(new Error("agy is not installed"))),
    ).resolves.toBeNull();
    await expect(fetchAntigravityQuota(() => Promise.resolve("not json"))).resolves.toBeNull();
  });

  it("recognises the headless permission denial the CLI reports as a tool error", () => {
    const denial =
      'permission check failed for command "Get-Location": user denied permission to run command:\nGet-Location';
    expect(antigravityToolErrorMessage({ type: "TOOL_ERROR", message: denial })).toBe(denial);
    expect(isAntigravityPermissionDenial(denial)).toBe(true);
    expect(antigravityToolErrorMessage({ type: "TOOL_ERROR" })).toBeNull();
    expect(isAntigravityPermissionDenial("file not found")).toBe(false);
  });
});
