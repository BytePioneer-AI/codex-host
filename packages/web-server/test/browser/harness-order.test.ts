import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { it } from "node:test";
import { chromium } from "playwright";
import { expect } from "@playwright/test";
import {
  HARNESS_DISPLAY_GET_METHOD,
  HARNESS_DISPLAY_SET_METHOD,
  HARNESS_DISPLAY_CAPABILITIES_METHOD,
  harnessDisplaySetSchema,
} from "@codexhost/shared-contracts";
import { startFakeChDebugger } from "../support/ch-host.ts";
import { writeWebCodexPlugin } from "../support/web-codex.ts";
import { FakeChChannel, startFakeChChannel } from "../support/ch-channel.ts";
import { startServer } from "../support/server.ts";

it(
  "updates an open Harness menu from Host and Web writes and restores ordering on visibility",
  { timeout: 30_000 },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "web-harness-order-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    writeFileSync(
      join(directory, "harness-display-settings-v1.json"),
      JSON.stringify([
        { agent: "grok", section: "main" },
        { agent: "fake", section: "auto" },
      ]),
    );
    const plugins = writeWebCodexPlugin(directory);
    const host = new FakeChChannel();
    host.add("shared", directory, "Shared conversation");
    const request = host.request.bind(host);
    host.request = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
      if (method === HARNESS_DISPLAY_CAPABILITIES_METHOD) return { events: true } as T;
      if (method === HARNESS_DISPLAY_GET_METHOD)
        return {
          entries: JSON.parse(
            readFileSync(join(directory, "harness-display-settings-v1.json"), "utf8"),
          ),
        } as T;
      if (method === HARNESS_DISPLAY_SET_METHOD) {
        const { entries } = harnessDisplaySetSchema.parse(params);
        writeFileSync(join(directory, "harness-display-settings-v1.json"), JSON.stringify(entries));
        const cursor = { epoch: host.epoch, sequence: ++host.sequence };
        for (const listener of host.listeners)
          listener({ type: "display-settings-changed", cursor });
        return { entries } as T;
      }
      if (method === "codexhost/harness/plugins/list") {
        const value = await request<{ plugins: unknown[] }>(method, params);
        return { plugins: [...value.plugins, { id: "grok", name: "Grok", version: "1" }] } as T;
      }
      if (method === "codexhost/harness/inspect" && params.harnessId === "grok")
        return {
          status: "unavailable",
          error: { code: "unavailable", message: "Authentication required", retryable: false },
        } as T;
      return request<T>(method, params);
    };
    const debug = await startFakeChDebugger(host);
    t.after(() => debug.close());
    const channelDirectory = join(directory, "client-hosts");
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
        "--adapters",
        plugins,
        "--harness",
        "codex",
      ],
    );
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(url);
    const folder = page.getByRole("treeitem").filter({ hasText: basename(directory) });
    await folder.waitFor();
    if ((await folder.getAttribute("aria-expanded")) === "false") await folder.click();
    await page.getByRole("treeitem").filter({ hasText: "Shared conversation" }).click();
    await page
      .getByRole("button", { name: "Select Harness, current CH Harness", exact: true })
      .click();
    await page.getByRole("menuitem", { name: "Web Codex", exact: true }).waitFor();
    const labels = (await page.getByRole("menuitem").allTextContents()).map((value) =>
      value.trim(),
    );
    assert.equal(labels[0], "Web Codex");
    assert.match(labels[1] ?? "", /^Grok/u);
    assert.equal(labels[2], "CH Harness");
    assert.equal(await page.getByRole("menuitem").filter({ hasText: "Grok" }).isDisabled(), true);
    const nativeFirst = [
      { agent: "fake", section: "main" },
      { agent: "grok", section: "auto" },
    ];
    await host.request(HARNESS_DISPLAY_SET_METHOD, { entries: nativeFirst });
    await expect(page.getByRole("menuitem").nth(1)).toHaveText("CH Harness");
    const grokFirst = [...nativeFirst].reverse();
    const response = await fetch(new URL("api/codexhost/display-settings/set", url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "client-request",
        rpcId: "order-web-write",
        method: "codexhost/display-settings/set",
        payload: { args: { request: { entries: grokFirst } } },
      }),
    });
    const result = (await response.json()) as { result: { ok: boolean } };
    assert.equal(result.result.ok, true);
    await expect(page.getByRole("menuitem").nth(1)).toContainText("Grok");
    assert.deepEqual(
      JSON.parse(readFileSync(join(directory, "harness-display-settings-v1.json"), "utf8")),
      grokFirst,
    );
    const other = await page.context().newPage();
    await other.goto("about:blank");
    writeFileSync(join(directory, "harness-display-settings-v1.json"), JSON.stringify(nativeFirst));
    await page.bringToFront();
    // Headless Chromium does not reliably emit OS window focus on bringToFront.
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.getByRole("menuitem").nth(1)).toHaveText("CH Harness");
    await other.close();

    assert.equal(
      host.requests.some((entry) => ["thread/start", "turn/start"].includes(entry.method)),
      false,
    );
    if (process.env.CODEXHOST_TEST_SCREENSHOTS) {
      mkdirSync(process.env.CODEXHOST_TEST_SCREENSHOTS, { recursive: true });
      await page.screenshot({
        path: join(process.env.CODEXHOST_TEST_SCREENSHOTS, "harness-order.png"),
      });
    }
    assert.deepEqual(errors, []);
  },
);
