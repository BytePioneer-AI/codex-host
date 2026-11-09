/** Connecting devices, regenerating the token, and signing out as a browser sees them. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it, type TestContext } from "node:test";
import { chromium, type Browser, type Page } from "playwright";

import { networkAccessUrls } from "../../src/network-urls.ts";
import { addressValue, chooseTailscaleHttps } from "../support/connect-devices.ts";
import { startServer } from "../support/server.ts";
import { fakeTailscale, RUNNING, serveStatus, SERVE_HOST } from "../support/tailscale.ts";

const LOCAL_TOKEN = "browser-access-token-test";
const REMOTE_HOST = "codexhost-remote.test";

async function start(
  t: TestContext,
  args: string[] = [],
  environment?: NodeJS.ProcessEnv,
): Promise<{ local: URL; remote: URL; browser: Browser }> {
  const data = mkdtempSync(join(tmpdir(), "codexhost-token-browser-"));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  const local = new URL(
    await startServer(
      t,
      resolve(import.meta.dirname, "../.."),
      ["--import", "tsx", "src/main.ts"],
      ["--data", data, "--token", LOCAL_TOKEN, ...args],
      { authenticated: true, ...(environment === undefined ? {} : { environment }) },
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

async function openConnectPage(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Remote access", exact: true })
    .click();
}

/** The token stays out of the main page and is only copied. */
async function tokenOnPage(page: Page): Promise<string> {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.evaluate(() => navigator.clipboard.writeText(""));
  await page.getByRole("button", { name: "Copy token", exact: true }).click();
  await page.waitForFunction(async () => (await navigator.clipboard.readText()).length > 32);
  const secret = await page.evaluate(() => navigator.clipboard.readText());
  assert.ok(secret.length > 32);
  return secret;
}

async function regenerate(page: Page): Promise<string> {
  const previous = await tokenOnPage(page);
  await page.getByRole("button", { name: "Regenerate…" }).click();
  const dialog = page.getByRole("dialog", { name: "Regenerate the access token?" });
  await dialog.getByText("signed out immediately").waitFor();
  await dialog.getByRole("button", { name: "Regenerate", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  const next = await tokenOnPage(page);
  assert.notEqual(next, previous);
  return next;
}

it(
  "copies the token locally through More and only offers guidance and sign-out elsewhere",
  { timeout: 90_000 },
  async (t) => {
    const { local, remote, browser } = await start(t);
    const context = await browser.newContext({ locale: "en-US" });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(local.href);
    assert.equal(new URL(page.url()).search, "");
    await openConnectPage(page);
    await page.getByText("Local access only", { exact: true }).waitFor();
    await page.getByText("No device has signed in yet").waitFor();
    const secret = await tokenOnPage(page);

    // A fresh page shows and copies the same token.
    await page.reload();
    await openConnectPage(page);
    assert.equal(await tokenOnPage(page), secret);

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
    await openConnectPage(phonePage);
    const notice = phonePage.locator('[data-connect-notice="non-local"]');
    await notice.waitFor();
    assert.match(
      (await notice.textContent()) ?? "",
      new RegExp(`http://127\\.0\\.0\\.1:${local.port}`, "u"),
    );
    assert.equal(await phonePage.getByRole("textbox", { name: "Access token" }).count(), 0);
    assert.equal(await phonePage.getByRole("button", { name: "Regenerate…" }).count(), 0);

    // Signing out warns first, returns to sign-in, and leaves the token valid.
    await phonePage.getByRole("button", { name: "Sign out…" }).click();
    const confirm = phonePage.getByRole("dialog", { name: "Sign out of this device?" });
    await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
    await confirm.waitFor({ state: "detached" });
    await phonePage.getByRole("button", { name: "Sign out…" }).click();
    await confirm.getByRole("button", { name: "Sign out", exact: true }).click();
    await phonePage.getByPlaceholder("Access token").waitFor();
    assert.deepEqual(await phone.cookies(), []);
    await phonePage.getByPlaceholder("Access token").fill(secret);
    await phonePage.getByRole("button", { name: "Continue" }).click();
    await phonePage.waitForFunction(() => document.getElementById("form") === null);

    // The local page stays usable at phone width.
    await page.setViewportSize({ width: 375, height: 700 });
    await page.waitForTimeout(500);
    await page
      .getByRole("button", { name: "Open sidebar" })
      .click({ timeout: 2_000 })
      .catch(() => undefined);
    const overflow = await page.evaluate(() => {
      const section = document.querySelector("[data-connect-devices]");
      const rect = section?.getBoundingClientRect();
      return rect === undefined ? 0 : rect.right - window.innerWidth;
    });
    assert.ok(overflow <= 0, `page overflows the viewport by ${String(overflow)}px`);
    assert.deepEqual(errors, []);
  },
);

it(
  "connects a device by QR code and link for the chosen address",
  { timeout: 60_000 },
  async (t) => {
    if (networkAccessUrls("0.0.0.0", 1).length === 0)
      return t.skip("this machine has no network address");
    const { local, browser } = await start(t, ["--host", "0.0.0.0"]);
    const context = await browser.newContext({ locale: "en-US" });
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const page = await context.newPage();
    await page.goto(local.href);
    await openConnectPage(page);

    const qr = page.getByRole("img", { name: "Sign-in QR code" });
    await qr.waitFor();
    const address = page.getByLabel("Connection address", { exact: true });
    const first = await addressValue(address);
    assert.equal(first.includes("#token="), false);
    await page.getByRole("button", { name: "Copy link" }).click();
    await page.getByRole("button", { name: "Copied", exact: true }).waitFor();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    assert.match(copied, /^https?:\/\/[^/]+\/#token=[\w-]{32,}$/u);
    assert.equal(copied.includes(LOCAL_TOKEN), false);
    assert.equal(
      new URL(copied).host,
      new URL(first.startsWith("http") ? first : `http://${first}`).host,
    );

    // Virtual networks stay folded until asked for, so the first choice is never one of them.
    const routes = networkAccessUrls("0.0.0.0", 1);
    const virtualCount = routes.filter((route) => route.kind === "virtual").length;
    if (routes.some((route) => route.kind !== "virtual") && virtualCount > 0) {
      assert.equal(await page.locator('[data-connect-route="virtual"]:visible').count(), 0);
      await page.getByText("Other connection methods", { exact: true }).click();
      await page.locator('[data-connect-route="virtual"]').first().click();
      assert.notEqual(await addressValue(address), first);
    }

    const small = await qr.boundingBox();
    await page.getByRole("button", { name: "Enlarge QR code" }).click();
    const large = await page
      .getByRole("dialog", { name: "Scan with your phone camera" })
      .getByRole("img", { name: "Sign-in QR code" })
      .boundingBox();
    assert.ok((large?.width ?? 0) > (small?.width ?? Infinity));
  },
);

it(
  "shows contextual Tailscale setup and HTTPS choices at phone width",
  { timeout: 60_000 },
  async (t) => {
    const cli = fakeTailscale(t);
    const { local, browser } = await start(t, ["--host", "0.0.0.0"], { PATH: cli.directory });
    const context = await browser.newContext({ locale: "en-US" });
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const page = await context.newPage();
    await page.goto(local.href);
    await openConnectPage(page);
    await chooseTailscaleHttps(page);
    await page.locator('[data-tailscale-status="not-running"]').waitFor();
    for (const [status, backend] of [
      ["not-logged-in", { BackendState: "NeedsLogin" }],
      ["https-disabled", { BackendState: "Running", Self: {} }],
      ["not-serving", RUNNING],
    ] as const) {
      cli.set(backend);
      await page.reload();
      await openConnectPage(page);
      await chooseTailscaleHttps(page);
      await page.locator(`[data-tailscale-status="${status}"]`).waitFor();
    }
    await page.getByRole("button", { name: "Enable and show QR code" }).waitFor();
    assert.equal(await page.getByRole("textbox", { name: "Serve command" }).count(), 0);
    assert.equal(
      await page.getByRole("switch", { name: "Tailscale HTTPS", exact: true }).count(),
      0,
    );
    cli.set(RUNNING, serveStatus(3000));
    await page.reload();
    await openConnectPage(page);
    await chooseTailscaleHttps(page);
    await page
      .locator('[data-tailscale-status="occupied"]')
      .getByText("http://127.0.0.1:3000", { exact: true })
      .waitFor();
    assert.equal(await page.getByRole("textbox", { name: "Serve command" }).count(), 0);
    for (const funnel of [false, true]) {
      cli.set(RUNNING, serveStatus(Number(local.port), funnel));
      await page.reload();
      await openConnectPage(page);
      const route = page.locator(
        `[data-connect-route="${funnel ? "tailscale-funnel" : "tailscale-https"}"]`,
      );
      await route.waitFor();
      assert.equal(await page.locator("[data-tailscale-status]").count(), 0);
      assert.equal(await page.getByText("another program using this port").count(), 0);
      assert.equal(await route.getByRole("radio").isChecked(), true);
      assert.equal(
        await page.getByLabel("Connection address", { exact: true }).inputValue(),
        SERVE_HOST,
      );
      if (funnel) await page.getByText("Anyone on the Internet").first().waitFor();
    }
    cli.set(RUNNING, {}, { raw: "not-json" });
    await page.reload();
    await openConnectPage(page);
    await chooseTailscaleHttps(page);
    await page.locator('[data-tailscale-status="error"]').waitFor();
    cli.set(RUNNING);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await page.getByRole("button", { name: "Open sidebar" }).click();
    await openConnectPage(page);
    await chooseTailscaleHttps(page);
    await page.locator('[data-tailscale-status="not-serving"]').waitFor();
    assert.equal(await page.getByRole("img", { name: "Sign-in QR code" }).count(), 0);
    const bounds = await page.locator("[data-connect-devices]").boundingBox();
    assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 390);
    const remoteOptions = page.locator("[data-remote-options]");
    const tailscaleLink = remoteOptions.getByRole("link", { name: "Download Tailscale" });
    assert.equal(await tailscaleLink.isVisible(), false);
    await remoteOptions.getByText("Having trouble connecting?").click();
    await tailscaleLink.waitFor();
    await remoteOptions.getByRole("link", { name: "View setup guide" }).waitFor();
    await remoteOptions.getByText("Cloudflare Tunnel", { exact: false }).waitFor();
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
      true,
    );
  },
);

it("selects the configured public address ahead of Serve", { timeout: 30_000 }, async (t) => {
  const cli = fakeTailscale(t);
  const { local, browser } = await start(
    t,
    ["--public-url", "http://code.example.com"],
    cli.environment,
  );
  cli.set(RUNNING, serveStatus(Number(local.port), true));
  const page = await browser.newPage({ locale: "en-US" });
  await page.goto(local.href);
  await openConnectPage(page);
  await page.locator('[data-connect-route="public"]').waitFor();
  assert.equal(await page.locator("[data-tailscale-status]").count(), 0);
  assert.equal(
    await page.locator('[data-connect-route="public"]').getByRole("radio").isChecked(),
    true,
  );
  assert.equal(
    await page.getByRole("textbox", { name: "Connection address" }).inputValue(),
    "code.example.com",
  );
});

it(
  "enters sign-in when the token is regenerated, online or offline, but not when the server is away",
  { timeout: 120_000 },
  async (t) => {
    const { local, remote, browser } = await start(t);
    const owner = await (await browser.newContext({ locale: "en-US" })).newPage();
    await owner.goto(local.href);
    await openConnectPage(owner);

    const signIn = async (token: string): Promise<Page> => {
      const page = await (await browser.newContext({ locale: "en-US" })).newPage();
      await page.goto(remote.href);
      await page.getByPlaceholder("Access token").fill(token);
      await page.getByRole("button", { name: "Continue" }).click();
      await page.getByRole("button", { name: "Settings", exact: true }).waitFor();
      return page;
    };
    const signedIn = await signIn(await tokenOnPage(owner));

    const second = await regenerate(owner);
    await signedIn.getByPlaceholder("Access token").waitFor({ timeout: 20_000 });
    // This computer's page keeps working.
    assert.equal(await owner.evaluate(async () => (await fetch("api/auth/status")).status), 200);

    // Offline while the token is replaced; back on the network it finds out.
    const away = await signIn(second);
    await away.context().setOffline(true);
    const third = await regenerate(owner);
    await away.waitForTimeout(1_000);
    assert.equal(await away.getByPlaceholder("Access token").count(), 0);
    await away.context().setOffline(false);
    await away.getByPlaceholder("Access token").waitFor({ timeout: 30_000 });

    // Server unreachable: the mux and the probe both fail, and the page stays.
    const other = await signIn(third);
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
  "moves a browser holding a replaced token to the new link and rejects bad tokens",
  { timeout: 60_000 },
  async (t) => {
    const { local, remote, browser } = await start(t);
    const owner = await (await browser.newContext({ locale: "en-US" })).newPage();
    await owner.goto(local.href);
    await openConnectPage(owner);
    const first = await tokenOnPage(owner);

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

    const second = await regenerate(owner);
    await page.goto(`${remote.href}#token=${second}`);
    await page.getByRole("button", { name: "Settings", exact: true }).waitFor();
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
