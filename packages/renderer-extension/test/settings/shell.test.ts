import { describe, expect, it } from "vitest";

import {
  DEFAULT_RENDERER_SETTINGS_PAGE_IDS,
  createDefaultRendererSettingsPages,
  createDefaultRendererSettingsRegistry,
} from "../../src/settings/pages.js";
import { isRendererSettingsDialogSupported } from "../../src/settings/shell.js";

describe("Renderer settings foundation", () => {
  it("publishes deterministic product sections with Connections as the default", () => {
    const pages = createDefaultRendererSettingsPages();
    const registry = createDefaultRendererSettingsRegistry();

    expect(pages.map(({ id }) => id)).toEqual(DEFAULT_RENDERER_SETTINGS_PAGE_IDS);
    expect(pages.map(({ label }) => label)).toEqual([
      "Connections",
      "Model Pool",
      "Routes",
      "Gateway",
      "Updates",
    ]);
    expect(pages.map(({ icon }) => icon)).toEqual([
      "connections",
      "model-pool",
      "routes",
      "gateway",
      "updates",
    ]);
    expect(registry.defaultPageId).toBe("connections");
    expect(Object.isFrozen(pages)).toBe(true);
    expect(pages.every((page) => Object.isFrozen(page))).toBe(true);
  });

  it("enables the settings trigger only for a native modal dialog surface", () => {
    expect(
      isRendererSettingsDialogSupported({ showModal() {}, close() {} } as HTMLDialogElement),
    ).toBe(true);
    expect(
      isRendererSettingsDialogSupported({
        showModal: undefined,
        close() {},
      } as unknown as HTMLDialogElement),
    ).toBe(false);
    expect(
      isRendererSettingsDialogSupported({
        showModal() {},
        close: undefined,
      } as unknown as HTMLDialogElement),
    ).toBe(false);
  });

  it("keeps product placeholders unavailable while Connections provides diagnostics", () => {
    const pages = createDefaultRendererSettingsPages();
    const serializedPlaceholders = pages
      .filter(({ id }) => !["connections", "updates"].includes(id))
      .map(({ mount }) => mount.toString())
      .join("\n");
    expect(serializedPlaceholders).not.toMatch(/save|connect|start|test|api.?key|oauth|fetch/iu);
    expect(pages.find(({ id }) => id === "connections")?.mount.toString()).toContain(
      "connectionRefresh",
    );
  });
});
