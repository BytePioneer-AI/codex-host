import { describe, expect, it, vi } from "vitest";
import { IDLE_RELEASE_SETTINGS_METHOD } from "@codexhost/shared-contracts";
import { createRendererModelClient } from "../src/renderer-model-client.js";
import {
  IDLE_RELEASE_STORAGE_KEY,
  IDLE_RELEASE_STATUS_EVENT,
  installIdleReleasePreferenceSync,
  readIdleReleasePreference,
  writeIdleReleasePreference,
} from "../src/renderer-idle-release-preference.js";

function fixture() {
  const values = new Map<string, string>();
  const storage = {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    }),
  };
  const owner = Object.assign(new EventTarget(), { localStorage: storage }) as unknown as Window;
  const send = vi.fn(async (_method: string, params: unknown) => params);
  const client = createRendererModelClient([{ sendRequest: send }]);
  if (!client) throw new Error("Missing Renderer client");
  const statuses: string[] = [];
  owner.addEventListener(IDLE_RELEASE_STATUS_EVENT, (event) => {
    statuses.push((event as CustomEvent<string>).detail);
  });
  return { owner, values, storage, send, client, statuses };
}
const flush = async () => {
  for (let i = 0; i < 15; i += 1) await Promise.resolve();
};

describe("idle release preference", () => {
  it("defaults off, preserves saved minutes while disabled, and rejects invalid settings", () => {
    const f = fixture();
    expect(readIdleReleasePreference(f.owner)).toEqual({ enabled: false, timeoutMinutes: 30 });
    expect(writeIdleReleasePreference(f.owner, { enabled: true, timeoutMinutes: 5 })).toBe(true);
    expect(writeIdleReleasePreference(f.owner, { enabled: false, timeoutMinutes: 5 })).toBe(true);
    expect(readIdleReleasePreference(f.owner)).toEqual({ enabled: false, timeoutMinutes: 5 });
    for (const timeoutMinutes of [4, 1441, 30.5, NaN, Infinity]) {
      expect(writeIdleReleasePreference(f.owner, { enabled: true, timeoutMinutes })).toBe(false);
    }
    expect(readIdleReleasePreference(f.owner).enabled).toBe(false);
  });

  it("fails safely for corrupt and unavailable storage", () => {
    const f = fixture();
    for (const raw of ["broken", "null", '{"enabled":true,"timeoutMinutes":0}']) {
      f.values.set(IDLE_RELEASE_STORAGE_KEY, raw);
      expect(readIdleReleasePreference(f.owner).enabled).toBe(false);
    }
    f.storage.getItem.mockImplementation(() => {
      throw new Error("SecurityError");
    });
    f.storage.setItem.mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(readIdleReleasePreference(f.owner)).toEqual({ enabled: false, timeoutMinutes: 30 });
    expect(writeIdleReleasePreference(f.owner, { enabled: true, timeoutMinutes: 30 })).toBe(false);
  });

  it("sends complete validated settings on connect and changes, then removes listeners", async () => {
    const f = fixture();
    const sync = installIdleReleasePreferenceSync(f.owner);
    sync.connect(f.client);
    await flush();
    expect(f.send).toHaveBeenLastCalledWith(IDLE_RELEASE_SETTINGS_METHOD, {
      enabled: false,
      timeoutMinutes: 30,
    });
    writeIdleReleasePreference(f.owner, { enabled: true, timeoutMinutes: 1440 });
    await flush();
    expect(f.send).toHaveBeenLastCalledWith(IDLE_RELEASE_SETTINGS_METHOD, {
      enabled: true,
      timeoutMinutes: 1440,
    });
    expect(f.statuses.at(-1)).toBe("applied");
    sync.connect(f.client);
    expect(f.send).toHaveBeenCalledTimes(2);
    sync.dispose();
    writeIdleReleasePreference(f.owner, { enabled: false, timeoutMinutes: 1440 });
    await flush();
    expect(f.send).toHaveBeenCalledTimes(2);
  });

  it("rereads shared storage for another window's change and on reconnect", async () => {
    const f = fixture();
    const sync = installIdleReleasePreferenceSync(f.owner);
    sync.connect(f.client);
    await flush();
    f.values.set(IDLE_RELEASE_STORAGE_KEY, JSON.stringify({ enabled: false, timeoutMinutes: 42 }));
    f.owner.dispatchEvent(Object.assign(new Event("storage"), { key: IDLE_RELEASE_STORAGE_KEY }));
    await flush();
    expect(f.send).toHaveBeenLastCalledWith(IDLE_RELEASE_SETTINGS_METHOD, {
      enabled: false,
      timeoutMinutes: 42,
    });
    const secondSend = vi.fn(async (_method: string, params: unknown) => params);
    sync.connect(createRendererModelClient([{ sendRequest: secondSend }]));
    await flush();
    expect(secondSend).toHaveBeenLastCalledWith(IDLE_RELEASE_SETTINGS_METHOD, {
      enabled: false,
      timeoutMinutes: 42,
    });
    sync.dispose();
  });

  it("does not let a stalled old connection block a new connection or overwrite its status", async () => {
    const f = fixture();
    let finish!: (value: unknown) => void;
    f.send.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const sync = installIdleReleasePreferenceSync(f.owner);
    sync.connect(f.client);
    const nextSend = vi.fn(async (_method: string, params: unknown) => params);
    f.values.set(IDLE_RELEASE_STORAGE_KEY, JSON.stringify({ enabled: false, timeoutMinutes: 60 }));
    sync.connect(createRendererModelClient([{ sendRequest: nextSend }]));
    await flush();
    expect(nextSend).toHaveBeenLastCalledWith(IDLE_RELEASE_SETTINGS_METHOD, {
      enabled: false,
      timeoutMinutes: 60,
    });
    expect(f.statuses.at(-1)).toBe("applied");
    const published = f.statuses.length;
    finish({ enabled: true, timeoutMinutes: 30 });
    await flush();
    expect(f.statuses).toHaveLength(published);
    sync.dispose();
  });

  it("surfaces unsupported methods without marking them applied", async () => {
    const f = fixture();
    f.send.mockRejectedValue({ code: -32601 });
    const sync = installIdleReleasePreferenceSync(f.owner);
    sync.connect(f.client);
    await flush();
    expect(f.statuses.at(-1)).toBe("unavailable");
    expect(f.statuses).not.toContain("applied");
    sync.dispose();
  });

  it("does not send invalid settings through the public Renderer client", async () => {
    const f = fixture();
    if (!f.client.setIdleReleaseSettings) throw new Error("Missing settings method");
    await expect(
      f.client.setIdleReleaseSettings({ enabled: true, timeoutMinutes: 4 }),
    ).rejects.toThrow();
    expect(f.send).not.toHaveBeenCalled();
  });
});
