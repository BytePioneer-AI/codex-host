import type { IdleReleaseSettings } from "@codexhost/shared-contracts";
import { expect, it, vi } from "vitest";
import {
  installRendererHarnessPreferenceSync,
  rendererHarnessPreferenceStatus,
} from "../src/renderer-harness-preferences.js";
import {
  installIdleReleasePreferenceSync,
  readIdleReleasePreference,
  readIdleReleaseRemoteStatus,
  writeIdleReleasePreference,
} from "../src/renderer-idle-release-preference.js";
import type { RendererModelClient } from "../src/renderer-model-client.js";

const enabled = { enabled: true, timeoutMinutes: 10 };
const disabled = { enabled: false, timeoutMinutes: 15 };

async function fixture() {
  const window = Object.assign(new EventTarget(), {
    document: new EventTarget(),
    localStorage: { length: 0, getItem: () => null },
  }) as unknown as Window;
  let settings = enabled;
  let revision = 1;
  const snapshot = () => ({
    scope: "external",
    revision,
    values: { favorites: {}, idleRelease: settings },
  });
  const local = {
    getHarnessPreferences: async () => snapshot(),
    patchHarnessPreferences: async ({ operations }) => {
      const operation = operations[0];
      if (operation?.kind === "idleRelease") {
        settings = operation.value;
        revision++;
      }
      return snapshot();
    },
  } satisfies Pick<RendererModelClient, "getHarnessPreferences" | "patchHarnessPreferences">;
  const preferences = installRendererHarnessPreferenceSync(window);
  const sync = installIdleReleasePreferenceSync(window);
  preferences.connect("local", local as RendererModelClient);
  await vi.waitFor(() => expect(rendererHarnessPreferenceStatus()).toBe("applied"));
  return {
    window,
    sync,
    close() {
      sync.dispose();
      preferences.dispose();
    },
  };
}

function ssh(receive: (settings: IdleReleaseSettings) => Promise<IdleReleaseSettings>) {
  return { setIdleReleaseSettings: receive };
}

it("applies the confirmed idle threshold to every connected SSH Host and reapplies on reconnect", async () => {
  const f = await fixture();
  try {
    const received = new Map<string, IdleReleaseSettings>();
    const client = (key: string) =>
      ssh(async (settings) => {
        received.set(key, settings);
        return settings;
      });
    f.sync.connect(
      new Map([
        ["remote-ssh:one", client("one")],
        ["remote-ssh:two", client("two")],
      ]),
    );
    await vi.waitFor(() =>
      expect(received).toEqual(
        new Map([
          ["one", enabled],
          ["two", enabled],
        ]),
      ),
    );

    f.sync.connect(new Map());
    f.sync.connect(new Map([["remote-ssh:one", client("reconnected")]]));
    await vi.waitFor(() => expect(received.get("reconnected")).toEqual(enabled));
  } finally {
    f.close();
  }
});

it("sends the newest confirmed policy after a slower SSH update and isolates an unsupported Host", async () => {
  const f = await fixture();
  try {
    const pending = Promise.withResolvers<IdleReleaseSettings>();
    const received: IdleReleaseSettings[] = [];
    const slow = ssh(async (settings) => {
      received.push(settings);
      return settings.enabled ? pending.promise : settings;
    });
    const unsupported = ssh(async () => {
      throw Object.assign(new Error("Unsupported method"), { code: -32601 });
    });
    let statuses: unknown;
    f.window.addEventListener("codexhost:idle-release-remote-status", (event) => {
      statuses = (event as CustomEvent).detail;
    });
    f.sync.connect(
      new Map([
        ["remote-ssh:slow", slow],
        ["remote-ssh:old", unsupported],
      ]),
    );
    await vi.waitFor(() => expect(received).toEqual([enabled]));
    expect(writeIdleReleasePreference(f.window, disabled)).toBe(true);
    await vi.waitFor(() => expect(readIdleReleasePreference(f.window)).toEqual(disabled));
    expect(received).toEqual([enabled]);
    pending.resolve(enabled);
    await vi.waitFor(() => expect(received).toEqual([enabled, disabled]));
    await vi.waitFor(() =>
      expect(statuses).toEqual([
        { hostId: "remote-ssh:slow", status: "applied" },
        { hostId: "remote-ssh:old", status: "unavailable" },
      ]),
    );
  } finally {
    f.close();
  }
});

it("ignores a retired connection settling after a replacement and reports mismatched acknowledgements", async () => {
  const f = await fixture();
  try {
    const pending = Promise.withResolvers<IdleReleaseSettings>();
    const id = "remote-ssh:reconnect";
    f.sync.connect(new Map([[id, ssh(() => pending.promise)]]));
    let sent = false;
    const next = ssh(async () => {
      sent = true;
      return disabled;
    });
    f.sync.connect(new Map([[id, next]]));
    await vi.waitFor(() =>
      expect(readIdleReleaseRemoteStatus(f.window)).toEqual([{ hostId: id, status: "failed" }]),
    );
    expect(sent).toBe(true);
    pending.resolve(enabled);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(readIdleReleaseRemoteStatus(f.window)).toEqual([{ hostId: id, status: "failed" }]);
  } finally {
    f.close();
  }
});
