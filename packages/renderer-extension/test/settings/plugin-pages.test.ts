import { afterEach, expect, it, vi } from "vitest";
import { loadPluginSettingsPages } from "../../src/settings/plugin-pages.js";
import { createRendererSettingsPageRegistry } from "../../src/settings/core.js";

afterEach(() => vi.useRealTimers());
it("leaves older Hosts without the extension API unchanged", async () => {
  const pages = await loadPluginSettingsPages(
    () => ({
      listSettingsPages: async () => {
        throw { code: -32601 };
      },
      readSettingsPage: vi.fn(),
    }),
    "en",
    new AbortController().signal,
  );
  expect(pages).toEqual([]);
});
it("namespaces page IDs, validates text metadata and isolates unavailable plugins", async () => {
  const definitions = await loadPluginSettingsPages(
    () => ({
      listSettingsPages: async () => ({
        pages: [
          { pluginId: "one", id: "about", title: "First", icon: "🧩" },
          { pluginId: "two", id: "about", title: "Second", icon: "KB" },
        ],
        unavailable: ["missing"],
      }),
      readSettingsPage: vi.fn(),
    }),
    "en",
    new AbortController().signal,
  );
  expect(createRendererSettingsPageRegistry(definitions).pages.map((page) => page.id)).toEqual([
    "plugin/one/about",
    "plugin/two/about",
    "plugin-pages-unavailable",
  ]);
  expect(definitions[0]?.iconText).toBe("🧩");
  const first = definitions[0];
  if (!first) throw new Error("Missing registered settings page");
  expect(() => createRendererSettingsPageRegistry([{ ...first, iconText: " " }])).toThrow(
    "text icon",
  );
});
it("bounds discovery failures without blocking built-in settings and ignores cancelled discovery", async () => {
  vi.useFakeTimers();
  const client = {
    listSettingsPages: () => new Promise<never>(() => {}),
    readSettingsPage: vi.fn(),
  };
  const pending = loadPluginSettingsPages(() => client, "en", new AbortController().signal);
  await vi.advanceTimersByTimeAsync(5_000);
  expect((await pending).map((page) => page.id)).toEqual(["plugin-pages-unavailable"]);
  const controller = new AbortController();
  const cancelled = loadPluginSettingsPages(() => client, "en", controller.signal);
  controller.abort();
  expect(await cancelled).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
});
