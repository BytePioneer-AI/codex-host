import { describe, expect, it, vi } from "vitest";
import type { Query } from "@anthropic-ai/claude-agent-sdk";
import {
  parseClaudeScopedWeeklyLimits,
  projectClaudeAccountUsage,
} from "../src/account-usage.js";
import {
  ClaudeSdkModelInspector,
  type ClaudeSdkModelInspectorOptions,
} from "../src/sdk-transport.js";

const usage = {
  subscription_type: "max",
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 25, resets_at: "2026-09-01T05:00:00Z" },
    seven_day: { utilization: 60, resets_at: "2026-09-07T00:00:00Z" },
    seven_day_sonnet: { utilization: 0, resets_at: null },
  },
};

function fixture(response: unknown = usage) {
  const close = vi.fn();
  const getUsage = vi.fn(async () => response);
  const accountInfo = vi.fn(async () => ({ email: "user@example.com" }));
  const native = {
    close,
    initializationResult: vi.fn(async () => ({})),
    accountInfo,
    usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: getUsage,
  };
  const factory = vi.fn<NonNullable<ClaudeSdkModelInspectorOptions["queryFactory"]>>(
    () => native as unknown as Query,
  );
  const inspector = new ClaudeSdkModelInspector({
    command: process.execPath,
    cwd: process.cwd(),
    environment: {},
    closeTimeoutMs: 10,
    queryFactory: factory,
  });
  return { native, getUsage, factory, inspector, close, accountInfo };
}

describe("Claude Code native account Usage", () => {
  it("actively requests SDK Usage without sending a prompt or persisting a Session, then closes", async () => {
    const f = fixture();
    expect(await f.inspector.inspectAccount()).toMatchObject({
      email: "user@example.com",
      plan: "max",
      credits: {
        usedPercent: 25,
        periodType: "five_hour",
        productUsage: [
          { product: "7-day window", usagePercent: 60 },
          { product: "Sonnet · 7-day", usagePercent: 0 },
        ],
      },
    });
    expect(f.getUsage).toHaveBeenCalledOnce();
    expect(f.factory.mock.calls[0]?.[0].options).toMatchObject({
      persistSession: false,
      tools: [],
      settingSources: ["user"],
    });
    const prompt = f.factory.mock.calls[0]?.[0].prompt;
    expect(typeof prompt).not.toBe("string");
    if (typeof prompt === "string" || !prompt) throw new Error("Expected idle SDK input");
    expect(await prompt[Symbol.asyncIterator]().next()).toEqual({ done: true, value: undefined });
    expect(f.close).toHaveBeenCalledOnce();
  });

  it("hides API/third-party sessions even if session spend is available", async () => {
    const f = fixture({
      subscription_type: null,
      rate_limits_available: false,
      rate_limits: null,
      session: { total_cost_usd: 123 },
    });
    expect(await f.inspector.inspectAccount()).toBeNull();
    expect(f.accountInfo).not.toHaveBeenCalled();
    expect(f.close).toHaveBeenCalledOnce();
  });

  it("hides missing, null and invalid windows, but keeps real zero utilization", () => {
    expect(
      projectClaudeAccountUsage(
        { ...usage, rate_limits: { five_hour: { utilization: null, resets_at: null } } },
        {},
      ),
    ).toBeNull();
    expect(
      projectClaudeAccountUsage(
        { ...usage, rate_limits: { five_hour: { utilization: NaN, resets_at: null } } },
        {},
      ),
    ).toBeNull();
    expect(
      projectClaudeAccountUsage(
        { ...usage, rate_limits: { seven_day_opus: { utilization: 0, resets_at: null } } },
        {},
      ),
    ).toMatchObject({
      credits: { label: "Opus · 7-day", usedPercent: 0, periodType: "seven_day" },
    });
  });

  it("surfaces per-model weekly windows that only exist in rate_limits.limits[]", () => {
    expect(
      projectClaudeAccountUsage(
        {
          ...usage,
          rate_limits: {
            ...usage.rate_limits,
            limits: [
              {
                kind: "session",
                group: "session",
                percent: 25,
                resets_at: "2026-09-01T05:00:00Z",
                scope: null,
              },
              {
                kind: "weekly_all",
                group: "weekly",
                percent: 60,
                resets_at: "2026-09-07T00:00:00Z",
                scope: null,
              },
              {
                kind: "weekly_scoped",
                group: "weekly",
                percent: 32,
                resets_at: "2026-09-10T16:59:59+00:00",
                scope: { model: { id: null, display_name: "Fable" }, surface: null },
                is_active: false,
              },
            ],
          } as never,
        },
        {},
      ),
    ).toMatchObject({
      credits: {
        usedPercent: 25,
        periodType: "five_hour",
        productUsage: [
          { product: "7-day window", usagePercent: 60 },
          { product: "Sonnet · 7-day", usagePercent: 0 },
          {
            product: "Fable · 7-day window",
            usagePercent: 32,
            resetsAt: "2026-09-10T16:59:59+00:00",
          },
        ],
      },
    });
  });

  it("keeps one entry when a model reports through both model_scoped and limits[]", () => {
    const projected = projectClaudeAccountUsage(
      {
        ...usage,
        rate_limits: {
          five_hour: usage.rate_limits.five_hour,
          model_scoped: [{ display_name: "Fable", utilization: 30, resets_at: null }],
          limits: [
            {
              kind: "weekly_scoped",
              percent: 32,
              resets_at: null,
              scope: { model: { display_name: "Fable" } },
            },
          ],
        } as never,
      },
      {},
    );
    expect(projected?.credits.productUsage).toEqual([
      { product: "Fable · 7-day window", usagePercent: 30 },
    ]);
  });

  it("ignores an absent, malformed or out-of-range limits[] entry", () => {
    expect(parseClaudeScopedWeeklyLimits(null)).toEqual([]);
    expect(parseClaudeScopedWeeklyLimits({})).toEqual([]);
    expect(parseClaudeScopedWeeklyLimits({ limits: null })).toEqual([]);
    expect(parseClaudeScopedWeeklyLimits({ limits: "weekly_scoped" })).toEqual([]);
    expect(
      parseClaudeScopedWeeklyLimits({
        limits: [
          null,
          { kind: "weekly_all", percent: 60, scope: null },
          { kind: "weekly_scoped", percent: 32, scope: null },
          { kind: "weekly_scoped", percent: 32, scope: { model: { display_name: "  " } } },
          { kind: "weekly_scoped", percent: "32", scope: { model: { display_name: "A" } } },
          { kind: "weekly_scoped", percent: NaN, scope: { model: { display_name: "B" } } },
          { kind: "weekly_scoped", percent: 101, scope: { model: { display_name: "C" } } },
          { kind: "weekly_scoped", percent: -1, scope: { model: { display_name: "D" } } },
          {
            kind: "weekly_scoped",
            percent: 0,
            resets_at: "not-a-date",
            scope: { model: { display_name: "E" } },
          },
        ],
      }),
    ).toEqual([{ product: "E · 7-day window", usagePercent: 0 }]);
  });

  it("projects a payload without limits[] exactly as before", () => {
    expect(JSON.stringify(projectClaudeAccountUsage(usage, {}))).toBe(
      JSON.stringify(
        projectClaudeAccountUsage(
          { ...usage, rate_limits: { ...usage.rate_limits, limits: [] } as never },
          {},
        ),
      ),
    );
  });

  it("closes inspection on an unsupported native operation or network error", async () => {
    const f = fixture();
    f.getUsage.mockRejectedValueOnce(new Error("unsupported"));
    await expect(f.inspector.inspectAccount()).rejects.toThrow("unsupported");
    expect(f.close).toHaveBeenCalledOnce();
  });

  it("closes a stalled SDK query after the bounded deadline", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      f.getUsage.mockImplementationOnce(() => new Promise(() => undefined));
      const result = expect(f.inspector.inspectAccount()).rejects.toThrow("timed out");
      await vi.advanceTimersByTimeAsync(10_000);
      await result;
      expect(f.close).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
