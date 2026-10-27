import { afterEach, describe, expect, it, vi } from "vitest";
import type { CopilotClient } from "@github/copilot-sdk";
import { CopilotAccount } from "../src/account.js";
import { projectCopilotAccount } from "../src/account-usage.js";
import { createCopilotClient } from "../src/client.js";
vi.mock("../src/client.js", () => ({ createCopilotClient: vi.fn() }));
type Quota = Parameters<typeof projectCopilotAccount>[0];
function quota(): Quota {
  return {
    planTier: "free",
    isFreeUser: true,
    isTbbUser: true,
    snapshots: {},
    providerQuotas: [
      {
        provider: { id: "copilot", kind: "copilot", label: "GitHub Copilot" },
        quotaId: "chat",
        unit: "ai_credits",
        accessState: "allowed",
        capacityState: "available",
        observationKind: "account_snapshot",
        quantityKind: "authoritative_budget",
        acquisitionStatus: "succeeded",
        budgetMetadata: {
          unlimited: false,
          entitlement: 200,
          consumed: 9,
          remainingPercentage: 95.7,
          overage: 0,
          overageAllowedWhenExhausted: false,
          usageAllowedWhenExhausted: false,
          tokenBasedBilling: true,
        },
      },
    ],
  } as Quota;
}
function client() {
  const session = {
    sessionId: "",
    disconnect: vi.fn(async () => {}),
    send: vi.fn(),
    rpc: { quota: { refresh: vi.fn(async () => quota()) } },
  };
  return {
    session,
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => []),
    forceStop: vi.fn(async () => {}),
    createSession: vi.fn(async (config: { sessionId?: string }) => {
      session.sessionId = config.sessionId ?? "";
      return session;
    }),
    deleteSession: vi.fn(async () => {}),
    getAuthStatus: vi.fn(async () => ({
      isAuthenticated: true,
      authType: "gh-cli",
      login: "fixture-user",
      host: "github.com",
    })),
  };
}
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("Copilot native account quota projection", () => {
  it("preserves the explicit unit and native percentage independently from rounded amounts", () => {
    expect(projectCopilotAccount(quota())).toMatchObject({
      plan: "free",
      credits: { used: 9, limit: 200, unit: "AI Credits", usedPercent: 4.3, periodType: "unknown" },
    });
  });
  it("omits advisory, unlimited, unavailable and unmeasured budgets", () => {
    for (const patch of [
      { quantityKind: "advisory_balance" },
      { acquisitionStatus: "failed" },
      { observationKind: "admission_state" },
      { budgetMetadata: undefined },
    ]) {
      const input = quota();
      Object.assign(input.providerQuotas?.[0] ?? {}, patch);
      expect(projectCopilotAccount(input)).toBeNull();
    }
    const input = quota();
    const budget = input.providerQuotas?.[0]?.budgetMetadata;
    if (!budget) throw new Error("Missing fixture");
    budget.unlimited = true;
    expect(projectCopilotAccount(input)).toBeNull();
    budget.unlimited = false;
    budget.remainingPercentage = NaN;
    expect(projectCopilotAccount(input)).toBeNull();
  });
  it("preserves a real zero cap and does not infer cadence from a reset date", () => {
    const input = quota();
    const budget = input.providerQuotas?.[0]?.budgetMetadata;
    if (!budget) throw new Error("Missing fixture");
    Object.assign(budget, {
      entitlement: 0,
      consumed: 0,
      remainingPercentage: 0,
      resetAtEpochMs: 1893456000000,
    });
    expect(projectCopilotAccount(input)?.credits).toMatchObject({
      used: 0,
      limit: 0,
      usedPercent: 100,
      periodType: "unknown",
      resetsAt: "2030-01-01T00:00:00.000Z",
    });
  });
});

describe("Copilot fresh account reads and bounded cache", () => {
  it("coalesces queries, cleans its own draft, expires cache, and sends no model input", async () => {
    const native = client();
    vi.mocked(createCopilotClient).mockReturnValue(native as unknown as CopilotClient);
    const account = new CopilotAccount({});
    const first = account.inspect();
    expect(account.inspect()).toBe(first);
    expect((await first)?.credits?.unit).toBe("AI Credits");
    expect(native.createSession).toHaveBeenCalledOnce();
    expect(native.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ enableConfigDiscovery: false }),
    );
    expect(native.deleteSession).toHaveBeenCalledWith(expect.any(String));
    expect(native.session.disconnect).toHaveBeenCalledOnce();
    expect(native.session.send).not.toHaveBeenCalled();
    await account.refresh();
    expect(native.start).toHaveBeenCalledTimes(1);
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 16000);
    expect(account.credits()).toBeNull();
    vi.useRealTimers();
    await account.close();
    expect(account.credits()).toBeNull();
  });
  it("retires the previous identity before refresh and rejects a change during the query", async () => {
    const native = client();
    vi.mocked(createCopilotClient).mockReturnValue(native as unknown as CopilotClient);
    const account = new CopilotAccount({});
    await account.inspect();
    native.getAuthStatus
      .mockResolvedValueOnce({
        isAuthenticated: true,
        authType: "gh-cli",
        login: "old-user",
        host: "github.com",
      })
      .mockResolvedValueOnce({
        isAuthenticated: true,
        authType: "gh-cli",
        login: "new-user",
        host: "github.com",
      });
    const next = account.inspect();
    expect(account.credits()).toBeNull();
    expect(await next).toBeNull();
    expect(account.credits()).toBeNull();
    await account.close();
  });
  it("does not create a draft when signed out and does not cache failures", async () => {
    const native = client();
    native.getAuthStatus.mockResolvedValue({
      isAuthenticated: false,
      authType: "gh-cli",
      login: "",
      host: "github.com",
    });
    vi.mocked(createCopilotClient).mockReturnValue(native as unknown as CopilotClient);
    const account = new CopilotAccount({});
    expect(await account.inspect()).toBeNull();
    expect(native.createSession).not.toHaveBeenCalled();
    await account.close();
  });
  it("finishes draft cleanup when close races with an account query", async () => {
    const native = client();
    const quotaRead = Promise.withResolvers<Quota>();
    native.session.rpc.quota.refresh.mockReturnValue(quotaRead.promise);
    vi.mocked(createCopilotClient).mockReturnValue(native as unknown as CopilotClient);
    const account = new CopilotAccount({});
    const reading = account.inspect();
    await vi.waitFor(() => expect(native.session.rpc.quota.refresh).toHaveBeenCalled());
    const closing = account.close();
    expect(native.forceStop).not.toHaveBeenCalled();
    quotaRead.resolve(quota());
    expect(await reading).toBeNull();
    await closing;
    expect(native.deleteSession).toHaveBeenCalledOnce();
    expect(account.credits()).toBeNull();
  });
  it("retries deletion of a failed inspection draft on close", async () => {
    const native = client();
    native.deleteSession.mockRejectedValueOnce(new Error("temporary cleanup failure"));
    vi.mocked(createCopilotClient).mockReturnValue(native as unknown as CopilotClient);
    const account = new CopilotAccount({});
    expect(await account.inspect()).toBeNull();
    const id = native.deleteSession.mock.calls[0];
    await account.close();
    expect(native.deleteSession.mock.calls[1]).toEqual(id);
  });
});
