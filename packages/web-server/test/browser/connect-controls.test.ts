import assert from "node:assert/strict";
import { it } from "node:test";
import { chromium, type Page } from "playwright";
import { connectServer } from "../support/connect-devices.ts";
import { fakeServe } from "../support/serve-control.ts";
import { serveStatus, SERVE_HOST } from "../support/tailscale.ts";

const DIRECT = "Direct (local network, Tailscale IP)";

async function openConnect(page: Page) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByText("Connect devices", { exact: true }).first().click();
}
async function confirmDirect(page: Page, enabled: boolean) {
  const name = enabled ? "Enable direct connections" : "Disable direct connections";
  await page.getByRole("switch", { name: DIRECT, exact: true }).click();
  await page.getByRole("dialog", { name }).getByRole("button", { name, exact: true }).click();
}
async function confirmServe(page: Page, enabled: boolean) {
  const name = enabled ? "Enable Tailscale Serve" : "Disable Tailscale Serve";
  await page.getByRole("switch", { name: "Tailscale HTTPS", exact: true }).click();
  const dialog = page.getByRole("dialog", { name });
  await dialog.getByRole("button", { name, exact: true }).click();
  await dialog.waitFor({ state: "detached" });
}

it(
  "confirms Serve, refreshes conflicts/failures, removes only root and denies phone writes",
  { timeout: 90_000 },
  async (t) => {
    const cli = fakeServe(t);
    const server = await connectServer(t, cli.environment, false, [
      "--public-url",
      "https://public.example",
    ]);
    const browser = await chromium.launch({
      args: ["--host-resolver-rules=MAP phone.example 127.0.0.1"],
      proxy: { server: "http://127.0.0.1:9", bypass: "phone.example,127.0.0.1" },
    });
    t.after(() => browser.close());
    const page = await browser.newPage({ locale: "en-US" });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${server.url}?token=${server.token}`);
    await openConnect(page);
    assert.equal(await page.locator("[data-background-controls]").count(), 0);
    assert.equal(
      await page.locator('[data-connect-route="public"]').getByRole("radio").isChecked(),
      true,
    );
    await page.getByRole("switch", { name: "Tailscale HTTPS", exact: true }).click();
    cli.set(serveStatus(3000));
    const dialog = page.getByRole("dialog", { name: "Enable Tailscale Serve" });
    await dialog.getByRole("button", { name: "Enable Tailscale Serve", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    await page
      .locator('[data-tailscale-status="occupied"]')
      .getByText("http://127.0.0.1:3000", { exact: true })
      .waitFor();
    await page
      .getByRole("alert")
      .getByText("no configuration was modified", { exact: false })
      .waitFor();
    assert.deepEqual(cli.mutations(), []);
    const serve = page.getByRole("switch", { name: "Tailscale HTTPS", exact: true });
    assert.equal(await serve.isDisabled(), true);
    assert.equal(await serve.isChecked(), false);

    cli.set({}, { noop: true });
    await page.reload();
    await openConnect(page);
    await confirmServe(page, true);
    await page.getByRole("alert").getByText("did not take effect", { exact: false }).waitFor();
    await page.locator('[data-tailscale-status="not-serving"]').waitFor();
    cli.set();
    await confirmServe(page, true);
    const route = page.locator('[data-connect-route="tailscale-https"]');
    await route.waitFor();
    assert.equal(await route.getByRole("radio").isChecked(), true);
    assert.ok(
      (await page.getByRole("textbox", { name: "Sign-in link" }).inputValue()).startsWith(
        `https://${SERVE_HOST}/#token=`,
      ),
    );
    assert.equal(await serve.isChecked(), true);

    const other = { Proxy: "http://127.0.0.1:3000" };
    cli.set({
      TCP: { "443": { HTTPS: true }, "8443": { HTTPS: true } },
      Web: {
        [`${SERVE_HOST}:443`]: {
          Handlers: { "/": { Proxy: "http://127.0.0.1:4474" }, "/other": other },
        },
        [`${SERVE_HOST}:8443`]: { Handlers: { "/": other } },
      },
    });
    await confirmServe(page, false);
    assert.deepEqual(cli.read().Web, {
      [`${SERVE_HOST}:443`]: { Handlers: { "/other": other } },
      [`${SERVE_HOST}:8443`]: { Handlers: { "/": other } },
    });
    assert.equal(cli.mutations().at(-1), "serve --https=443 --set-path=/ off");
    const { secret } = await server.access();
    const phone = await browser.newPage({ locale: "en-US", viewport: { width: 375, height: 700 } });
    await phone.goto(`http://phone.example:4474/#token=${secret}`);
    await phone.getByRole("button", { name: "Open sidebar" }).click();
    await openConnect(phone);
    await phone.locator('[data-connect-notice="non-local"]').waitFor();
    assert.equal(await phone.getByRole("switch").count(), 0);
    assert.equal(await phone.locator("[data-background-controls]").count(), 0);
    const before = cli.mutations();
    for (const enabled of [true, false]) {
      const rejected = await phone.evaluate(async (enabled) => {
        const method = "codexhost/tailscaleServeSet";
        return (
          await (
            await fetch(`api/${method}`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ method, payload: { args: { enabled } } }),
            })
          ).json()
        ).result;
      }, enabled);
      assert.equal(rejected.error.code, "auth/local-access-required");
    }
    assert.deepEqual(cli.mutations(), before);
    await page.setViewportSize({ width: 375, height: 700 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    assert.equal(
      await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    assert.deepEqual(errors, []);
  },
);

it(
  "restores the page after LAN restart and hides background controls on a phone",
  { timeout: 90_000 },
  async (t) => {
    const cli = fakeServe(t);
    const server = await connectServer(t, cli.environment, true);
    const browser = await chromium.launch({
      args: ["--host-resolver-rules=MAP phone.example 127.0.0.1"],
      proxy: { server: "http://127.0.0.1:9", bypass: "phone.example,127.0.0.1" },
    });
    t.after(() => browser.close());
    const page = await browser.newPage({ locale: "en-US", viewport: { width: 390, height: 844 } });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${server.url}?token=${server.token}`);
    await page.getByRole("button", { name: "Open sidebar" }).click();
    await openConnect(page);
    const lan = page.getByRole("switch", { name: DIRECT, exact: true });
    assert.equal(await lan.isChecked(), false);
    await lan.click();
    await page
      .getByRole("dialog", { name: "Enable direct connections" })
      .getByRole("button", { name: "Cancel", exact: true })
      .click();
    assert.deepEqual(server.exits, []);
    assert.equal(await lan.isChecked(), false);
    const autostart = page.getByRole("switch", {
      name: "Start automatically after login",
      exact: true,
    });
    await autostart.click();
    await page.waitForFunction(
      () =>
        document
          .querySelector('[role="switch"][aria-label="Start automatically after login"]')
          ?.getAttribute("aria-checked") === "true",
    );
    assert.equal(server.autostart(), "on");
    await autostart.click();
    await page.waitForFunction(
      () =>
        document
          .querySelector('[role="switch"][aria-label="Start automatically after login"]')
          ?.getAttribute("aria-checked") === "false",
    );
    server.failAutostart("systemd user service unavailable");
    await autostart.click();
    await page.getByRole("alert").getByText("systemd user service unavailable").waitFor();
    assert.equal(await autostart.isChecked(), false);
    await confirmDirect(page, true);
    await page.getByRole("status").getByText("Restarting Web", { exact: false }).waitFor();
    await page.waitForFunction(
      (name) =>
        document
          .querySelector(`[role="switch"][aria-label="${name}"]`)
          ?.getAttribute("aria-checked") === "true",
      DIRECT,
    );
    assert.deepEqual(server.exits, [42]);
    await page.getByRole("img", { name: "Sign-in QR code" }).waitFor();
    assert.equal(await page.getByText("Restarting Web", { exact: false }).count(), 0);
    const bounds = await page.locator("[data-background-controls]").boundingBox();
    assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 390);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    const { secret } = await server.access();
    const phone = await browser.newPage({ locale: "en-US", viewport: { width: 375, height: 700 } });
    await phone.goto(`http://phone.example:4474/#token=${secret}`);
    await phone.getByRole("button", { name: "Open sidebar" }).click();
    await openConnect(phone);
    await phone.locator('[data-connect-notice="non-local"]').waitFor();
    assert.equal(await phone.getByRole("switch").count(), 0);
    assert.equal(await phone.locator("[data-background-controls]").count(), 0);
    await confirmDirect(page, false);
    await page.waitForFunction(
      (name) =>
        document
          .querySelector(`[role="switch"][aria-label="${name}"]`)
          ?.getAttribute("aria-checked") === "false",
      DIRECT,
    );
    assert.deepEqual(server.exits, [42, 42]);
    await page.getByRole("textbox", { name: "Access token", exact: true }).waitFor();
    assert.equal(await lan.isEnabled(), true);
    await page.getByText("How to connect from other networks").click();
    await page.getByText("codexhost web --public-url", { exact: false }).waitFor();
    assert.deepEqual(cli.mutations(), []);
    assert.deepEqual(errors, []);
  },
);
