import { afterEach, describe, expect, it } from "vitest";

import {
  NativeAccountQuotas,
  parseWhamAccountCredits,
} from "../src/account/native-account-quotas.js";
import {
  credential,
  createNativeAccountTestState,
  nativeAccountIds,
  type NativeAccountTestState,
} from "./fixtures/native-account-state.js";

const states: NativeAccountTestState[] = [];

afterEach(async () => {
  await Promise.all(states.splice(0).map((state) => state.close()));
});

function usageResponse(usedPercent: number): Response {
  return Response.json({
    rate_limit: {
      primary_window: {
        used_percent: usedPercent,
        limit_window_seconds: 18_000,
        reset_at: 2_000_000_000,
      },
    },
  });
}

describe("native inactive-account quota combinations", () => {
  it("parses only bounded renderer quota fields", () => {
    expect(
      parseWhamAccountCredits({
        rate_limit: {
          primary_window: {
            used_percent: "37.5",
            limit_window_seconds: 18_000,
            reset_at: 2_000_000_000,
          },
          secondary_window: {
            used_percent: 12,
            limit_window_seconds: 604_800,
          },
        },
        rate_limit_reset_credits: { available_count: 2 },
        ignored_secret: "never-project",
      }),
    ).toMatchObject({
      usedPercent: 37.5,
      periodType: "five_hour",
      productUsage: [{ product: "7-day window", usagePercent: 12 }],
      resetCredits: { availableCount: 2 },
    });
  });

  it("refreshes B with CAS against the latest Vault without overwriting C", async () => {
    const state = await createNativeAccountTestState({ readyRuntime: true });
    states.push(state);
    const a = credential("a");
    const b1 = credential("b", 1, 1);
    const b2 = credential("b", 2, 2_000_000_000);
    const c = credential("c");
    await state.seedAccounts({
      current: { accountId: nativeAccountIds.a, credential: a },
      saved: [
        { accountId: nativeAccountIds.b, credential: b1 },
        { accountId: nativeAccountIds.c, credential: c },
      ],
    });
    const tokenStarted = Promise.withResolvers<undefined>();
    const continueToken = Promise.withResolvers<undefined>();
    const fetch: typeof globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/oauth/token")) {
        tokenStarted.resolve(undefined);
        await continueToken.promise;
        const oauth = b2.managedOAuthCredential();
        return Response.json({
          access_token: oauth.accessToken,
          refresh_token: oauth.refreshToken,
        });
      }
      if (url.endsWith("/wham/usage")) return usageResponse(23);
      throw new Error("unexpected synthetic URL");
    };
    const quotas = new NativeAccountQuotas({
      files: state.files,
      directory: state.store.directory,
      credentials: state.store,
      fetch,
      admitCredentialRefresh: () => state.runtime.gate.admit(),
    });
    await quotas.initialize(new Set([nativeAccountIds.a, nativeAccountIds.b, nativeAccountIds.c]));
    const profileB = state.store.vault.accounts.find(
      (account) => account.accountId === nativeAccountIds.b,
    );
    if (!profileB) throw new Error("missing synthetic B");

    const inspection = quotas.inspect(profileB, true);
    await tokenStarted.promise;
    await state.store.mutate((next) => {
      const profileC = next.accounts.find((account) => account.accountId === nativeAccountIds.c);
      if (!profileC) throw new Error("missing synthetic C");
      profileC.label = "C changed concurrently";
    });
    continueToken.resolve(undefined);
    await expect(inspection).resolves.toMatchObject({
      accountId: nativeAccountIds.b,
      freshness: "live",
      accountCredits: { usedPercent: 23 },
    });

    const latest = state.store.vault;
    expect(latest.accounts.find((account) => account.accountId === nativeAccountIds.c)?.label).toBe(
      "C changed concurrently",
    );
    const latestB = latest.accounts.find((account) => account.accountId === nativeAccountIds.b);
    if (!latestB) throw new Error("missing refreshed B");
    expect(state.store.restoreCredential(latestB).managedOAuthCredential()).toMatchObject({
      accessToken: b2.managedOAuthCredential().accessToken,
      refreshToken: b2.managedOAuthCredential().refreshToken,
    });
    expect((await state.store.readCredentials())?.serializeForNativeStore()).toBe(
      a.serializeForNativeStore(),
    );
  });

  it("retries cache CAS by applying only its own Account patch to the latest file", async () => {
    const state = await createNativeAccountTestState();
    states.push(state);
    const observedAt = new Date().toISOString();
    const existingB = {
      accountCredits: { usedPercent: 81, periodType: "weekly" as const },
      observedAt,
    };
    const cache = {
      version: 1,
      snapshots: { [nativeAccountIds.b]: existingB },
    };
    state.files.failNext({
      operation: "replace",
      phase: "before",
      matches: (_directory, name) => name === "codex-quota-cache.json",
      run: () => {
        state.files.seed(state.store.directory, "codex-quota-cache.json", JSON.stringify(cache));
      },
    });
    const quotas = new NativeAccountQuotas({
      files: state.files,
      directory: state.store.directory,
      credentials: state.store,
      fetch: async () => {
        throw new Error("network must not be used");
      },
    });

    await quotas.record(nativeAccountIds.a, {
      usedPercent: 14,
      periodType: "five_hour",
    });

    const bytes = state.files.peek(state.store.directory, "codex-quota-cache.json");
    expect(bytes).not.toBeNull();
    const persisted = JSON.parse(bytes?.toString("utf8") ?? "null") as {
      snapshots: Record<string, unknown>;
    };
    expect(persisted.snapshots[nativeAccountIds.b]).toEqual(existingB);
    expect(persisted.snapshots[nativeAccountIds.a]).toMatchObject({
      accountCredits: { usedPercent: 14, periodType: "five_hour" },
    });
  });
});
