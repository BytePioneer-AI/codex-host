// @vitest-environment jsdom
import {
  HOST_EXTENSIONS_RPC as rpc,
  type HostExtensionPageApi,
  type HostExtensionRuntimeEntry,
} from "@codexhost/shared-contracts";
import { afterEach, expect, it, vi } from "vitest";
import { installDesktopExtensionHost } from "../src/desktop-extension-host.js";
import { moduleEntry } from "./fixtures/desktop-extension-modules.js";
import { createDesktopExtensionWidgetHost } from "../src/desktop-extension-widget-host.js";
import { createRendererModelClient } from "../src/renderer-model-client.js";

const label = { en: "Timer", "zh-CN": "计时器" };
function widget(id: string): HostExtensionRuntimeEntry {
  return {
    id,
    activationId: "00000000-0000-4000-8000-000000000000",
    digest: "a".repeat(64),
    settingsRevision: 0,
    installedAt: "2026-01-01T00:00:00.000Z",
    manifest: {
      id,
      manifestVersion: 2,
      name: label,
      description: label,
      version: "1",
      widget: { apiVersion: 1, entry: "widget/index.mjs", style: "widget/style.css" },
      backend: { apiVersion: 1, entry: "backend/index.mjs" },
    },
  };
}

const container = (id: string) =>
  document.body.querySelector<HTMLElement>(`[data-cx-host-widget="${id}"]`);
const flush = async () => vi.advanceTimersByTimeAsync(0);
const css = ".capsule { color: var(--cx-page-accent); }";

afterEach(() => {
  delete window.__codexhostDesktopExtensionsV1;
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.documentElement.removeAttribute("data-theme");
  document.body.replaceChildren();
});

it("mounts a widget from the local snapshot, delivers settings and UI context in place, and retires generations", async () => {
  vi.useFakeTimers();
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  document.documentElement.setAttribute("data-theme", "dark");
  const original = widget("timer");
  let entries = [original];
  let settings = { settingsRevision: 0, values: { minutes: 25 } };
  let locale = "en";
  const changes: string[] = [];
  const apis: HostExtensionPageApi[] = [];
  const cleanup = vi.fn();
  const create = vi.fn(async () => ({
    namespace: {
      mount(root: HTMLElement, api: HostExtensionPageApi) {
        apis.push(api);
        root.textContent = "Timer capsule";
        api.storage.onChange((values) => changes.push(`minutes:${String(values.minutes)}`));
        api.onColorSchemeChange((value) => changes.push(value));
        api.onLocaleChange((value) => changes.push(value));
        return cleanup;
      },
    },
  }));
  const runtime = installDesktopExtensionHost(window);
  const client = createRendererModelClient([
    {
      async sendRequest(method, params) {
        switch (method) {
          case rpc.snapshot:
            return { revision: settings.settingsRevision, extensions: entries };
          case rpc.asset:
            expect(params).toMatchObject({
              id: original.id,
              activationId: entries[0]?.activationId,
              digest: entries[0]?.digest,
              path: "widget/style.css",
            });
            return { mimeType: "text/css", base64: btoa(css), digest: entries[0]?.digest };
          case rpc.settingsGet:
            return settings;
          case rpc.settingsSet:
            expect(params).toMatchObject({
              id: "timer",
              activationId: original.activationId,
              expectedSettingsRevision: 0,
              values: { minutes: 15 },
            });
            settings = { settingsRevision: 1, values: { minutes: 15 } };
            entries = [{ ...original, settingsRevision: 1 }];
            return settings;
          case rpc.backendInvoke:
            expect(params).toMatchObject({ id: "timer", method: "ping" });
            return { result: "pong" };
          default:
            throw new Error(method);
        }
      },
    },
  ]);
  const host = createDesktopExtensionWidgetHost({
    document,
    getClient: () => client,
    getLocale: () => locale,
  });
  try {
    await flush();
    expect(container("timer")).toBeNull();
    await runtime.reconcile([], [moduleEntry("widget", original, create)]);
    await flush();
    const el = container("timer");
    const [api] = apis;
    if (!api) throw new Error("Timer widget did not mount");
    expect(create).toHaveBeenCalledOnce();
    expect(el?.parentNode).toBe(document.body);
    expect(el?.style.position).toBe("fixed");
    expect(el?.style.inset).toBe("0px");
    expect(el?.style.pointerEvents).toBe("none");
    expect(el?.style.zIndex).toBe("900");
    expect(el?.style.colorScheme).toBe("dark");
    expect(el?.shadowRoot?.textContent).toContain(css);
    expect(el?.shadowRoot?.textContent).toContain("Timer capsule");
    expect(api).toMatchObject({ hostTarget: "desktop", locale: "en", colorScheme: "dark" });
    await expect(api.backend.invoke("ping")).resolves.toBe("pong");

    await api.storage.set({ minutes: 15 });
    await flush();
    expect(changes).toEqual(["minutes:15"]);
    // External writes and generation changes are picked up only by visible polling.
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    settings = { settingsRevision: 2, values: { minutes: 5 } };
    entries = [{ ...original, settingsRevision: 2 }];
    await vi.advanceTimersByTimeAsync(5_000);
    expect(changes).toEqual(["minutes:15"]);
    vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    document.dispatchEvent(new Event("visibilitychange"));
    await flush();
    locale = "zh-CN";
    host.syncLocale();
    document.documentElement.setAttribute("data-theme", "light");
    await flush();
    expect(changes).toEqual(["minutes:15", "minutes:5", "zh-CN", "light"]);
    expect(container("timer")).toBe(el);
    expect(el?.lang).toBe("zh-CN");
    expect(el?.style.colorScheme).toBe("light");

    const updated = { ...original, settingsRevision: 2, digest: "b".repeat(64) };
    await runtime.reconcile([], [moduleEntry("widget", updated, create)]);
    expect(api.signal.aborted).toBe(true);
    expect(container("timer")).toBeNull();
    entries = [updated];
    await vi.advanceTimersByTimeAsync(5_000);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(container("timer")).not.toBe(el);
    expect(container("timer")?.shadowRoot?.textContent).toContain("Timer capsule");
    host.dispose();
    expect(apis[1]?.signal.aborted).toBe(true);
    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(container("timer")).toBeNull();
  } finally {
    host.dispose();
  }
});

it("isolates failed widgets and aborts an unfinished mount when the extension is disabled", async () => {
  vi.useFakeTimers();
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  const slow = widget("slow");
  const broken = widget("broken");
  let entries = [broken, slow];
  let api: HostExtensionPageApi | undefined;
  const { promise, resolve } = Promise.withResolvers<() => void>();
  const disposer = vi.fn();
  const client = createRendererModelClient([
    {
      async sendRequest(method) {
        if (method === rpc.snapshot) return { revision: 1, extensions: entries };
        if (method === rpc.asset)
          return { mimeType: "text/css", base64: btoa(css), digest: slow.digest };
        if (method === rpc.disable) {
          entries = entries.filter(({ id }) => id !== slow.id);
          return { state: "saved", configuration: { revision: 2, enabled: ["broken"] } };
        }
        throw new Error(method);
      },
    },
  ]);
  const runtime = installDesktopExtensionHost(window);
  const badFactory = vi.fn(async () => {
    throw new Error("failed module");
  });
  await runtime.reconcile(
    [],
    [
      moduleEntry("widget", broken, badFactory),
      moduleEntry("widget", slow, async () => ({
        namespace: {
          mount(root: HTMLElement, received: HostExtensionPageApi) {
            root.textContent = "mounting";
            api = received;
            return promise;
          },
        },
      })),
    ],
  );
  const host = createDesktopExtensionWidgetHost({
    document,
    getClient: () => client,
    getLocale: () => "en",
  });
  try {
    await flush();
    expect(container("broken")).toBeNull();
    expect(runtime.modules.status()["broken:widget"]).toMatchObject({
      state: "failed",
      error: "failed module",
    });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(badFactory).toHaveBeenCalledOnce();
    expect(container("slow")?.shadowRoot?.textContent).toContain("mounting");
    if (!client?.disableHostExtension) throw new Error("Extension client is unavailable");
    await client.disableHostExtension({ id: slow.id, expectedRevision: 1 });
    await flush();
    expect(api?.signal.aborted).toBe(true);
    expect(container("slow")).toBeNull();
    resolve(disposer);
    await flush();
    expect(disposer).toHaveBeenCalledOnce();
  } finally {
    host.dispose();
  }
});
