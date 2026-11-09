import assert from "node:assert/strict";
import { it } from "node:test";
import { chromium, type Page } from "playwright";
import { addressValue, chooseTailscaleHttps, connectServer } from "../support/connect-devices.ts";
import { fakeServe } from "../support/serve-control.ts";
import { serveStatus, SERVE_HOST } from "../support/tailscale.ts";

async function openConnect(page: Page) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Remote access", exact: true })
    .click();
  await page.locator("[data-connect-devices]").waitFor();
}
async function choose(page: Page, kind: string) {
  if (!(await page.locator(`[data-connect-route="${kind}"]`).isVisible()))
    await page.getByText("Other connection methods", { exact: true }).click();
  if (kind === "tailscale-https") await chooseTailscaleHttps(page);
  else await page.locator(`[data-connect-route="${kind}"]`).getByRole("radio").check();
}
async function stop(page: Page) {
  await page.getByRole("button", { name: "Stop access…", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Stop device access?" });
  await dialog.getByRole("button", { name: "Stop access", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
}

it(
  "enables HTTPS contextually, refreshes conflicts, stops owned roots and denies phone writes",
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
    assert.equal(await page.getByRole("switch").count(), 0);
    assert.equal(
      await page.locator('[data-connect-route="public"]').getByRole("radio").isChecked(),
      true,
    );
    await choose(page, "tailscale-https");
    assert.equal(await page.getByRole("img", { name: "Sign-in QR code" }).count(), 0);
    assert.deepEqual(cli.mutations(), []);
    cli.set(serveStatus(3000));
    await page.getByRole("button", { name: "Enable and show QR code" }).click();
    await page
      .locator('[data-tailscale-status="occupied"]')
      .getByText("http://127.0.0.1:3000", { exact: true })
      .waitFor();
    await page
      .getByRole("alert")
      .getByText("no configuration was modified", { exact: false })
      .waitFor();
    assert.deepEqual(cli.mutations(), []);
    assert.equal(await page.getByRole("button", { name: "Enable and show QR code" }).count(), 0);

    cli.set({}, { noop: true });
    await page.getByRole("button", { name: "Refresh status", exact: true }).click();
    await page.getByRole("button", { name: "Enable and show QR code" }).click();
    await page.getByRole("alert").getByText("did not take effect", { exact: false }).waitFor();
    assert.equal(await page.getByRole("img", { name: "Sign-in QR code" }).count(), 0);
    cli.set();
    await page.getByRole("button", { name: "Enable and show QR code" }).click();
    await page.getByRole("img", { name: "Sign-in QR code" }).waitFor();
    assert.equal(
      await page.getByRole("textbox", { name: "Connection address" }).inputValue(),
      SERVE_HOST,
    );
    assert.equal(
      await page.locator('[data-connect-route="tailscale-https"]').getByRole("radio").isChecked(),
      true,
    );
    assert.equal(await page.getByRole("textbox", { name: "Access token" }).count(), 0);

    cli.set(serveStatus(4474), { noop: true });
    await page.getByRole("button", { name: "Stop access…", exact: true }).click();
    const failedStop = page.getByRole("dialog", { name: "Stop device access?" });
    await failedStop.getByRole("button", { name: "Stop access", exact: true }).click();
    await failedStop
      .getByRole("alert")
      .getByText("did not take effect", { exact: false })
      .waitFor();
    await failedStop.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.getByRole("img", { name: "Sign-in QR code" }).waitFor();

    const other = { Proxy: "http://127.0.0.1:3000" };
    const ours = { Proxy: "http://127.0.0.1:4474" };
    cli.set({
      TCP: { "443": { HTTPS: true }, "8443": { HTTPS: true }, "9443": { HTTPS: true } },
      Web: {
        [`${SERVE_HOST}:443`]: { Handlers: { "/": ours, "/other": other } },
        [`${SERVE_HOST}:8443`]: { Handlers: { "/": ours } },
        [`${SERVE_HOST}:9443`]: { Handlers: { "/": other } },
      },
    });
    await page.getByRole("button", { name: "Stop access…", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Stop device access?" });
    await dialog.getByText("managed separately", { exact: false }).waitFor();
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    assert.equal(cli.mutations().filter((entry) => entry.endsWith(" off")).length, 1);
    await stop(page);
    assert.deepEqual(cli.read().Web, {
      [`${SERVE_HOST}:443`]: { Handlers: { "/other": other } },
      [`${SERVE_HOST}:8443`]: { Handlers: {} },
      [`${SERVE_HOST}:9443`]: { Handlers: { "/": other } },
    });
    assert.deepEqual(cli.mutations().slice(-2), [
      "serve --https=443 --set-path=/ off",
      "serve --https=8443 --set-path=/ off",
    ]);
    // An external proxy is not claimed to have been stopped.
    await page.getByText("Device access enabled", { exact: true }).waitFor();
    await choose(page, "public");
    await page.getByRole("img", { name: "Sign-in QR code" }).waitFor();

    const { secret } = await server.access();
    const phone = await browser.newPage({ locale: "en-US", viewport: { width: 375, height: 700 } });
    await phone.goto(`http://phone.example:4474/#token=${secret}`);
    await phone.getByRole("button", { name: "Open sidebar" }).click();
    await phone.getByRole("button", { name: "Settings", exact: true }).click();
    await phone
      .getByRole("dialog")
      .getByRole("button", { name: "Remote access", exact: true })
      .click();
    await phone.locator('[data-connect-notice="non-local"]').waitFor();
    assert.equal(await phone.getByRole("button", { name: "Copy token" }).count(), 0);
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
  "previews LAN without enabling it, restores its QR after restart and persists access",
  { timeout: 90_000 },
  async (t) => {
    const cli = fakeServe(t);
    const server = await connectServer(t, cli.environment, true);
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ locale: "en-US", viewport: { width: 390, height: 844 } });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${server.url}?token=${server.token}`);
    await page.getByRole("button", { name: "Open sidebar" }).click();
    await openConnect(page);
    const initial = await server.access();
    assert.equal(initial.background?.lan, false);
    assert.deepEqual(initial.networkUrls, []);
    const candidates = initial.directCandidates ?? [];
    if (!candidates.some((entry) => entry.kind === "lan"))
      return t.skip("No LAN interface on this machine");
    assert.equal(await page.getByRole("switch").count(), 1);
    assert.equal(await page.getByRole("img", { name: "Sign-in QR code" }).count(), 0);
    await choose(page, "tailscale-https");
    await choose(page, "lan");
    assert.deepEqual(server.exits, []);
    assert.deepEqual(cli.mutations(), []);
    assert.equal((await server.access()).background?.lan, false);
    const address = page.getByLabel("Connection address", { exact: true });
    assert.ok((await addressValue(address)).length > 0);

    const startup = page.locator("[data-background-controls]");
    const autostart = startup.getByRole("switch", { name: "Start automatically after login" });
    await autostart.click();
    await page.waitForFunction(
      () => document.querySelector('[role="switch"]')?.getAttribute("aria-checked") === "true",
    );
    assert.equal(server.autostart(), "on");
    await autostart.click();
    await page.waitForFunction(
      () => document.querySelector('[role="switch"]')?.getAttribute("aria-checked") === "false",
    );
    server.failAutostart("systemd user service unavailable");
    await autostart.click();
    await startup.getByRole("alert").getByText("systemd user service unavailable").waitFor();
    assert.equal(await autostart.isChecked(), false);
    await page.getByRole("button", { name: "Enable and show QR code" }).click();
    await page.getByRole("status").getByText("Restarting Web", { exact: false }).waitFor();
    await page.getByRole("img", { name: "Sign-in QR code" }).waitFor();
    assert.deepEqual(server.exits, [42]);
    assert.equal((await server.access()).background?.lan, true);
    assert.equal(await page.getByRole("button", { name: "Enable and show QR code" }).count(), 0);
    await page.reload();
    await page.getByRole("button", { name: "Open sidebar" }).click();
    await openConnect(page);
    await page.getByRole("img", { name: "Sign-in QR code" }).waitFor();
    assert.deepEqual(server.exits, [42]);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );

    // Stop both configured entry points, with the listener restart last.
    await choose(page, "tailscale-https");
    await page.getByRole("button", { name: "Enable and show QR code" }).click();
    await page.getByRole("img", { name: "Sign-in QR code" }).waitFor();
    await stop(page);
    await page.getByText("Local access only", { exact: true }).waitFor();
    assert.deepEqual(server.exits, [42, 42]);
    assert.equal(await page.getByRole("img", { name: "Sign-in QR code" }).count(), 0);
    const stopped = await server.access();
    assert.equal(stopped.background?.lan, false);
    assert.deepEqual(stopped.networkUrls, []);
    assert.deepEqual(cli.mutations(), [
      "serve --bg http://127.0.0.1:4474",
      "serve --https=443 --set-path=/ off",
    ]);
    await page.getByRole("button", { name: "Copy token", exact: true }).click();
    assert.deepEqual(errors, []);
  },
);

it("groups Tailscale HTTPS and IP under one connection method", { timeout: 90_000 }, async (t) => {
  const cli = fakeServe(t);
  const server = await connectServer(t, cli.environment);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ locale: "en-US" });
  const https = "https://host.tailnet.ts.net/";
  await page.route("**/api/codexhost/accessTokenGet", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { result: { value: Record<string, unknown> } };
    body.result.value.tailscale = { status: "serving", url: https, funnel: false };
    body.result.value.networkUrls = [
      { kind: "tailscale-https", url: https },
      { kind: "tailscale", url: "http://100.89.178.38:4474/" },
      { kind: "tailscale", url: "http://100.89.178.39:4474/" },
    ];
    await route.fulfill({ response, json: body });
  });
  await page.goto(`${server.url}?token=${server.token}`);
  await openConnect(page);
  const address = page.getByLabel("Connection address", { exact: true });
  const ip = page.locator('[data-connect-route="tailscale"]');
  assert.equal(await page.getByText("Other connection methods", { exact: true }).count(), 0);
  assert.equal(await address.inputValue(), "host.tailnet.ts.net");

  await ip.getByRole("radio").check();
  assert.equal(await addressValue(address), "100.89.178.38:4474");
  assert.equal(await page.getByRole("combobox").count(), 0);
  await address.click();
  await page.getByRole("menuitem", { name: "100.89.178.39:4474" }).click();
  assert.equal(await addressValue(address), "100.89.178.39:4474");
  assert.equal(
    await page.locator('[data-connect-route="tailscale-https"]').getByRole("radio").isChecked(),
    true,
  );

  await page.locator('[data-connect-route="lan"]').getByRole("radio").check();
  assert.equal(await ip.count(), 0);
});
