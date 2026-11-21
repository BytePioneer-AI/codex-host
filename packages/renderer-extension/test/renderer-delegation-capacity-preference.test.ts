import { describe, expect, it, vi } from "vitest";
import { DELEGATION_CAPACITY_SETTINGS_METHOD } from "@codexhost/shared-contracts";
import { createRendererModelClient } from "../src/renderer-model-client.js";
import {
  DELEGATION_CAPACITY_STATUS_EVENT,
  DELEGATION_CAPACITY_STORAGE_KEY,
  installDelegationCapacityPreferenceSync,
  readDelegationCapacityPreference,
  writeDelegationCapacityPreference,
} from "../src/renderer-delegation-capacity-preference.js";

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
  owner.addEventListener(DELEGATION_CAPACITY_STATUS_EVENT, (event) => {
    statuses.push((event as CustomEvent<string>).detail);
  });
  return { owner, values, storage, send, client, statuses };
}
const flush = async () => {
  for (let i = 0; i < 15; i += 1) await Promise.resolve();
};

describe("delegation capacity preference", () => {
  it("defaults off, keeps the saved limit while disabled, and rejects invalid limits", () => {
    const f = fixture();
    expect(readDelegationCapacityPreference(f.owner)).toEqual({ enabled: false, maxRunning: 4 });
    expect(writeDelegationCapacityPreference(f.owner, { enabled: true, maxRunning: 2 })).toBe(true);
    expect(writeDelegationCapacityPreference(f.owner, { enabled: false, maxRunning: 2 })).toBe(
      true,
    );
    expect(readDelegationCapacityPreference(f.owner)).toEqual({ enabled: false, maxRunning: 2 });
    for (const maxRunning of [0, 33, 1.5, NaN, Infinity]) {
      expect(writeDelegationCapacityPreference(f.owner, { enabled: true, maxRunning })).toBe(false);
    }
    expect(readDelegationCapacityPreference(f.owner).enabled).toBe(false);
  });

  it("fails safely for corrupt and unavailable storage", () => {
    const f = fixture();
    for (const raw of ["broken", "null", '{"enabled":true,"maxRunning":0}']) {
      f.values.set(DELEGATION_CAPACITY_STORAGE_KEY, raw);
      expect(readDelegationCapacityPreference(f.owner).enabled).toBe(false);
    }
    f.storage.getItem.mockImplementation(() => {
      throw new Error("SecurityError");
    });
    f.storage.setItem.mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(readDelegationCapacityPreference(f.owner)).toEqual({ enabled: false, maxRunning: 4 });
    expect(writeDelegationCapacityPreference(f.owner, { enabled: true, maxRunning: 4 })).toBe(
      false,
    );
  });

  it("sends complete validated settings on connect and changes, then removes listeners", async () => {
    const f = fixture();
    const sync = installDelegationCapacityPreferenceSync(f.owner);
    sync.connect(f.client);
    await flush();
    expect(f.send).toHaveBeenLastCalledWith(DELEGATION_CAPACITY_SETTINGS_METHOD, {
      enabled: false,
      maxRunning: 4,
    });
    writeDelegationCapacityPreference(f.owner, { enabled: true, maxRunning: 32 });
    await flush();
    expect(f.send).toHaveBeenLastCalledWith(DELEGATION_CAPACITY_SETTINGS_METHOD, {
      enabled: true,
      maxRunning: 32,
    });
    expect(f.statuses.at(-1)).toBe("applied");
    sync.connect(f.client);
    expect(f.send).toHaveBeenCalledTimes(2);
    sync.dispose();
    writeDelegationCapacityPreference(f.owner, { enabled: false, maxRunning: 32 });
    await flush();
    expect(f.send).toHaveBeenCalledTimes(2);
  });

  it("rereads shared storage for another window's change and on reconnect", async () => {
    const f = fixture();
    const sync = installDelegationCapacityPreferenceSync(f.owner);
    sync.connect(f.client);
    await flush();
    f.values.set(DELEGATION_CAPACITY_STORAGE_KEY, JSON.stringify({ enabled: true, maxRunning: 3 }));
    f.owner.dispatchEvent(
      Object.assign(new Event("storage"), { key: DELEGATION_CAPACITY_STORAGE_KEY }),
    );
    await flush();
    expect(f.send).toHaveBeenLastCalledWith(DELEGATION_CAPACITY_SETTINGS_METHOD, {
      enabled: true,
      maxRunning: 3,
    });
    const secondSend = vi.fn(async (_method: string, params: unknown) => params);
    sync.connect(createRendererModelClient([{ sendRequest: secondSend }]));
    await flush();
    expect(secondSend).toHaveBeenLastCalledWith(DELEGATION_CAPACITY_SETTINGS_METHOD, {
      enabled: true,
      maxRunning: 3,
    });
    sync.dispose();
  });

  it.each([
    [{ code: -32601 }, "unavailable"],
    [new Error("Host is restarting"), "failed"],
  ])("reports %o as %s without marking it applied", async (rejection, expected) => {
    const f = fixture();
    f.send.mockRejectedValue(rejection);
    const sync = installDelegationCapacityPreferenceSync(f.owner);
    sync.connect(f.client);
    await flush();
    expect(f.statuses.at(-1)).toBe(expected);
    expect(f.statuses).not.toContain("applied");
    sync.dispose();
  });

  it("does not send invalid settings through the public Renderer client", async () => {
    const f = fixture();
    if (!f.client.setDelegationCapacitySettings) throw new Error("Missing settings method");
    await expect(
      f.client.setDelegationCapacitySettings({ enabled: true, maxRunning: 0 }),
    ).rejects.toThrow();
    expect(f.send).not.toHaveBeenCalled();
  });
});
