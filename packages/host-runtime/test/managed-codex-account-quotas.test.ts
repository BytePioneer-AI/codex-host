import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import { CodexCredentialFiles } from "../src/account/codex-credential-files.js";
import {
  ManagedCodexAccountQuotas,
  parseWhamAccountCredits,
} from "../src/account/managed-codex-account-quotas.js";
import { NativeCodexCredentials } from "../src/account/native-codex-credentials.js";
import { SavedCodexAccounts } from "../src/account/saved-codex-accounts.js";
import { OfficialWorkGate } from "../src/codex-runtime/official-work-gate.js";
import { syntheticNativeCredentials } from "./fixtures/codex-account-fixtures.js";
import { MemoryCredentialFiles } from "./fixtures/memory-credential-files.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const wham = (usedPercent = 17) => ({
  rate_limit: {
    primary_window: {
      used_percent: usedPercent,
      reset_at: 1_800_000_000,
      limit_window_seconds: 5 * 60 * 60,
    },
    secondary_window: {
      used_percent: 42,
      reset_at: 1_800_100_000,
      limit_window_seconds: 7 * 24 * 60 * 60,
    },
  },
  rate_limit_reset_credits: { available_count: 2 },
});

async function fixture(subject = "quota-user") {
  const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-quota-"));
  roots.push(root);
  const files = new MemoryCredentialFiles();
  const home = path.join(root, "home");
  const directory = path.join(root, "private");
  const credentials = new CodexCredentialFiles({
    files,
    directory,
    sharedCodexHome: home,
  });
  const lease = await credentials.initialize();
  const accounts = new SavedCodexAccounts({
    directory: path.join(root, "registry"),
    sharedCodexHome: home,
  });
  await accounts.initialize();
  const native = NativeCodexCredentials.parse(
    syntheticNativeCredentials({
      subject,
      expiresAtUnix: Math.floor(Date.now() / 1000) + 3_600,
    }),
  );
  const account = await accounts.saveVerifiedAccount({
    identity: native.identity,
    ...(native.email ? { email: native.email } : {}),
    label: subject,
  });
  await credentials.save(account, native);
  return { root, files, home, directory, credentials, lease, account, native };
}

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function accessToken(serialized: string): string {
  return (JSON.parse(serialized) as { tokens: { access_token: string } }).tokens.access_token;
}

describe("ManagedCodexAccountQuotas", () => {
  it("maps WHAM primary, secondary, and reset-credit fields without retaining raw data", () => {
    expect(parseWhamAccountCredits(wham(23))).toEqual({
      usedPercent: 23,
      periodType: "five_hour",
      resetsAt: new Date(1_800_000_000 * 1000).toISOString(),
      productUsage: [
        {
          product: "7-day window",
          usagePercent: 42,
          resetsAt: new Date(1_800_100_000 * 1000).toISOString(),
        },
      ],
      resetCredits: { availableCount: 2 },
    });
  });

  it("coalesces same-account reads and persists a last-good snapshot across restart", async () => {
    const { files, directory, credentials, lease, account, native } = await fixture();
    const request = vi.fn(async () => response(wham()));
    const quotas = new ManagedCodexAccountQuotas({
      files,
      directory,
      credentials,
      fetch: request as typeof fetch,
    });
    await quotas.initialize(new Set([account.accountId]));
    try {
      const [first, joined] = await Promise.all([
        quotas.inspect(account, true),
        quotas.inspect(account, true),
      ]);
      expect(first).toMatchObject({
        accountId: account.accountId,
        freshness: "live",
        accountCredits: { usedPercent: 17 },
      });
      expect(joined).toEqual(first);
      expect(request).toHaveBeenCalledOnce();
      const disk = files.contents.get(`${directory}/codex-quota-cache.json`)?.toString("utf8");
      expect(disk).toContain(account.accountId);
      expect(disk).not.toContain(native.managedOAuthCredential().accessToken);

      const restarted = new ManagedCodexAccountQuotas({
        files,
        directory,
        credentials,
        fetch: vi.fn(async () => {
          throw new Error("synthetic network failure");
        }) as typeof fetch,
      });
      await restarted.initialize(new Set([account.accountId]));
      await expect(restarted.inspect(account, true)).resolves.toMatchObject({
        freshness: "cached",
        accountCredits: { usedPercent: 17 },
      });
    } finally {
      await lease.release();
    }
  });

  it("rebases one quota-cache write after a concurrent cache update", async () => {
    const { files, directory, credentials, lease, account } = await fixture("cache-cas-user");
    let conflict = true;
    files.beforeReplace = (targetDirectory, name) => {
      if (targetDirectory !== directory || name !== "codex-quota-cache.json" || !conflict) return;
      conflict = false;
      files.nativeWrite(directory, name, JSON.stringify({ version: 1, snapshots: {} }));
    };
    const quotas = new ManagedCodexAccountQuotas({ files, directory, credentials });
    await quotas.initialize(new Set([account.accountId]));
    try {
      await quotas.record(account.accountId, { usedPercent: 19, periodType: "five_hour" });
      expect(files.contents.get(`${directory}/codex-quota-cache.json`)?.toString()).toContain(
        '"usedPercent":19',
      );
    } finally {
      await lease.release();
    }
  });

  it("merges partial successful snapshots and carries intermittent reset-credit data", async () => {
    const { files, directory, credentials, lease, account } = await fixture("merge-user");
    const quotas = new ManagedCodexAccountQuotas({ files, directory, credentials });
    await quotas.initialize(new Set([account.accountId]));
    try {
      await quotas.record(account.accountId, {
        usedPercent: 10,
        periodType: "five_hour",
        productUsage: [{ product: "7-day window", usagePercent: 20 }],
        resetCredits: { availableCount: 2 },
      });
      const merged = await quotas.record(account.accountId, {
        usedPercent: 11,
        periodType: "five_hour",
        productUsage: [{ product: "Spark", usagePercent: 30 }],
      });
      expect(merged.accountCredits).toEqual({
        usedPercent: 11,
        periodType: "five_hour",
        productUsage: [
          { product: "Spark", usagePercent: 30 },
          { product: "7-day window", usagePercent: 20 },
        ],
        resetCredits: { availableCount: 2 },
      });
      const cleared = await quotas.record(
        account.accountId,
        { usedPercent: 12, periodType: "five_hour" },
        { clearMissingResetCredits: true },
      );
      expect(cleared.accountCredits?.resetCredits).toBeUndefined();
    } finally {
      await lease.release();
    }
  });

  it("refreshes an inactive credential once, replays WHAM, and atomically stores rotation", async () => {
    const { files, directory, credentials, lease, account } = await fixture("rotating-user");
    const refreshedSerialized = syntheticNativeCredentials({
      subject: "rotating-user",
      generation: 2,
      expiresAtUnix: Math.floor(Date.now() / 1000) + 3_600,
    });
    const refreshedDocument = JSON.parse(refreshedSerialized) as {
      tokens: { access_token: string; refresh_token: string };
    };
    const tokenResponse = Promise.withResolvers<Response>();
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ error: "expired" }, 401))
      .mockImplementationOnce(() => tokenResponse.promise)
      .mockResolvedValueOnce(response(wham(31)));
    const gate = new OfficialWorkGate();
    gate.initialized();
    const quotas = new ManagedCodexAccountQuotas({
      files,
      directory,
      credentials,
      fetch: request,
      admitCredentialRefresh: () => gate.admit(),
    });
    await quotas.initialize(new Set([account.accountId]));
    try {
      const readings = Promise.all([quotas.inspect(account, true), quotas.inspect(account, true)]);
      await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
      expect(gate.busy).toBe(true);
      expect(() => gate.beginChange()).toThrow("Codex is busy");
      tokenResponse.resolve(
        response({
          access_token: refreshedDocument.tokens.access_token,
          refresh_token: refreshedDocument.tokens.refresh_token,
          expires_in: 3_600,
        }),
      );
      const [first, second] = await readings;
      expect(gate.busy).toBe(false);
      expect(first.accountCredits?.usedPercent).toBe(31);
      expect(second).toEqual(first);
      expect(request).toHaveBeenCalledTimes(3);
      const saved = await credentials.load(account);
      expect(saved.managedOAuthCredential().accessToken).toBe(
        refreshedDocument.tokens.access_token,
      );
      expect(saved.managedOAuthCredential().refreshToken).toBe(
        refreshedDocument.tokens.refresh_token,
      );
    } finally {
      await lease.release();
    }
  });

  it("does not overwrite a newer slot when an old quota refresh completes late", async () => {
    const { files, directory, credentials, lease, account } = await fixture("cas-user");
    const newer = syntheticNativeCredentials({
      subject: "cas-user",
      generation: 3,
      expiresAtUnix: Math.floor(Date.now() / 1000) + 7_200,
    });
    const staleRefresh = syntheticNativeCredentials({
      subject: "cas-user",
      generation: 2,
      expiresAtUnix: Math.floor(Date.now() / 1000) + 3_600,
    });
    const staleDocument = JSON.parse(staleRefresh) as {
      tokens: { access_token: string; refresh_token: string };
    };
    const request = vi.fn<typeof fetch>(async (url) => {
      if (String(url).includes("/oauth/token")) {
        files.nativeWrite(directory, `${account.accountId}.auth.json`, newer);
        return response({
          access_token: staleDocument.tokens.access_token,
          refresh_token: staleDocument.tokens.refresh_token,
          expires_in: 3_600,
        });
      }
      return response({ error: "expired" }, 401);
    });
    const quotas = new ManagedCodexAccountQuotas({
      files,
      directory,
      credentials,
      fetch: request,
    });
    await quotas.initialize(new Set([account.accountId]));
    const initialCredits = parseWhamAccountCredits(wham(11));
    if (!initialCredits) throw new Error("Synthetic WHAM response did not parse");
    await quotas.record(account.accountId, initialCredits);
    try {
      await expect(quotas.inspect(account, true)).resolves.toMatchObject({
        freshness: "cached",
        accountCredits: { usedPercent: 11 },
      });
      expect(accessToken((await credentials.load(account)).serializeForNativeStore())).toBe(
        accessToken(newer),
      );
    } finally {
      await lease.release();
    }
  });
});
