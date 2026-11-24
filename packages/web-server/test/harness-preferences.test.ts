import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { WebHarnessPreferences } from "../src/harness-preferences.ts";
import { EventHub } from "../src/transport.ts";
import { FakeChChannel } from "./support/ch-channel.ts";

it("retains normal catalogs when an older Host lacks preference methods", async () => {
  const root = mkdtempSync(join(tmpdir(), "web-old-preferences-"));
  const prefs = new WebHarnessPreferences(new FakeChChannel(), new EventHub(root));
  try {
    const result = await prefs.decorate({
      default: { provider: "fake", model: "native" },
      groups: [],
    });
    assert.equal(result.preferencesAvailable, false);
    assert.equal(result.default.model, "native");
  } finally {
    await prefs.close();
    rmSync(root, { recursive: true, force: true });
  }
});
