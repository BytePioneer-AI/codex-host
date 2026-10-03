import { describe, expect, it } from "vitest";

import {
  DEFAULT_RENDERER_SETTINGS_PAGE_IDS,
  createDefaultRendererSettingsPages,
  createDefaultRendererSettingsRegistry,
} from "../../src/settings/pages.js";
import { RENDERER_SETTINGS_COLOR_SCHEME } from "../../src/settings/shell.js";

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
      "Remote connections",
      "Accounts",
      "Session Import",
      "General",
      "Updates",
      "About",
    ]);
    expect(pages.map(({ icon }) => icon)).toEqual([
      "connections",
      "gateway",
      "accounts",
      "session-import",
      "settings",
      "updates",
      "about",
    ]);
    expect(registry.defaultPageId).toBe("connections");
    expect(Object.isFrozen(pages)).toBe(true);
    expect(pages.every((page) => Object.isFrozen(page))).toBe(true);
  });

  it("publishes only available settings pages", () => {
    const pages = createDefaultRendererSettingsPages();

    expect(pages.map(({ id }) => id)).toEqual([
      "connections",
      "remote-connections",
      "accounts",
      "session-import",
      "appearance",
      "updates",
      "about",
    ]);
    expect(pages.find(({ id }) => id === "connections")?.mount.toString()).toContain(
      "connectionRefresh",
    );
  });
});
