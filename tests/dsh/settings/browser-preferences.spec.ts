// @vitest-environment jsdom
import { Context } from "@deepseek-ai/cordis";
import type { SettingsNamespaceView } from "@deepseek-ai/dsh-api-remotes/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import fixtures from "../../../packages/web-server/fixtures/settings-namespaces.json";
import {
  BrowserPreferences,
  isBrowserPreference,
} from "../../../apps/web-ui/packages/client/ui-settings/src/client/browser-preferences.ts";
import { ConfigForms } from "../../../apps/web-ui/packages/client/ui-settings/src/client/config-form.ts";
import { SettingsSchemaService } from "../../../apps/web-ui/packages/client/ui-settings/src/client/schema.ts";
import { SettingsDescribeMirror } from "../../../apps/web-ui/packages/client/ui-settings/src/client/settings-mirror.ts";

const browserNamespaces = ["ui-theme", "locale", "ui-chat", "ui-conversation", "ui-settings"];
const contexts: Context[] = [];

beforeEach(() => localStorage.clear());
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  await Promise.all(contexts.splice(0).map((ctx) => ctx.fiber.dispose()));
});

function context(): Context {
  const ctx = new Context();
  contexts.push(ctx);
  return ctx;
}

function theme(user: Record<string, unknown> = {}): SettingsNamespaceView {
  const fixture = structuredClone(fixtures.find((entry) => entry.ns === "ui-theme"));
  return { ...fixture, user, revision: 7 } as unknown as SettingsNamespaceView;
}

function preferences(): BrowserPreferences {
  return new BrowserPreferences("ui-theme", new SettingsSchemaService(context()));
}

it("limits browser storage to the five UI namespaces", () => {
  for (const namespace of browserNamespaces) expect(isBrowserPreference(namespace)).toBe(true);
  for (const namespace of [
    "provider",
    "harness",
    "runtime",
    "ui-theme-extra",
    "ui-settings-general",
  ])
    expect(isBrowserPreference(namespace)).toBe(false);
});

it("seeds existing server preferences once and restores browser choices in a new instance", () => {
  const local = preferences();
  const original = theme({ preference: "dark", fontSize: 18 });
  expect(local.read(original)).toMatchObject({
    user: { preference: "dark", fontSize: 18 },
    value: { preference: "dark", fontSize: 18 },
    revision: 0,
  });
  expect(local.write(original, [{ op: "set", path: ["fontSize"], value: 20 }])).toBe(true);
  const changedServer = theme({ preference: "light", fontSize: 12 });
  expect(preferences().read(changedServer)).toMatchObject({
    user: { preference: "dark", fontSize: 20 },
    value: { preference: "dark", fontSize: 20 },
    revision: 1,
  });
  expect(original.user).toEqual({ preference: "dark", fontSize: 18 });
});

it("updates individual fields and unsets them to the base without losing other choices", () => {
  const local = preferences();
  const view = theme({ preference: "dark", fontSize: 18 });
  expect(local.write(view, [{ op: "set", path: ["fontSize"], value: 20 }])).toBe(true);
  expect(local.write(view, [{ op: "unset", path: ["preference"] }])).toBe(true);
  expect(local.read(view)).toMatchObject({
    user: { fontSize: 20 },
    value: { preference: "system", fontSize: 20 },
    revision: 2,
  });
});

it("rejects invalid values and stale revisions without changing the saved record", () => {
  const local = preferences();
  const view = theme({ preference: "dark" });
  local.read(view);
  expect(local.write(view, [{ op: "set", path: ["fontSize"], value: 18 }], 0)).toBe(true);
  const saved = localStorage.getItem(local.key);
  expect(local.write(view, [{ op: "set", path: ["fontSize"], value: 20 }], 0)).toBe(false);
  expect(local.write(view, [{ op: "set", path: ["fontSize"], value: 99 }], 1)).toBe(false);
  expect(local.write(view, [{ op: "set", path: ["preference"], value: "invalid" }])).toBe(false);
  expect(localStorage.getItem(local.key)).toBe(saved);
});

it.each([
  "{broken",
  JSON.stringify({ user: { fontSize: 99 }, revision: 2 }),
  JSON.stringify({ user: { preference: "dark" }, revision: -1 }),
])("recovers malformed or invalid browser storage (%s)", (saved) => {
  const local = preferences();
  localStorage.setItem(local.key, saved);
  expect(local.read(theme({ fontSize: 16 }))).toMatchObject({
    user: { fontSize: 16 },
    value: { preference: "system", fontSize: 16 },
    revision: 0,
  });
});

it("keeps settings readable when storage is unavailable and reports failed writes", () => {
  const local = preferences();
  const view = theme({ fontSize: 16 });
  vi.stubGlobal("localStorage", undefined);
  expect(() => local.read(view)).not.toThrow();
  expect(local.read(view).value).toEqual({ preference: "system", fontSize: 16 });
  expect(local.write(view, [{ op: "set", path: ["fontSize"], value: 20 }])).toBe(false);
});

it("preserves the stored value when the browser refuses a write", () => {
  const local = preferences();
  const view = theme({ fontSize: 16 });
  local.read(view);
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException("Storage full", "QuotaExceededError");
  });
  expect(local.write(view, [{ op: "set", path: ["fontSize"], value: 20 }])).toBe(false);
  expect(local.read(view).value).toEqual({ preference: "system", fontSize: 16 });
});

async function forms() {
  const ctx = context();
  const runtime = { ...theme(), ns: "runtime", revision: 3 } as SettingsNamespaceView;
  const mutate = vi.fn(async () => ({
    ok: true,
    value: {
      ...runtime,
      user: { fontSize: 20 },
      value: { preference: "system", fontSize: 20 },
      revision: 4,
    },
  }));
  ctx.provide("remote", {
    settings: {
      describe: vi.fn(async () => ({
        ok: true,
        value: { namespaces: [...fixtures, runtime], writable: true, hasDocument: false },
      })),
      mutate,
    },
  } as unknown as Context["remote"]);
  const mirror = new SettingsDescribeMirror(ctx);
  await mirror.load();
  const provider = new ConfigForms(ctx, {
    mirror,
    schema: new SettingsSchemaService(ctx),
    persistence: "host",
  });
  return { provider, mirror, mutate };
}

it("routes UI preferences to browser storage while runtime configuration keeps its RPC", async () => {
  const { provider, mirror, mutate } = await forms();
  for (const namespace of browserNamespaces)
    expect(provider.get(namespace).getSnapshot().mode).toBe("browser");
  const local = provider.get("ui-theme");
  expect(await local.set("fontSize", 18)).toBe(true);
  expect(local.getSnapshot().value).toEqual({ preference: "system", fontSize: 18 });
  expect(mutate).not.toHaveBeenCalled();
  expect(mirror.namespace("ui-theme")?.user).toEqual({});

  const runtime = provider.get("runtime");
  expect(runtime.getSnapshot().mode).toBe("host");
  expect(await runtime.set("fontSize", 20)).toBe(true);
  expect(mutate).toHaveBeenCalledExactlyOnceWith(
    "runtime",
    [{ op: "set", path: ["fontSize"], value: 20 }],
    3,
  );
  expect(runtime.getSnapshot().revision).toBe(4);
});

it("adopts same-origin storage updates and removes listeners when its provider stops", async () => {
  const { provider } = await forms();
  const local = provider.get("ui-theme");
  const key = "codexhost.web.preferences.v1:ui-theme";
  const update = (fontSize: number): void => {
    localStorage.setItem(key, JSON.stringify({ user: { fontSize }, revision: fontSize }));
    window.dispatchEvent(new StorageEvent("storage", { key }));
  };
  update(18);
  expect(local.getSnapshot().value).toEqual({ preference: "system", fontSize: 18 });
  const remove = vi.spyOn(window, "removeEventListener");
  await contexts[0]!.fiber.dispose();
  expect(remove).toHaveBeenCalledWith("storage", expect.any(Function));
  const snapshot = local.getSnapshot();
  update(20);
  expect(local.getSnapshot()).toBe(snapshot);
  expect(await local.set("fontSize", 22)).toBe(false);
});
