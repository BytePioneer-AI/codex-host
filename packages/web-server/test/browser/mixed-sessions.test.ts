/** Real browser controls over isolated CH/Codex fixtures; no Desktop or model execution. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { it } from "node:test";
import { chromium } from "playwright";
import { startMixedSharedHost } from "../support/shared-mixed-host.ts";
import { startServer } from "../support/server.ts";
import { MixedChHost, writeWebCodexPlugin } from "../support/web-codex.ts";

it(
  "switches an unsent draft between CH and owned Codex and reopens a shared Thread",
  { timeout: 60_000 },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), "mixed-browser-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const plugins = writeWebCodexPlugin(root);
    const host = new MixedChHost();
    host.add("shared", root, "Shared GUI conversation");
    host.add("official", root, "Official GUI conversation").modelProvider = "openai";
    const shared = await startMixedSharedHost(t, root, plugins, host);
    const url = await startServer(
      t,
      resolve(import.meta.dirname, "../.."),
      ["--import", "tsx", "src/main.ts"],
      shared.args,
    );
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const consoleErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error" || /control stream failed/iu.test(message.text()))
        consoleErrors.push(`${message.text()} (${message.location().url})`);
    });
    const screenshot = async (name: string) => {
      if (!process.env.CODEXHOST_TEST_SCREENSHOTS) return;
      mkdirSync(process.env.CODEXHOST_TEST_SCREENSHOTS, { recursive: true });
      await page.screenshot({
        path: join(process.env.CODEXHOST_TEST_SCREENSHOTS, `${name}.png`),
        animations: "disabled",
      });
    };
    await page.goto(url);
    await page.waitForLoadState("networkidle");
    const folder = page
      .getByRole("treeitem")
      .filter({ hasText: new RegExp(`^${basename(root)}$`, "u") });
    await folder.waitFor();
    if ((await folder.getAttribute("aria-expanded")) === "false") await folder.click();
    await page.getByRole("treeitem").filter({ hasText: "Shared GUI conversation" }).click();
    await page.getByText("existing CH answer", { exact: true }).waitFor();
    assert.equal(
      await page.getByRole("treeitem").filter({ hasText: "Official GUI conversation" }).count(),
      0,
    );
    await screenshot("mixed-shared-history");
    await folder.hover();
    await page
      .getByRole("button", { name: `New session in ${basename(root)}`, exact: true })
      .click();
    await page.getByText("What should we build today?", { exact: true }).waitFor();
    const textbox = page.locator("[data-composer-input]");
    await textbox.fill("Draft retained across source selection");
    await page
      .getByRole("button", { name: "Select Harness, current CH Harness", exact: true })
      .click();
    await page.getByRole("menuitem", { name: "Web Codex", exact: true }).click();
    await page
      .getByRole("button", { name: "Select Harness, current Web Codex", exact: true })
      .waitFor();
    assert.equal(await textbox.innerText(), "Draft retained across source selection");
    await page
      .getByRole("button", { name: "Select Harness, current Web Codex", exact: true })
      .click();
    await page.getByRole("menuitem", { name: "CH Harness", exact: true }).click();
    await page
      .getByRole("button", { name: "Select Harness, current CH Harness", exact: true })
      .waitFor();
    assert.equal(await textbox.innerText(), "Draft retained across source selection");
    assert.equal(
      host.requests.some(({ method }) => ["thread/start", "turn/start"].includes(method)),
      false,
    );
    await page
      .getByRole("button", { name: "Select Harness, current CH Harness", exact: true })
      .click();
    await page.getByRole("menuitem", { name: "Web Codex", exact: true }).click();
    await page
      .getByRole("button", { name: "Select Harness, current Web Codex", exact: true })
      .waitFor();
    await screenshot("mixed-codex-draft");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await page.getByText("echo: Draft retained across source selection", { exact: true }).waitFor();
    assert.equal(
      host.requests.some(({ method }) =>
        ["thread/start", "turn/start", "thread/resume"].includes(method),
      ),
      false,
    );
    await screenshot("mixed-codex-result");
    await textbox.fill("Second turn after draft binding");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await page.getByText("echo: Second turn after draft binding", { exact: true }).waitFor();
    assert.deepEqual(
      [...consoleErrors],
      [],
      "control updates must survive the draft-to-Codex handoff",
    );
    await screenshot("mixed-codex-second-turn");
    await page.reload();
    await page.getByText("echo: Draft retained across source selection", { exact: true }).waitFor();
    await page.getByText("echo: Second turn after draft binding", { exact: true }).waitFor();
    await page.getByRole("treeitem").filter({ hasText: "Shared GUI conversation" }).click();
    await page.getByText("existing CH answer", { exact: true }).waitFor();
    await screenshot("mixed-shared-reopened");
    await textbox.fill("Shared source is preserved");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await page.getByText("CH response: Shared source is preserved", { exact: true }).waitFor();
    assert.equal(host.requests.filter(({ method }) => method === "turn/start").length, 1);
    assert.equal(
      host.requests.find(({ method }) => method === "turn/start")?.params.threadId,
      "shared",
    );
    await screenshot("mixed-shared-result");
    assert.deepEqual(errors, []);
    assert.deepEqual([...consoleErrors], []);
  },
);
