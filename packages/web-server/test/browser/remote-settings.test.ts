/** Remote Web preferences use the authenticated server's durable settings, not page memory. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { chromium, type Page } from "playwright";
import { startServer } from "../support/server.ts";

async function workDetails(page: Page) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  return dialog
    .getByText("Work details", { exact: true })
    .locator("..")
    .locator("..")
    .getByRole("button");
}

it(
  "remote work details load, persist, and survive reloads and new browser sessions",
  { timeout: 60_000 },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "codexhost-remote-settings-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const file = join(directory, "settings.json");
    writeFileSync(
      file,
      JSON.stringify({ "ui-chat": { user: { transcriptView: "standard" }, revision: 1 } }),
    );
    const token = "remote-settings-test-token";
    const local = await startServer(
      t,
      resolve(import.meta.dirname, "../.."),
      ["--import", "tsx", "src/main.ts"],
      ["--data", directory, "--token", token],
      { authenticated: true, useDefaultData: true },
    );
    const remote = new URL(local);
    remote.hostname = "codexhost-remote.test";
    remote.search = "";
    const browser = await chromium.launch({
      args: ["--host-resolver-rules=MAP codexhost-remote.test 127.0.0.1", "--no-proxy-server"],
    });
    t.after(() => browser.close());
    const page = await browser.newPage({ locale: "en-US" });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(remote.href);
    await page.getByPlaceholder("Access token").waitFor();
    assert.equal(
      await page.evaluate(
        async () => (await fetch("/api/settings/describe", { method: "POST" })).status,
      ),
      401,
    );

    remote.searchParams.set("token", token);
    await page.goto(remote.href);
    assert.equal(new URL(page.url()).hostname, "codexhost-remote.test");
    const selector = await workDetails(page);
    await selector.filter({ hasText: "Standard" }).waitFor({ timeout: 10_000 });
    await selector.click();
    const saved = page.waitForResponse((response) =>
      response.url().includes("/api/settings/mutate"),
    );
    await page.getByRole("menuitemradio", { name: "Compact", exact: true }).click();
    assert.equal((await (await saved).json()).result.ok, true);
    assert.equal(JSON.parse(readFileSync(file, "utf8"))["ui-chat"].user.transcriptView, "compact");

    await page.reload();
    await (await workDetails(page)).filter({ hasText: "Compact" }).waitFor();
    const other = await browser.newContext({ locale: "en-US" });
    const second = await other.newPage();
    await second.goto(remote.href);
    await (await workDetails(second)).filter({ hasText: "Compact" }).waitFor();
    assert.deepEqual(errors, []);
  },
);
