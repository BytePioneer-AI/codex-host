import { describe, expect, it } from "vitest";

import { createAppearanceSettingsPage } from "../../src/settings/appearance-page.js";
import { rendererSettingsMessages } from "../../src/settings/localization.js";

describe("Appearance settings page", () => {
  it("does not access preferences when its document has no Window", () => {
    const page = createAppearanceSettingsPage(rendererSettingsMessages("en"));
    const context = {
      content: { ownerDocument: { defaultView: null } },
    } as unknown as Parameters<typeof page.mount>[0];

    expect(page.mount(context)).toBeUndefined();
  });
});
