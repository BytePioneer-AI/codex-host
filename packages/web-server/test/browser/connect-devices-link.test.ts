/** Launcher links enter the existing settings section without adding a route. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it, type TestContext } from "node:test";
import { chromium, type Page } from "playwright";
import { startServer } from "../support/server.ts";

async function start(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "codexhost-connect-link-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const login = new URL(
    await startServer(
      t,
      resolve(import.meta.dirname, "../.."),
      ["--import", "tsx", "src/main.ts"],
      ["--port", "4478", "--data", join(root, "web"), "--token", "connect-link-test-token"],
      {
        authenticated: true,
        environment: {
          HOME: root,
          CODEXHOST_DATA_DIR: join(root, "host"),
          CODEX_HOME: join(root, "codex"),
          CODEXHOST_CONSOLE_PORT: "4479",
          SSH_CONNECTION: "smoke",
        },
      },
    ),
  );
  const browser = await chromium.launch();
  t.after(() => browser.close());
  return { login, browser };
}

async function assertSettingsClosed(page: Page): Promise<void> {
  await page
    .getByRole("button", { name: "Settings", exact: true, includeHidden: true })
    .waitFor({ state: "attached" });
  assert.equal(await page.getByRole("dialog", { name: "Settings", exact: true }).count(), 0);
  assert.equal(await page.locator("[data-connect-devices]").count(), 0);
}

it(
  "preserves the fragment through the real token 302 in Chromium",
  { timeout: 60_000 },
  async (t) => {
    const { login, browser } = await start(t);
    const page = await browser.newPage({ javaScriptEnabled: false });
    login.hash = "connect-devices";
    const response = await page.goto(login.href);
    const redirect = await response?.request().redirectedFrom()?.response();
    assert.equal(redirect?.status(), 302);
    assert.equal(redirect?.headers().location, "/");
    assert.equal(new URL(page.url()).search, "");
    assert.equal(new URL(page.url()).hash, "#connect-devices");
    assert.equal(response?.status(), 200);
    t.diagnostic(`302 Location: / -> ${page.url()}`);
  },
);

for (const width of [1280, 375]) {
  it(
    `opens Remote access once for fresh and signed-in browsers at ${width}px`,
    { timeout: 60_000 },
    async (t) => {
      const { login, browser } = await start(t);
      const context = await browser.newContext({
        locale: "en-US",
        viewport: { width, height: 800 },
      });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      assert.deepEqual(await context.cookies(), []);
      login.hash = "connect-devices";
      for (const signedIn of [false, true]) {
        await page.goto(login.href);
        const section = page.locator("[data-connect-devices]");
        await section.waitFor();
        await page.getByRole("dialog", { name: "Settings", exact: true }).waitFor();
        const nav = page
          .getByRole("dialog")
          .getByRole("button", { name: "Remote access", exact: true });
        await nav.waitFor();
        assert.equal(await nav.getAttribute("aria-current"), "true");
        assert.equal(new URL(page.url()).hash, "");
        assert.equal(new URL(page.url()).search, "");
        const bounds = await section.boundingBox();
        assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width);
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
          true,
        );
        assert.ok((await context.cookies()).some((cookie) => cookie.name === "codexhost_token"));
        await page.reload();
        await assertSettingsClosed(page);
        t.diagnostic(
          `${signedIn ? "signed-in" : "fresh"} browser: section visible, hash cleared, reload closed`,
        );
      }
      assert.deepEqual(errors, []);
    },
  );
}

it("leaves ordinary, other-hash and token-hash links unchanged", { timeout: 60_000 }, async (t) => {
  const { login, browser } = await start(t);
  const page = await browser.newPage({ locale: "en-US" });
  await page.goto(login.href);
  await assertSettingsClosed(page);
  const home = new URL(login);
  home.search = "";
  home.hash = "other-section";
  await page.goto(home.href);
  await page.reload();
  await assertSettingsClosed(page);
  assert.equal(new URL(page.url()).hash, "#other-section");

  const fresh = await browser.newPage({ locale: "en-US" });
  const errors: string[] = [];
  fresh.on("pageerror", (error) => errors.push(error.message));
  home.hash = `token=${login.searchParams.get("token")}`;
  await fresh.goto(home.href);
  await assertSettingsClosed(fresh);
  assert.equal(new URL(fresh.url()).hash, "");
  assert.deepEqual(errors, []);
});

it(
  "handles an expired login link without errors and still permits sign-in",
  { timeout: 60_000 },
  async (t) => {
    const { login, browser } = await start(t);
    const page = await browser.newPage({ locale: "en-US" });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const expired = new URL(login);
    expired.searchParams.set("token", "expired-token");
    expired.hash = "connect-devices";
    await page.goto(expired.href);
    await page.getByText("That link is not valid here.", { exact: false }).waitFor();
    const token = login.searchParams.get("token");
    assert.ok(token);
    await page.getByPlaceholder("Access token").fill(token);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await assertSettingsClosed(page);
    assert.equal(new URL(page.url()).search, "");
    assert.equal(new URL(page.url()).hash, "");
    const connected = new URL(page.url());
    connected.hash = "connect-devices";
    await page.goto("about:blank");
    await page.goto(connected.href);
    await page.locator("[data-connect-devices]").waitFor();
    assert.equal(new URL(page.url()).hash, "");
    assert.deepEqual(errors, []);
  },
);
