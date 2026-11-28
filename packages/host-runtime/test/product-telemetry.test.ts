import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PRODUCT_TELEMETRY_GET_METHOD,
  PRODUCT_TELEMETRY_SET_METHOD,
  PRODUCT_TELEMETRY_SIGNAL_METHOD,
} from "@codexhost/shared-contracts";
import {
  HostProductTelemetry,
  handleProductTelemetryClientRequest,
  isCiEnvironment,
  isTelemetryDisabledByEnvironment,
  resolveProductTelemetryUrl,
} from "../src/product-telemetry.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "codexhost-telemetry-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("HostProductTelemetry", () => {
  it("respects opt-out environment variables and detects CI environments", () => {
    expect(isTelemetryDisabledByEnvironment({ CODEXHOST_TELEMETRY: "0" })).toBe(true);
    expect(isTelemetryDisabledByEnvironment({ CODEXHOST_TELEMETRY: "off" })).toBe(true);
    expect(isTelemetryDisabledByEnvironment({ DO_NOT_TRACK: "1" })).toBe(true);
    expect(isTelemetryDisabledByEnvironment({ CODEXHOST_TELEMETRY_URL: "off" })).toBe(true);
    expect(isCiEnvironment({ CI: "true" })).toBe(true);
    expect(isCiEnvironment({ GITHUB_ACTIONS: "true" })).toBe(true);
    expect(isCiEnvironment({ CI: "false" })).toBe(false);
    expect(resolveProductTelemetryUrl({ DO_NOT_TRACK: "1" })).toBeUndefined();
    expect(resolveProductTelemetryUrl({ CODEXHOST_TELEMETRY_URL: "https://stats.example/" })).toBe(
      "https://stats.example/v1/telemetry/heartbeat",
    );
  });

  it("stays disabled in development source builds when no explicit telemetry URL is set", async () => {
    const dataDir = await makeTempDir();
    let calls = 0;
    const telemetry = new HostProductTelemetry({
      dataDirectory: dataDir,
      environment: {},
      readRuntimeInfo: async () => ({ version: "0.28.2-dev", distribution: "development" }),
      now: () => Date.parse("2026-11-28T03:00:00Z"),
    });
    // Explicitly invoke internal flush path without fetchImpl override by spying on global fetch
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    try {
      expect(await telemetry.flushNow()).toBe(false);
      expect(calls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
      telemetry.close();
    }
  });

  it("deduplicates locally with zero IDs, sends additive deltas, computes D1/D7 retention, and supports debug logging & opt-out", async () => {
    const dataDir = await makeTempDir();
    await mkdir(path.join(dataDir, "diagnostics"), { recursive: true });
    await writeFile(
      path.join(dataDir, "diagnostics", "launcher-startup-v1.json"),
      JSON.stringify({
        schemaVersion: 1,
        records: [{ desktop: { version: "26.1023.50603", build: "50603", installRoot: "/tmp" } }],
      }),
      "utf8",
    );

    const sentPayloads: Array<Record<string, unknown>> = [];
    const debugLines: string[] = [];
    let nowMs = Date.parse("2026-11-28T03:00:00Z");

    const telemetry = new HostProductTelemetry({
      dataDirectory: dataDir,
      environment: {
        CODEXHOST_TELEMETRY_URL: "https://stats.example",
        CODEXHOST_TELEMETRY_DEBUG: "1",
      },
      readRuntimeInfo: async () => ({ version: "0.28.2", distribution: "npm" }),
      readUiLanguage: () => "zh",
      debugLog: (line) => debugLines.push(line),
      now: () => nowMs,
      fetchImpl: (async (_url, init) => {
        sentPayloads.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }) as typeof fetch,
    });

    telemetry.recordSurface("codex-desktop");
    telemetry.recordHarness("claude-code");
    telemetry.recordHarness("private-corp-harness");

    expect(await telemetry.flushNow()).toBe(true);
    expect(sentPayloads).toHaveLength(1);
    expect(debugLines).toHaveLength(1);
    expect(debugLines[0]).toContain("[codexhost:telemetry] POST");

    const first = sentPayloads[0];
    expect(first).toBeDefined();
    if (!first) throw new Error("Expected first telemetry payload");
    expect("installId" in first).toBe(false);
    expect(first.newInstall).toBe(true);
    expect(first.dailyActive).toBe(true);
    expect(first.weeklyActive).toBe(true);
    expect(first.monthlyActive).toBe(true);
    expect(first.appVersion).toBe("0.28.2");
    expect(first.codexDesktopVersion).toBe("26.1023.50603");
    expect(first.uiLanguage).toBe("zh");
    expect(first.surfaces).toEqual(["codex-desktop"]);
    expect(first.harnesses).toEqual(["claude-code", "custom"]);

    // Second flush with no new signals sends nothing.
    expect(await telemetry.flushNow()).toBe(false);
    expect(sentPayloads).toHaveLength(1);

    // Same day afternoon: mobile connects over official-relay. Sends ONLY new delta!
    const sigReply = await handleProductTelemetryClientRequest(
      telemetry,
      PRODUCT_TELEMETRY_SIGNAL_METHOD,
      {
        surfaces: ["web-mobile"],
        remoteAccess: ["official-relay"],
      },
    );
    expect("result" in sigReply).toBe(true);
    expect(await telemetry.flushNow()).toBe(true);
    expect(sentPayloads).toHaveLength(2);
    expect(sentPayloads[1]).toEqual({
      remoteAny: true,
      surfaces: ["web-mobile"],
      remoteAccess: ["official-relay"],
    });

    // Day +1 (2026-11-29, still same ISO week & month): sends dailyActive + retainedD1, no weeklyActive/monthlyActive
    nowMs = Date.parse("2026-11-29T01:00:00Z");
    telemetry.recordHarness("pi");
    expect(await telemetry.flushNow()).toBe(true);
    expect(sentPayloads).toHaveLength(3);
    const day1 = sentPayloads[2];
    expect(day1).toBeDefined();
    if (!day1) throw new Error("Expected day1 telemetry payload");
    expect("installId" in day1).toBe(false);
    expect(day1.dailyActive).toBe(true);
    expect(day1.retainedD1).toBe(true);
    expect(day1.weeklyActive).toBeUndefined();
    expect(day1.monthlyActive).toBeUndefined();
    expect(day1.harnesses).toEqual(["pi"]);

    // Day +7 (2026-12-05, new ISO week & new month): sends dailyActive + weeklyActive + monthlyActive + retainedD7
    nowMs = Date.parse("2026-12-05T01:00:00Z");
    expect(await telemetry.flushNow()).toBe(true);
    expect(sentPayloads).toHaveLength(4);
    const day7 = sentPayloads[3];
    expect(day7).toBeDefined();
    if (!day7) throw new Error("Expected day7 telemetry payload");
    expect(day7.dailyActive).toBe(true);
    expect(day7.weeklyActive).toBe(true);
    expect(day7.monthlyActive).toBe(true);
    expect(day7.retainedD7).toBe(true);
    expect(day7.retainedD1).toBeUndefined();

    // Disabling via RPC stops all future sends and persists to telemetry-v1.json with NO installId.
    const setReply = await handleProductTelemetryClientRequest(
      telemetry,
      PRODUCT_TELEMETRY_SET_METHOD,
      { enabled: false },
    );
    expect(setReply).toEqual({ result: { enabled: false, forcedOffByEnv: false } });
    const getReply = await handleProductTelemetryClientRequest(
      telemetry,
      PRODUCT_TELEMETRY_GET_METHOD,
      {},
    );
    expect(getReply).toEqual({ result: { enabled: false, forcedOffByEnv: false } });

    nowMs = Date.parse("2026-12-06T01:00:00Z");
    expect(await telemetry.flushNow()).toBe(false);
    expect(sentPayloads).toHaveLength(4);

    const persisted = JSON.parse(
      await readFile(path.join(dataDir, "telemetry-v1.json"), "utf8"),
    ) as Record<string, unknown>;
    expect("installId" in persisted).toBe(false);
    expect(persisted.version).toBe(1);
    expect(persisted.enabled).toBe(false);
    telemetry.close();
  });
});
