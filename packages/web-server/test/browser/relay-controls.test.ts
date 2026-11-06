import assert from "node:assert/strict";
import { resolve } from "node:path";
import { it, type TestContext } from "node:test";
import { chromium, type Page } from "playwright";
import type { WebAccessState, WebRelayState } from "@codexhost/shared-contracts";
import { certPath, delay, relayData, startRelay } from "../support/relay.ts";
import { readServiceOptions } from "../../src/background-service.ts";
import { defined } from "../support/defined.ts";
import { startServer } from "../support/server.ts";
import { acmeServer } from "../support/acme-server.ts";

async function fixture(t: TestContext) {
  const ca = await acmeServer(t, ({ reply }) => {
    reply(503, { detail: "test CA unavailable" });
    return true;
  });
  const relay = await startRelay(t);
  const data = relayData(t);
  const login = new URL(
    await startServer(
      t,
      resolve(import.meta.dirname, "../.."),
      ["--import", "tsx", "src/main.ts"],
      ["--data", data.root, "--relay", `localhost:${relay.port}`],
      {
        authenticated: true,
        environment: {
          NODE_EXTRA_CA_CERTS: certPath,
          HTTPS_PROXY: "",
          https_proxy: "",
          CODEXHOST_RELAY_ACME_DIRECTORY: ca.directory,
        },
      },
    ),
  );
  const access = async (): Promise<WebAccessState> => {
    const method = "codexhost/accessTokenGet";
    const result = await fetch(new URL(`/api/${method}`, login), {
      method: "POST",
      headers: { authorization: `Bearer ${login.searchParams.get("token")}` },
      body: JSON.stringify({ method, payload: { args: {} } }),
    });
    return (await result.json()).result.value;
  };
  assert.equal(readServiceOptions(data).relayHost, `localhost:${relay.port}`);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 375, height: 800 } });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  login.hash = "connect-devices";
  return { page, browser, login, access, data };
}

async function open(page: Page, login: URL) {
  await page.goto("about:blank");
  await page.goto(login.href);
  await page.locator("[data-connect-devices]").waitFor();
}

it(
  "toggles the real Relay without restarting and hides controls from a phone",
  { timeout: 60_000 },
  async (t) => {
    const f = await fixture(t);
    await open(f.page, f.login);
    const control = f.page.locator("[data-relay-status]");
    const toggle = control.getByRole("switch", { name: "Relay access" });
    assert.equal(await toggle.isChecked(), false);
    await toggle.click();
    for (let i = 0; (await f.access()).relay?.state.status !== "missing-certificate" && i < 50; i++)
      await delay(20);
    await control.getByRole("button", { name: "Refresh status" }).click();
    await f.page.locator('[data-relay-status="missing-certificate"]').waitFor();
    await control
      .getByText("Registered, but a certificate is missing.", { exact: false })
      .waitFor();
    assert.ok((await control.textContent())?.includes(f.data.path("remote-relay/identity.pem")));
    assert.equal(
      await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    const bounds = await control.boundingBox();
    assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 375);
    await toggle.click();
    await f.page.locator('[data-relay-status="off"]').waitFor();
    const state = await f.access();
    assert.equal(state.relay?.state.status, "off");
    const phone = await f.browser.newPage({
      locale: "en-US",
      viewport: { width: 375, height: 800 },
      extraHTTPHeaders: { "x-forwarded-for": "198.51.100.1" },
    });
    const url = new URL(f.login);
    url.search = "";
    url.hash = `token=${state.secret}`;
    await phone.goto(url.href);
    await phone.getByRole("button", { name: "Open sidebar" }).click();
    await phone.getByRole("button", { name: "Settings", exact: true }).click();
    await phone.getByText("Connect devices", { exact: true }).first().click();
    await phone.locator('[data-connect-notice="non-local"]').waitFor();
    assert.equal(await phone.getByRole("switch", { name: "Relay access" }).count(), 0);
  },
);

it(
  "renders certificate expiry, issuance, failure/retry and pause at phone width",
  { timeout: 60_000 },
  async (t) => {
    const f = await fixture(t);
    const base = await f.access();
    let shown = base;
    await f.page.route("**/api/codexhost/accessTokenGet", (route) =>
      route.fulfill({ json: { result: { ok: true, value: shown } } }),
    );
    const expiresAt = "2027-01-01T00:00:00Z";
    const retryAt = "2026-12-01T12:00:00Z";
    const detail = `CA refused ${"long-hostname.".repeat(15)}relay.test`;
    for (const status of ["connected", "missing-certificate"] as const) {
      for (const phase of ["idle", "issuing", "failed", "paused"] as const) {
        if (status === "missing-certificate" && phase === "idle") continue;
        shown = {
          ...base,
          relay: {
            identityPath: defined(base.relay).identityPath,
            state: {
              status,
              url: "https://computer.relay.test/",
              certificate: {
                ...(status === "connected" ? { expiresAt } : {}),
                issuing: phase === "issuing",
                ...(phase === "failed" || phase === "paused"
                  ? { failure: { detail, retryAt, paused: phase === "paused" } }
                  : {}),
              },
            },
          },
        };
        await open(f.page, f.login);
        const control = f.page.locator("[data-relay-status]");
        const text = await control.textContent();
        if (status === "connected") {
          assert.ok(text?.includes("Certificate valid until"));
          assert.ok(
            text?.includes(
              await f.page.evaluate((date) => new Date(date).toLocaleString(), expiresAt),
            ),
          );
        }
        if (phase === "issuing")
          assert.ok(
            text?.includes(
              status === "connected"
                ? "Requesting a certificate…"
                : "Registered. Requesting a certificate, which usually takes under a minute.",
            ),
          );
        if (phase === "failed" || phase === "paused") assert.ok(text?.includes(detail));
        if (phase === "failed") {
          assert.ok(text?.includes("Next attempt:"));
          assert.ok(
            text?.includes(
              await f.page.evaluate((date) => new Date(date).toLocaleString(), retryAt),
            ),
          );
        }
        if (phase === "paused") {
          assert.ok(text?.includes("Fix the issue, then turn relay access off and on."));
          assert.ok(!text?.includes("Next attempt:"));
        }
        assert.equal(
          await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
        );
        const bounds = await control.boundingBox();
        assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 375);
      }
    }
  },
);

it(
  "renders every relay state and chooses public, relay, HTTPS, Tailscale then LAN",
  { timeout: 60_000 },
  async (t) => {
    const f = await fixture(t);
    const base = await f.access();
    const identityPath = defined(base.relay).identityPath;
    let shown: WebAccessState = base;
    await f.page.route("**/api/codexhost/accessTokenGet", (route) =>
      route.fulfill({ json: { result: { ok: true, value: shown } } }),
    );
    const states: Array<[WebRelayState, string]> = [
      [{ status: "off" }, "Off"],
      [{ status: "connecting" }, "Connecting…"],
      [
        {
          status: "connected",
          url: "https://computer.relay.test/",
          certificate: { issuing: false, expiresAt: "2027-01-01T00:00:00Z" },
        },
        "Connected",
      ],
      [
        {
          status: "missing-certificate",
          url: "https://computer.relay.test/",
          certificate: { issuing: false },
        },
        "certificate is missing",
      ],
      [{ status: "stopped", reason: "replaced" }, "another computer is using this identity"],
      [{ status: "stopped", reason: "rejected" }, "rejected this identity's signature"],
      [{ status: "stopped", reason: "unsupported-version" }, "Update codexhost"],
    ];
    for (const [state, text] of states) {
      shown = { ...base, relay: { identityPath, state } };
      await open(f.page, f.login);
      assert.ok((await f.page.locator("[data-relay-status]").textContent())?.includes(text));
      assert.equal(
        await f.page.getByRole("switch", { name: "Relay access" }).isChecked(),
        state.status !== "off",
      );
    }
    const urls: WebAccessState["networkUrls"] = [
      { kind: "public", url: "https://public.test/" },
      { kind: "relay", url: "https://computer.relay.test/" },
      { kind: "tailscale-funnel", url: "https://funnel.test/" },
      { kind: "tailscale-https", url: "https://serve.test/" },
      { kind: "tailscale", url: "http://100.64.0.1:4490/" },
      { kind: "lan", url: "http://192.168.1.1:4490/" },
    ];
    for (let i = 0; i < urls.length; i++) {
      shown = {
        ...base,
        networkUrls: urls.slice(i).reverse(),
        relay: {
          identityPath,
          state: {
            status: "connected",
            url: defined(urls[1]).url,
            certificate: { issuing: false, expiresAt: "2027-01-01T00:00:00Z" },
          },
        },
      };
      await open(f.page, f.login);
      assert.equal(
        await f.page.getByRole("textbox", { name: "Connection address" }).inputValue(),
        new URL(defined(urls[i]).url).host,
      );
    }
    shown = { ...base, relay: undefined };
    await open(f.page, f.login);
    assert.equal(await f.page.getByRole("switch", { name: "Relay access" }).count(), 0);
  },
);

it(
  "follows registration and first issuance until the state settles",
  { timeout: 60_000 },
  async (t) => {
    const f = await fixture(t);
    const base = await f.access();
    const identityPath = defined(base.relay).identityPath;
    const url = "https://computer.relay.test/";
    const states: WebRelayState[] = [
      { status: "connecting" },
      { status: "missing-certificate", url, certificate: { issuing: true } },
      {
        status: "connected",
        url,
        certificate: { issuing: false, expiresAt: "2027-01-01T00:00:00Z" },
      },
    ];
    let reads = 0;
    await f.page.route("**/api/codexhost/accessTokenGet", (route) => {
      const state = defined(states[Math.min(reads++, states.length - 1)]);
      return route.fulfill({
        json: { result: { ok: true, value: { ...base, relay: { identityPath, state } } } },
      });
    });
    await open(f.page, f.login);
    const control = f.page.locator("[data-relay-status]");
    await f.page.locator('[data-relay-status="missing-certificate"]').waitFor();
    assert.ok(
      (await control.textContent())?.includes(
        "Registered. Requesting a certificate, which usually takes under a minute.",
      ),
    );
    assert.ok(!(await control.textContent())?.includes("certificate is missing"));
    await f.page.locator('[data-relay-status="connected"]').waitFor();
    const settled = reads;
    await f.page.waitForTimeout(5_000);
    assert.equal(reads, settled);
  },
);
