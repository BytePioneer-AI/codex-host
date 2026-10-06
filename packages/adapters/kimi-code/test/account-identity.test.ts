import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  fetchKimiAccount,
  KIMI_USAGES_ENDPOINT,
  projectKimiUsages,
} from "../src/account-identity.js";

describe("Kimi Code account usage", () => {
  const payload = {
    user: { nickname: "Moon", membership: { level: "LEVEL_ULTRA" } },
    usage: { limit: 100, used: 25, resetTime: "2026-10-01T00:00:00.000Z" },
    limits: [
      {
        window: { duration: 300, timeUnit: "minute" },
        detail: { limit: 50, remaining: 40, resetTime: "2026-09-30T05:00:00.000Z" },
      },
    ],
  };

  it("projects weekly and five-hour coding allowances", () => {
    expect(projectKimiUsages(payload)).toEqual({
      label: "Moon",
      plan: "ULTRA",
      credits: {
        usedPercent: 25,
        periodType: "weekly",
        resetsAt: "2026-10-01T00:00:00.000Z",
        productUsage: [
          {
            product: "Kimi Code · 5-hour window",
            usagePercent: 20,
            resetsAt: "2026-09-30T05:00:00.000Z",
          },
        ],
      },
    });
    expect(projectKimiUsages({ usage: { limit: 0, used: 0 } })).toBeNull();
  });

  it("refreshes an expired native credential file privately and preserves native metadata", async () => {
    const home = await mkdtemp(join(tmpdir(), "codexhost-kimi-account-"));
    const directory = join(home, "credentials");
    const filePath = join(directory, "kimi-code.json");
    const now = Date.parse("2026-09-01T00:00:00.000Z");
    try {
      await mkdir(directory);
      await writeFile(
        filePath,
        JSON.stringify({
          access_token: "expired",
          refresh_token: "native-refresh",
          expires_at: now / 1000 - 10,
          nativeMetadata: "preserved",
        }),
        { mode: 0o600 },
      );
      const fetch = vi.fn(async (url: string, init: RequestInit) => {
        if (url === KIMI_USAGES_ENDPOINT) {
          expect(init.headers).toMatchObject({ Authorization: "Bearer refreshed" });
          return new Response(JSON.stringify(payload));
        }
        expect(url).toBe("https://auth.kimi.com/api/oauth/token");
        expect(init.body).toBeInstanceOf(URLSearchParams);
        expect((init.body as URLSearchParams).get("refresh_token")).toBe("native-refresh");
        return new Response(
          JSON.stringify({ access_token: "refreshed", refresh_token: "rotated", expires_in: 900 }),
        );
      });
      await expect(
        fetchKimiAccount({ environment: { KIMI_CODE_HOME: home }, fetch, now }),
      ).resolves.toMatchObject({ label: "Moon" });
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(JSON.parse(await readFile(filePath, "utf8"))).toMatchObject({
        access_token: "refreshed",
        refresh_token: "rotated",
        expires_at: now / 1000 + 900,
        nativeMetadata: "preserved",
      });
      if (process.platform !== "win32") expect((await stat(filePath)).mode & 0o777).toBe(0o600);
      expect(await readdir(directory)).toEqual(["kimi-code.json"]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("retries a rejected native token once, but does not refresh an explicit API key", async () => {
    const now = Date.parse("2026-09-01T00:00:00.000Z");
    const readAuthFile = vi.fn(async () =>
      JSON.stringify({ access_token: "rejected", refresh_token: "native-refresh" }),
    );
    const writeAuthFile = vi.fn(async () => undefined);
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      if (url !== KIMI_USAGES_ENDPOINT)
        return new Response(JSON.stringify({ access_token: "refreshed", expires_in: 900 }));
      return new Headers(init.headers).get("authorization") === "Bearer refreshed"
        ? new Response(JSON.stringify(payload))
        : new Response(null, { status: 401 });
    });
    await expect(
      fetchKimiAccount({ environment: {}, readAuthFile, writeAuthFile, fetch, now }),
    ).resolves.toMatchObject({ label: "Moon" });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(writeAuthFile).toHaveBeenCalledOnce();
    fetch.mockClear();
    readAuthFile.mockClear();
    writeAuthFile.mockClear();
    await expect(
      fetchKimiAccount({
        environment: { KIMI_CODE_API_KEY: "explicit-api-key" },
        readAuthFile,
        writeAuthFile,
        fetch,
        now,
      }),
    ).resolves.toBeNull();
    expect(fetch).toHaveBeenCalledOnce();
    expect(readAuthFile).not.toHaveBeenCalled();
    expect(writeAuthFile).not.toHaveBeenCalled();
  });

  it("reads the native token and never starts a Kimi Session", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 }));
    await expect(
      fetchKimiAccount({
        environment: { HOME: "/test-home" },
        readAuthFile: async () =>
          JSON.stringify({ access_token: "native-token", expires_at: 4_102_444_800 }),
        fetch: fetch as typeof globalThis.fetch,
        now: Date.parse("2026-09-01T00:00:00.000Z"),
      }),
    ).resolves.toMatchObject({ label: "Moon", plan: "ULTRA" });
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith(
      KIMI_USAGES_ENDPOINT,
      expect.objectContaining({
        method: "GET",
        headers: { Authorization: "Bearer native-token", Accept: "application/json" },
      }),
    );
  });
});
