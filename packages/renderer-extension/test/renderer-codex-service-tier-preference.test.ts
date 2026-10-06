import { describe, expect, it, vi } from "vitest";
import {
  CODEX_SERVICE_TIER_SETTINGS_METHOD,
  type CodexServiceTierEffect,
  type CodexServiceTierSettings,
} from "@codexhost/shared-contracts";
import { createRendererModelClient } from "../src/renderer-model-client.js";
import {
  CODEX_SERVICE_TIER_STORAGE_KEY,
  CODEX_SERVICE_TIER_STATUS_EVENT,
  installCodexServiceTierPreferenceSync,
  readCodexServiceTierPreference,
  writeCodexServiceTierPreference,
  type CodexServiceTierStatusDetail,
} from "../src/renderer-codex-service-tier-preference.js";

const ACTIVE: CodexServiceTierEffect = { state: "active" };

function hostResult(settings: unknown, effect: CodexServiceTierEffect = ACTIVE): unknown {
  return { settings, effect };
}

/** Mirrors the Host: a disabled setting can only ever report the off effect. */
function hostEffect(settings: CodexServiceTierSettings): CodexServiceTierEffect {
  return settings.enabled ? ACTIVE : { state: "off" };
}

function fixture(options: { document?: boolean } = {}) {
  const values = new Map<string, string>();
  const storage = {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    }),
  };
  const dataset: Record<string, string> = {};
  const owner = Object.assign(new EventTarget(), {
    localStorage: storage,
    ...(options.document === false ? {} : { document: { documentElement: { dataset } } }),
  }) as unknown as Window;
  const send = vi.fn(async (_method: string, params: unknown) =>
    hostResult(params, hostEffect(params as CodexServiceTierSettings)),
  );
  const client = createRendererModelClient([{ sendRequest: send }]);
  if (!client) throw new Error("Missing Renderer client");
  const statuses: CodexServiceTierStatusDetail[] = [];
  owner.addEventListener(CODEX_SERVICE_TIER_STATUS_EVENT, (event) => {
    statuses.push((event as CustomEvent<CodexServiceTierStatusDetail>).detail);
  });
  return { owner, values, storage, dataset, send, client, statuses };
}
const flush = async () => {
  for (let i = 0; i < 15; i += 1) await Promise.resolve();
};

describe("codex service tier preference", () => {
  it("defaults off, keeps the saved tier while disabled, and rejects invalid settings", () => {
    const f = fixture();
    expect(readCodexServiceTierPreference(f.owner)).toEqual({ enabled: false, tier: "fast" });
    expect(writeCodexServiceTierPreference(f.owner, { enabled: true, tier: "ultrafast" })).toBe(
      true,
    );
    expect(readCodexServiceTierPreference(f.owner)).toEqual({
      enabled: true,
      tier: "ultrafast",
    });
    // Standard is a real stored tier, not a disabled flag.
    expect(writeCodexServiceTierPreference(f.owner, { enabled: true, tier: "standard" })).toBe(
      true,
    );
    expect(readCodexServiceTierPreference(f.owner)).toEqual({ enabled: true, tier: "standard" });
    expect(
      writeCodexServiceTierPreference(f.owner, { enabled: true, tier: "turbo" as "fast" }),
    ).toBe(false);
    expect(readCodexServiceTierPreference(f.owner).enabled).toBe(true);
  });

  it("fails safely for corrupt and unavailable storage", () => {
    const f = fixture();
    for (const raw of ["broken", "null", '{"enabled":true,"tier":"turbo"}']) {
      f.values.set(CODEX_SERVICE_TIER_STORAGE_KEY, raw);
      expect(readCodexServiceTierPreference(f.owner).tier).toBe("fast");
    }
    f.storage.getItem.mockImplementation(() => {
      throw new Error("SecurityError");
    });
    f.storage.setItem.mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(readCodexServiceTierPreference(f.owner)).toEqual({ enabled: false, tier: "fast" });
    expect(writeCodexServiceTierPreference(f.owner, { enabled: true, tier: "fast" })).toBe(false);
  });

  it("sends complete validated settings on connect and changes, then removes listeners", async () => {
    const f = fixture();
    const sync = installCodexServiceTierPreferenceSync(f.owner);
    sync.connect(f.client);
    await flush();
    expect(f.send).toHaveBeenLastCalledWith(CODEX_SERVICE_TIER_SETTINGS_METHOD, {
      enabled: false,
      tier: "fast",
    });
    writeCodexServiceTierPreference(f.owner, { enabled: true, tier: "ultrafast" });
    await flush();
    expect(f.send).toHaveBeenLastCalledWith(CODEX_SERVICE_TIER_SETTINGS_METHOD, {
      enabled: true,
      tier: "ultrafast",
    });
    expect(f.statuses.at(-1)).toEqual({ status: "applied", effect: { state: "active" } });
    expect(f.dataset.codexhostServiceTier).toBe("ultrafast");
    sync.connect(f.client);
    expect(f.send).toHaveBeenCalledTimes(2);
    sync.dispose();
    expect(f.dataset.codexhostServiceTier).toBeUndefined();
    writeCodexServiceTierPreference(f.owner, { enabled: false, tier: "fast" });
    await flush();
    expect(f.send).toHaveBeenCalledTimes(2);
  });

  it("surfaces unavailable hosts without marking them applied", async () => {
    const f = fixture();
    f.send.mockRejectedValue({ code: -32601 });
    const sync = installCodexServiceTierPreferenceSync(f.owner);
    sync.connect(f.client);
    await flush();
    expect(f.statuses.at(-1)).toEqual({ status: "unavailable" });
    expect(f.statuses.some(({ status }) => status === "applied")).toBe(false);
    sync.dispose();
  });

  it("coalesces rapid tier changes and only confirms the latest setting", async () => {
    const f = fixture();
    let finish!: (value: unknown) => void;
    f.send.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    const sync = installCodexServiceTierPreferenceSync(f.owner);
    sync.connect(f.client);
    writeCodexServiceTierPreference(f.owner, { enabled: true, tier: "fast" });
    writeCodexServiceTierPreference(f.owner, { enabled: true, tier: "ultrafast" });
    expect(f.send).toHaveBeenCalledTimes(1);
    finish(hostResult({ enabled: false, tier: "fast" }, { state: "off" }));
    await flush();
    expect(f.send).toHaveBeenCalledTimes(2);
    expect(f.send).toHaveBeenLastCalledWith(CODEX_SERVICE_TIER_SETTINGS_METHOD, {
      enabled: true,
      tier: "ultrafast",
    });
    expect(f.statuses.filter(({ status }) => status === "applied")).toHaveLength(1);
    expect(f.dataset.codexhostServiceTier).toBe("ultrafast");
    sync.dispose();
  });

  it("ignores a stale connection and reads the shared preference on reconnect", async () => {
    const f = fixture();
    let finish!: (value: unknown) => void;
    f.send.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    const sync = installCodexServiceTierPreferenceSync(f.owner);
    sync.connect(f.client);
    f.values.set(
      CODEX_SERVICE_TIER_STORAGE_KEY,
      JSON.stringify({ enabled: true, tier: "ultrafast" }),
    );
    const nextSend = vi.fn(async (_method: string, params: unknown) => hostResult(params));
    sync.connect(createRendererModelClient([{ sendRequest: nextSend }]));
    await flush();
    expect(nextSend).toHaveBeenLastCalledWith(CODEX_SERVICE_TIER_SETTINGS_METHOD, {
      enabled: true,
      tier: "ultrafast",
    });
    const published = f.statuses.length;
    finish(hostResult({ enabled: false, tier: "fast" }, { state: "off" }));
    await flush();
    expect(f.statuses).toHaveLength(published);
    f.values.set(
      CODEX_SERVICE_TIER_STORAGE_KEY,
      JSON.stringify({ enabled: false, tier: "ultrafast" }),
    );
    f.owner.dispatchEvent(
      Object.assign(new Event("storage"), { key: CODEX_SERVICE_TIER_STORAGE_KEY }),
    );
    await flush();
    expect(nextSend).toHaveBeenLastCalledWith(CODEX_SERVICE_TIER_SETTINGS_METHOD, {
      enabled: false,
      tier: "ultrafast",
    });
    sync.dispose();
  });

  it("reports a rejected setting without claiming it was applied", async () => {
    const f = fixture();
    f.send.mockRejectedValue(new Error("config write failed"));
    const sync = installCodexServiceTierPreferenceSync(f.owner);
    sync.connect(f.client);
    await flush();
    expect(f.statuses.at(-1)).toEqual({ status: "failed" });
    expect(f.statuses.some(({ status }) => status === "applied")).toBe(false);
    sync.dispose();
  });

  it("does not send invalid settings through the public Renderer client", async () => {
    const f = fixture();
    if (!f.client.setCodexServiceTier) throw new Error("Missing settings method");
    await expect(
      f.client.setCodexServiceTier({ enabled: true, tier: "priority" as "fast" }),
    ).rejects.toThrow();
    expect(f.send).not.toHaveBeenCalled();
  });

  it("does not accept a Host reply that is not a result", async () => {
    const f = fixture();
    if (!f.client.setCodexServiceTier) throw new Error("Missing settings method");
    f.send.mockResolvedValueOnce({ enabled: true, tier: "fast" });
    await expect(f.client.setCodexServiceTier({ enabled: true, tier: "fast" })).rejects.toThrow();
  });
});

describe("codex service tier Composer marker", () => {
  it("mirrors only a confirmed active effect on the document element", async () => {
    const f = fixture();
    const sync = installCodexServiceTierPreferenceSync(f.owner);
    writeCodexServiceTierPreference(f.owner, { enabled: true, tier: "fast" });
    sync.connect(f.client);
    await flush();
    expect(f.dataset.codexhostServiceTier).toBe("fast");

    // A forced tier the catalog does not list is still active: the notice is
    // informational, so the Composer keeps showing the confirmed tier.
    f.send.mockImplementation(async (_method: string, params: unknown) =>
      hostResult(params, { state: "active", notice: "notAdvertised" }),
    );
    writeCodexServiceTierPreference(f.owner, { enabled: true, tier: "ultrafast" });
    await flush();
    expect(f.dataset.codexhostServiceTier).toBe("ultrafast");
    expect(f.statuses.at(-1)).toEqual({
      status: "applied",
      effect: { state: "active", notice: "notAdvertised" },
    });

    // The official OpenAI provider manages its own tier: codexhost shows none.
    f.send.mockImplementation(async (_method: string, params: unknown) =>
      hostResult(params, { state: "inactive", reason: "officialProvider" }),
    );
    writeCodexServiceTierPreference(f.owner, { enabled: true, tier: "fast" });
    await flush();
    expect(f.dataset.codexhostServiceTier).toBeUndefined();

    f.send.mockImplementation(async (_method: string, params: unknown) => hostResult(params));
    writeCodexServiceTierPreference(f.owner, { enabled: true, tier: "ultrafast" });
    await flush();
    expect(f.dataset.codexhostServiceTier).toBe("ultrafast");

    // Standard is a confirmed active effect too, so the marker carries it and
    // the Composer keeps showing the control (the CSS keys on the scope stamp,
    // not this attribute, so a standard marker paints no extra accent).
    writeCodexServiceTierPreference(f.owner, { enabled: true, tier: "standard" });
    await flush();
    expect(f.dataset.codexhostServiceTier).toBe("standard");
    expect(f.statuses.at(-1)).toEqual({ status: "applied", effect: { state: "active" } });

    // Turning the tier off reaches the Host as an off effect.
    f.send.mockImplementation(async (_method: string, params: unknown) =>
      hostResult(params, { state: "off" }),
    );
    writeCodexServiceTierPreference(f.owner, { enabled: false, tier: "ultrafast" });
    await flush();
    expect(f.dataset.codexhostServiceTier).toBeUndefined();
    sync.dispose();
  });

  it("keeps the last confirmed tier while a newer save is pending", async () => {
    const f = fixture();
    const sync = installCodexServiceTierPreferenceSync(f.owner);
    writeCodexServiceTierPreference(f.owner, { enabled: true, tier: "fast" });
    sync.connect(f.client);
    await flush();
    expect(f.dataset.codexhostServiceTier).toBe("fast");
    let finish!: (value: unknown) => void;
    f.send.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    writeCodexServiceTierPreference(f.owner, { enabled: true, tier: "ultrafast" });
    await flush();
    expect(f.statuses.at(-1)).toEqual({ status: "pending" });
    expect(f.dataset.codexhostServiceTier).toBe("fast");
    finish(hostResult({ enabled: true, tier: "ultrafast" }));
    await flush();
    expect(f.dataset.codexhostServiceTier).toBe("ultrafast");
    sync.dispose();
  });

  it("removes the confirmed tier when the connection is lost, disposed, or failed", async () => {
    const f = fixture();
    const sync = installCodexServiceTierPreferenceSync(f.owner);
    writeCodexServiceTierPreference(f.owner, { enabled: true, tier: "fast" });
    sync.connect(f.client);
    await flush();
    expect(f.dataset.codexhostServiceTier).toBe("fast");
    sync.connect(null);
    await flush();
    expect(f.dataset.codexhostServiceTier).toBeUndefined();

    sync.connect(f.client);
    await flush();
    expect(f.dataset.codexhostServiceTier).toBe("fast");
    f.send.mockRejectedValue(new Error("config write failed"));
    writeCodexServiceTierPreference(f.owner, { enabled: true, tier: "ultrafast" });
    await flush();
    expect(f.statuses.at(-1)).toEqual({ status: "failed" });
    expect(f.dataset.codexhostServiceTier).toBeUndefined();

    f.send.mockImplementation(async (_method: string, params: unknown) => hostResult(params));
    writeCodexServiceTierPreference(f.owner, { enabled: true, tier: "fast" });
    await flush();
    expect(f.dataset.codexhostServiceTier).toBe("fast");
    sync.dispose();
    expect(f.dataset.codexhostServiceTier).toBeUndefined();
  });

  it("tolerates a Window without a document", async () => {
    const f = fixture({ document: false });
    const sync = installCodexServiceTierPreferenceSync(f.owner);
    writeCodexServiceTierPreference(f.owner, { enabled: true, tier: "fast" });
    sync.connect(f.client);
    await flush();
    expect(f.statuses.at(-1)).toEqual({ status: "applied", effect: { state: "active" } });
    sync.dispose();
  });
});
