import { describe, expect, it } from "vitest";

import {
  DEFAULT_RENDERER_SETTINGS_PAGE_IDS,
  createDefaultRendererSettingsPages,
  createDefaultRendererSettingsRegistry,
} from "../../src/settings/pages.js";
import { isRendererSettingsDialogSupported } from "../../src/settings/shell.js";

describe("Renderer settings foundation", () => {
  it("publishes deterministic placeholder sections with Overview as the default", () => {
    const pages = createDefaultRendererSettingsPages();
    const registry = createDefaultRendererSettingsRegistry();

    expect(pages.map(({ id }) => id)).toEqual(DEFAULT_RENDERER_SETTINGS_PAGE_IDS);
    expect(pages.map(({ label }) => label)).toEqual([
      "Overview",
      "Routes",
      "Providers",
      "Credentials",
      "Local Models",
      "Gateway",
    ]);
    expect(pages.map(({ icon }) => icon)).toEqual([
      "overview",
      "routes",
      "providers",
      "credentials",
      "local-models",
      "gateway",
    ]);
    expect(registry.defaultPageId).toBe("overview");
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

  it("keeps the foundation free of executable configuration controls", () => {
    const serializedMounts = createDefaultRendererSettingsPages()
      .map(({ mount }) => mount.toString())
      .join("\n");
    expect(serializedMounts).not.toMatch(/save|connect|start|test|api.?key|oauth|fetch/iu);
  });
});
