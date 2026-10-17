/** Two real Web clients observing one durable Host owner; no real Harness execution. */
import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { it } from "node:test";
import { chromium, type Page } from "playwright";
import { HarnessPreferencesStore } from "@codexhost/harness-plugin-files";
import {
  harnessPreferencePatchSchema,
  HARNESS_PREFERENCES_GET_METHOD,
  HARNESS_PREFERENCES_PATCH_METHOD,
} from "@codexhost/shared-contracts";
import { FakeChChannel, startFakeChChannel } from "../support/ch-channel.ts";
import { startFakeChDebugger } from "../support/ch-host.ts";
import { startServer } from "../support/server.ts";

it(
  "synchronizes favorites and idle policy without refresh, and restores new-session defaults",
  { timeout: 40_000 },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), "web-shared-preferences-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const store = new HarnessPreferencesStore(root);
    t.after(() => store.close());
    const host = new FakeChChannel();
    host.add("shared", root, "Shared conversation");
    host.inspection.catalog.models.push({ ref: { id: "alternate" }, label: "Alternate Model" });
    const request = host.request.bind(host);
    host.request = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
      if (method === HARNESS_PREFERENCES_GET_METHOD)
        return (await store.get(String(params.scope ?? "external"))) as T;
      if (method === HARNESS_PREFERENCES_PATCH_METHOD)
        return (await store.patch(harnessPreferencePatchSchema.parse(params))) as T;
      return request<T>(method, params);
    };
    await store.subscribe((revision) => {
      const cursor = { epoch: host.epoch, sequence: ++host.sequence };
      for (const listener of host.listeners)
        listener({ type: "preferences-changed", cursor, revision });
    });
    const debug = await startFakeChDebugger(host);
    t.after(() => debug.close());
    const channelDirectory = join(root, "client-hosts");
    const channel = await startFakeChChannel(host, channelDirectory);
    t.after(() => channel.close());
    const url = await startServer(
      t,
      resolve(import.meta.dirname, "../.."),
      ["--import", "tsx", "src/main.ts"],
      [
        "--session-source",
        "codexhost",
        "--ch-cdp",
        debug.endpoint,
        "--ch-control-directory",
        channelDirectory,
      ],
    );
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const a = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const b = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors: string[] = [];
    for (const page of [a, b]) {
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(url);
      const folder = page.getByRole("treeitem").filter({ hasText: basename(root) });
      await folder.waitFor();
      if ((await folder.getAttribute("aria-expanded")) === "false") await folder.click();
      await page.getByRole("treeitem").filter({ hasText: "Shared conversation" }).click();
    }
    const openModels = async (page: Page) => {
      await page.getByRole("button", { name: /^Select model, current /u }).click();
      await page
        .getByRole("menu", { name: "Thinking", exact: true })
        .getByRole("menuitem", { name: "Native Model", exact: true })
        .click();
    };
    await openModels(a);
    await openModels(b);
    await a.getByRole("menuitem", { name: "Favorite model Alternate Model", exact: true }).click();
    await b
      .getByRole("menuitem", { name: "Remove model Alternate Model from favorites", exact: true })
      .waitFor();
    assert.deepEqual((await store.get()).values.favorites.fake, ["alternate"]);
    await store.patch(
      harnessPreferencePatchSchema.parse({
        operations: [{ kind: "favorite", harnessId: "fake", modelId: "native", enabled: true }],
      }),
    );
    await a
      .getByRole("menuitem", { name: "Remove model Native Model from favorites", exact: true })
      .waitFor();
    await b
      .getByRole("menuitem", { name: "Remove model Native Model from favorites", exact: true })
      .waitFor();
    await a.getByRole("menuitemradio", { name: "Alternate Model", exact: true }).click();
    await b.keyboard.press("Escape");
    await b.keyboard.press("Escape");
    for (const page of [a, b])
      await page.getByRole("button", { name: "Settings", exact: true }).click();
    const policy = (page: Page) =>
      page.getByRole("checkbox", { name: "Release idle external Harness sessions", exact: true });
    await policy(a).click();
    await expect(policy(a)).toBeChecked();
    await b.getByRole("spinbutton", { name: "Idle timeout (minutes)", exact: true }).waitFor();
    assert.equal(await policy(b).isChecked(), true);
    await store.patch(
      harnessPreferencePatchSchema.parse({
        operations: [
          { kind: "idleRelease", value: { enabled: true, timeoutMinutes: 42 } },
          {
            kind: "newThread",
            lastHarness: "fake",
            harnessId: "fake",
            configuration: { model: { id: "alternate" }, permissionModeId: "auto" },
          },
        ],
      }),
    );
    for (const page of [a, b]) {
      const timeout = page.getByRole("spinbutton", { name: "Idle timeout (minutes)", exact: true });
      await timeout.waitFor();
      await expect(timeout).toHaveValue("42");
      assert.equal(await timeout.inputValue(), "42");
    }
    if (process.env.CODEXHOST_TEST_SCREENSHOTS) {
      mkdirSync(process.env.CODEXHOST_TEST_SCREENSHOTS, { recursive: true });
      await b.screenshot({
        path: join(process.env.CODEXHOST_TEST_SCREENSHOTS, "shared-preferences.png"),
      });
    }
    await b.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
    await b
      .getByRole("treeitem")
      .filter({ hasText: basename(root) })
      .hover();
    await b.getByRole("button", { name: `New session in ${basename(root)}`, exact: true }).click();
    await b
      .getByRole("button", { name: "Select model, current Alternate Model", exact: true })
      .waitFor();
    assert.equal(
      host.requests.some(
        (entry) => entry.method === "thread/start" || entry.method === "turn/start",
      ),
      false,
    );
    assert.deepEqual(errors, []);
  },
);
