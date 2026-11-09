/** Web preferences persist per browser origin without changing the server's settings. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { chromium, type BrowserContext, type Page } from "playwright";
import { startServer } from "../support/server.ts";

const REMOTE_HOST = "codexhost-remote.test";

async function workDetails(page: Page) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  return dialog
    .getByText("Work details", { exact: true })
    .locator("..")
    .locator("..")
    .getByRole("button");
}

async function savedWorkDetails(page: Page, value: string): Promise<void> {
  await page.waitForFunction(
    (expected) =>
      JSON.parse(localStorage.getItem("codexhost.web.preferences.v1:ui-chat") ?? "null")?.user
        ?.transcriptView === expected,
    value,
  );
}

it(
  "keeps local and remote UI preferences in each browser, sharing only same-origin tabs",
  { timeout: 60_000 },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "codexhost-remote-settings-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const file = join(directory, "settings.json");
    const initialSettings = JSON.stringify({
      "ui-chat": { user: { transcriptView: "standard" }, revision: 1 },
    });
    writeFileSync(file, initialSettings);
    const token = "remote-settings-test-token";
    const local = await startServer(
      t,
      resolve(import.meta.dirname, "../.."),
      ["--import", "tsx", "src/main.ts"],
      ["--data", directory, "--token", token],
      { authenticated: true, useDefaultData: true },
    );
    const remote = new URL(local);
    remote.hostname = REMOTE_HOST;
    remote.search = "";
    const browser = await chromium.launch({
      args: [`--host-resolver-rules=MAP ${REMOTE_HOST} 127.0.0.1`],
      // Set explicitly so a proxy configured on the machine cannot intercept the test hostname.
      proxy: { server: "http://127.0.0.1:9", bypass: `${REMOTE_HOST},127.0.0.1` },
    });
    t.after(() => browser.close());
    const errors: string[] = [];
    const serverWrites: string[] = [];
    const observe = (context: BrowserContext): void => {
      context.on("page", (page) => page.on("pageerror", (error) => errors.push(error.message)));
      context.on("request", (request) => {
        if (new URL(request.url()).pathname === "/api/settings/mutate")
          serverWrites.push(request.url());
      });
    };
    const context = await browser.newContext({ locale: "en-US" });
    observe(context);
    const page = await context.newPage();
    await page.goto(remote.href);
    await page.getByPlaceholder("Access token").waitFor();
    assert.equal(
      await page.evaluate(
        async () => (await fetch("/api/settings/describe", { method: "POST" })).status,
      ),
      401,
    );

    const created = await fetch(new URL("/api/codexhost/accessTokenGet", local), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        type: "client-request",
        rpcId: "get",
        method: "codexhost/accessTokenGet",
        payload: { args: {} },
      }),
    });
    const remoteToken = ((await created.json()) as { result: { value: { secret: string } } }).result
      .value.secret;
    const signInLink = `${remote.href}#token=${remoteToken}`;
    await page.goto(signInLink);
    await page.waitForFunction(() => !window.location.hash && !document.getElementById("form"));
    assert.equal(new URL(page.url()).hostname, REMOTE_HOST);
    const selector = await workDetails(page);
    await selector.filter({ hasText: "Standard" }).waitFor({ timeout: 10_000 });
    await selector.click();
    await page.getByRole("menuitem", { name: "Compact", exact: true }).click();
    await savedWorkDetails(page, "compact");
    await page.getByRole("dialog").getByRole("button", { name: "Dark", exact: true }).click();
    await page.waitForFunction(
      () =>
        JSON.parse(localStorage.getItem("codexhost.web.preferences.v1:ui-theme") ?? "null")?.user
          ?.preference === "dark",
    );
    assert.equal(readFileSync(file, "utf8"), initialSettings);

    await page.reload();
    const restored = await workDetails(page);
    await restored.filter({ hasText: "Compact" }).waitFor();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Dark", exact: true, pressed: true })
      .waitFor();

    // Tabs in the same browser and origin share saved preferences and receive changes live.
    const sibling = await context.newPage();
    await sibling.goto(remote.href);
    const siblingSelector = await workDetails(sibling);
    await siblingSelector.filter({ hasText: "Compact" }).waitFor();
    await siblingSelector.click();
    await sibling.getByRole("menuitem", { name: "Detailed", exact: true }).click();
    await savedWorkDetails(sibling, "detailed");
    await restored.filter({ hasText: "Detailed" }).waitFor();

    // An independent browser starts from the server's saved preferences, not another browser's.
    const other = await browser.newContext({ locale: "en-US" });
    observe(other);
    const second = await other.newPage();
    await second.goto(signInLink);
    const independent = await workDetails(second);
    await independent.filter({ hasText: "Standard" }).waitFor();
    await second
      .getByRole("dialog")
      .getByRole("button", { name: "System", exact: true, pressed: true })
      .waitFor();

    // Loopback access also writes browser preferences, isolated from the remote origin.
    const localPage = await context.newPage();
    await localPage.goto(local);
    const localSelector = await workDetails(localPage);
    await localSelector.filter({ hasText: "Standard" }).waitFor();
    await localSelector.click();
    await localPage.getByRole("menuitem", { name: "Verbose", exact: true }).click();
    await savedWorkDetails(localPage, "verbose");
    await localPage.reload();
    await (await workDetails(localPage)).filter({ hasText: "Verbose" }).waitFor();
    await restored.filter({ hasText: "Detailed" }).waitFor();
    await independent.filter({ hasText: "Standard" }).waitFor();

    assert.equal(readFileSync(file, "utf8"), initialSettings);
    assert.deepEqual(serverWrites, []);
    assert.deepEqual(errors, []);
  },
);
