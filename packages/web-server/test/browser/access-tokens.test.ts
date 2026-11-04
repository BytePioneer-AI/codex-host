/** Token management and revocation as a browser sees them. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it, type TestContext } from "node:test";
import { chromium, type Browser, type Page } from "playwright";

import { startServer } from "../support/server.ts";

const LOCAL_TOKEN = "browser-access-token-test";
const REMOTE_HOST = "codexhost-remote.test";

async function start(t: TestContext): Promise<{ local: URL; remote: URL; browser: Browser }> {
  const data = mkdtempSync(join(tmpdir(), "codexhost-token-browser-"));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  const local = new URL(
    await startServer(
      t,
      resolve(import.meta.dirname, "../.."),
      ["--import", "tsx", "src/main.ts"],
      ["--data", data, "--token", LOCAL_TOKEN],
      { authenticated: true },
    ),
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
  return { local, remote, browser };
}

async function openTokensPage(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByText("Access tokens", { exact: true }).first().click();
}

async function createToken(page: Page, name: string): Promise<string> {
  await page.getByRole("textbox", { name: "Token name" }).fill(name);
  await page.getByRole("button", { name: "Create token" }).click();
  const reveal = page.locator("[data-access-token-reveal]");
  await reveal.getByText(`Token: ${name}`, { exact: true }).waitFor();
  const secret = await reveal.getByRole("textbox").first().inputValue();
  assert.ok(secret.length > 32);
  await reveal.getByRole("button", { name: "Done" }).click();
  return secret;
}

async function deleteToken(page: Page, name: string): Promise<void> {
  const row = page.locator(`[data-access-token-row="${name}"]`);
  await row.getByRole("button", { name: "Delete" }).click();
  await row.getByText("signed out immediately").waitFor();
  await row.getByRole("button", { name: "Delete" }).click();
  await row.waitFor({ state: "detached" });
}

it(
  "manages tokens on this computer and shows only guidance elsewhere, at phone width too",
  { timeout: 90_000 },
  async (t) => {
    const { local, remote, browser } = await start(t);
    const context = await browser.newContext({ locale: "en-US" });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(local.href);
    assert.equal(new URL(page.url()).search, "");
    await openTokensPage(page);
    await page.getByText("No access tokens yet.").waitFor();
    await page.getByText("listening only on this computer").waitFor();

    const secret = await createToken(page, "My phone");
    await page.locator('[data-access-token-row="My phone"]').getByText("Created").waitFor();
    await page.getByRole("textbox", { name: "Token name" }).fill("My phone");
    await page.getByRole("button", { name: "Create token" }).click();
    await page.getByText("A token with this name already exists.").waitFor();

    // A fresh page can retrieve and copy the same token after the creation view is closed.
    await page.reload();
    await openTokensPage(page);
    await page
      .locator('[data-access-token-row="My phone"]')
      .getByRole("button", { name: "View", exact: true })
      .click();
    const reveal = page.locator("[data-access-token-reveal]");
    assert.equal(await reveal.getByRole("textbox").first().inputValue(), secret);
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await reveal.getByRole("button", { name: "Copy", exact: true }).first().click();
    await reveal.getByRole("button", { name: "Copied", exact: true }).waitFor();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), secret);
    await reveal.getByRole("button", { name: "Done" }).click();

    const phone = await browser.newContext({
      locale: "en-US",
      viewport: { width: 375, height: 700 },
    });
    const phonePage = await phone.newPage();
    phonePage.on("pageerror", (error) => errors.push(error.message));
    await phonePage.goto(`${remote.href}#token=${secret}`);
    await phonePage.waitForFunction(
      () => window.location.hash === "" && document.getElementById("form") === null,
    );
    // The cookie is HttpOnly and the token is gone from the address bar.
    assert.equal(phonePage.url().includes(secret), false);
    assert.equal(
      await phonePage.evaluate(() => document.cookie.includes("codexhost_token")),
      false,
    );

    await phonePage
      .getByRole("button", { name: "Open sidebar" })
      .click({ timeout: 2_000 })
      .catch(() => undefined);
    await openTokensPage(phonePage);
    const notice = phonePage.locator('[data-access-token-notice="non-local"]');
    await notice.waitFor();
    assert.match(
      (await notice.textContent()) ?? "",
      new RegExp(`http://127\\.0\\.0\\.1:${local.port}`, "u"),
    );
    assert.equal(await phonePage.getByText("My phone", { exact: true }).count(), 0);
    assert.equal(await phonePage.getByRole("button", { name: "Create token" }).count(), 0);

    // The local page stays usable at phone width with a long name and its reveal open.
    await page.setViewportSize({ width: 375, height: 700 });
    // Crossing the narrow breakpoint remounts the dialog; let that finish before typing.
    await page.waitForTimeout(500);
    const longName = "a very long token name that must wrap on a narrow phone screen ok";
    await page.getByRole("textbox", { name: "Token name" }).fill(longName.slice(0, 64));
    await page.getByRole("button", { name: "Create token" }).click();
    await page.locator("[data-access-token-reveal]").waitFor();
    const overflow = await page.evaluate(() => {
      const row = document.querySelector("[data-access-token-reveal]");
      const rect = row?.getBoundingClientRect();
      return rect === undefined ? Infinity : rect.right - window.innerWidth;
    });
    assert.ok(overflow <= 0, `reveal overflows the viewport by ${String(overflow)}px`);
    assert.deepEqual(errors, []);
  },
);

it(
  "enters sign-in when the token is deleted, online or offline, but not when the server is away",
  { timeout: 120_000 },
  async (t) => {
    const { local, remote, browser } = await start(t);
    const owner = await (await browser.newContext({ locale: "en-US" })).newPage();
    await owner.goto(local.href);
    await openTokensPage(owner);
    const online = await createToken(owner, "online");
    const offline = await createToken(owner, "offline");
    const spare = await createToken(owner, "spare");

    const signIn = async (token: string): Promise<Page> => {
      const page = await (await browser.newContext({ locale: "en-US" })).newPage();
      await page.goto(remote.href);
      await page.getByPlaceholder("Access token").fill(token);
      await page.getByRole("button", { name: "Continue" }).click();
      await page.getByRole("button", { name: "Settings", exact: true }).waitFor();
      return page;
    };
    const signedIn = await signIn(online);
    const other = await signIn(spare);

    await deleteToken(owner, "online");
    await signedIn.getByPlaceholder("Access token").waitFor({ timeout: 20_000 });
    // Another token's page keeps working.
    assert.equal(await other.getByPlaceholder("Access token").count(), 0);
    assert.equal(await other.evaluate(async () => (await fetch("api/auth/status")).status), 200);

    // Offline while its token is deleted; back on the network it finds out.
    const away = await signIn(offline);
    await away.context().setOffline(true);
    await deleteToken(owner, "offline");
    await away.waitForTimeout(1_000);
    assert.equal(await away.getByPlaceholder("Access token").count(), 0);
    await away.context().setOffline(false);
    await away.getByPlaceholder("Access token").waitFor({ timeout: 30_000 });

    // Server unreachable: the mux and the probe both fail, and the page stays.
    await other.routeWebSocket("**/api/remote.mux", (socket) => socket.close());
    await other.route("**/api/auth/status", (route) => route.abort("connectionrefused"));
    const probed = other.waitForRequest("**/api/auth/status");
    await other.evaluate(() => window.dispatchEvent(new Event("offline")));
    await other.evaluate(() => window.dispatchEvent(new Event("online")));
    await probed;
    await other.waitForTimeout(1_000);
    assert.equal(await other.getByPlaceholder("Access token").count(), 0);
    await other.getByRole("button", { name: "Settings", exact: true }).waitFor();
  },
);

it(
  "switches an already signed-in browser to a linked token and rejects bad tokens",
  { timeout: 60_000 },
  async (t) => {
    const { local, remote, browser } = await start(t);
    const owner = await (await browser.newContext({ locale: "en-US" })).newPage();
    await owner.goto(local.href);
    await openTokensPage(owner);
    const first = await createToken(owner, "first");
    const second = await createToken(owner, "second");

    const context = await browser.newContext({ locale: "en-US" });
    const page = await context.newPage();
    await page.goto(remote.href);
    await page.getByPlaceholder("Access token").fill("wrong-token");
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByText("That access token is not valid.").waitFor();
    assert.deepEqual(await context.cookies(), []);

    await page.goto(`${remote.href}#token=${first}`);
    await page.getByRole("button", { name: "Settings", exact: true }).waitFor();
    const cookie = async () => decodeURIComponent((await context.cookies())[0]?.value ?? "");
    assert.equal(await cookie(), first);

    await page.goto(`${remote.href}#token=${second}`);
    await page.waitForFunction(() => window.location.hash === "");
    await page.waitForResponse("**/plugins/**").catch(() => undefined);
    const deadline = Date.now() + 10_000;
    while ((await cookie()) !== second && Date.now() < deadline) await page.waitForTimeout(100);
    assert.equal(await cookie(), second);
    assert.equal(new URL(page.url()).hash, "");

    // The local token is not a token for this address.
    const elsewhere = await (await browser.newContext({ locale: "en-US" })).newPage();
    await elsewhere.goto(`${remote.href}?token=${LOCAL_TOKEN}`);
    await elsewhere.getByText("not valid here").waitFor();
    assert.equal(new URL(elsewhere.url()).search, "");
  },
);

it("runs previewed HTML without same-origin access to the app", { timeout: 60_000 }, async (t) => {
  const { local, browser } = await start(t);
  const page = await (await browser.newContext({ locale: "en-US" })).newPage();
  await page.goto(local.href);
  await page.getByRole("button", { name: "Settings", exact: true }).waitFor();
  // The same frame the document preview creates: an opaque-origin Blob document.
  const html = `<!doctype html><script>
    (async () => {
      const results = {};
      try { results.cookie = document.cookie; } catch (error) { results.cookie = "blocked"; }
      try {
        const response = await fetch(${JSON.stringify(new URL("/api/auth/status", local).href)}, { credentials: "include" });
        results.status = response.status;
      } catch { results.status = "blocked"; }
      parent.postMessage(results, "*");
    })();
  </script>`;
  const results = await page.evaluate(
    (source) =>
      new Promise<{ cookie: unknown; status: unknown }>((done) => {
        window.addEventListener("message", (event) => done(event.data), { once: true });
        const frame = document.createElement("iframe");
        frame.setAttribute("sandbox", "allow-scripts");
        frame.src = URL.createObjectURL(new Blob([source], { type: "text/html" }));
        document.body.append(frame);
      }),
    html,
  );
  assert.equal(results.cookie, "blocked");
  assert.equal(results.status, "blocked");
});
