import { describe, expect, it } from "vitest";

import {
  DEFAULT_RENDERER_SETTINGS_PAGE_IDS,
  createDefaultRendererSettingsPages,
  createDefaultRendererSettingsRegistry,
} from "../../src/settings/pages.js";
import {
  RENDERER_SETTINGS_COLOR_SCHEME,
  isRendererSettingsDialogSupported,
} from "../../src/settings/shell.js";

describe("Renderer settings foundation", () => {
  it("inherits the Codex theme instead of forcing a dark settings surface", () => {
    expect(RENDERER_SETTINGS_COLOR_SCHEME).toBe("inherit");
  });

  it("publishes deterministic product sections with Connections as the default", () => {
    const pages = createDefaultRendererSettingsPages();
    const registry = createDefaultRendererSettingsRegistry();

    expect(pages.map(({ id }) => id)).toEqual(DEFAULT_RENDERER_SETTINGS_PAGE_IDS);
    expect(pages.map(({ label }) => label)).toEqual([
      "Connections",
      "Accounts",
      "Updates",
      "About",
    ]);
    expect(pages.map(({ icon }) => icon)).toEqual(["connections", "accounts", "updates", "about"]);
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

  it("publishes only available settings pages", () => {
    const pages = createDefaultRendererSettingsPages();

    expect(pages.map(({ id }) => id)).toEqual(["connections", "accounts", "updates", "about"]);
    expect(pages.find(({ id }) => id === "connections")?.mount.toString()).toContain(
      "connectionRefresh",
    );
  });
});
