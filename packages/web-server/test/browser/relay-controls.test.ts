import assert from "node:assert/strict";
import { resolve } from "node:path";
import { it, type TestContext } from "node:test";
import { chromium, type Page } from "playwright";
import type { WebAccessState, WebRelayState } from "@codexhost/shared-contracts";
import type { RelayOptions, RegistrationRequest } from "@codexhost/remote-relay";
import { certPath, delay, relayData, startRelay } from "../support/relay.ts";
import { readServiceOptions } from "../../src/background-service.ts";
import { defined } from "../support/defined.ts";
import { startServer } from "../support/server.ts";
import { acmeServer } from "../support/acme-server.ts";

async function fixture(t: TestContext, options: Partial<RelayOptions> = {}, locale = "en-US") {
  const ca = await acmeServer(t, ({ reply }) => {
    reply(503, { detail: "test CA unavailable" });
    return true;
  });
  const relay = await startRelay(t, 25, options);
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
  const page = await browser.newPage({ locale, viewport: { width: 375, height: 800 } });
  if (locale === "zh-CN") {
    const method = "settings/mutate";
    const response = await page.request.post(new URL(`/api/${method}`, login).href, {
      headers: { authorization: `Bearer ${login.searchParams.get("token")}`, origin: login.origin },
      data: {
        method,
        payload: {
          args: { ns: "locale", ops: [{ op: "set", path: ["preference"], value: "zh" }] },
        },
      },
    });
    assert.equal((await response.json()).result.ok, true);
  }
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

/** The relay is one of the connection methods; choosing it only shows its state. */
async function chooseRelay(page: Page) {
  await page.locator('[data-connect-route="self-hosted-relay"] input').check();
  return page.locator("[data-relay-status]");
}

it(
  "enables the real Relay from its connection method and hides it from a phone",
  { timeout: 60_000 },
  async (t) => {
    const requests: RegistrationRequest[] = [];
    const f = await fixture(t, {
      check: (request) => {
        requests.push(request);
        return { name: "alice" };
      },
    });
    await open(f.page, f.login);
    assert.equal(await f.page.locator("[data-relay-status]").count(), 0);
    const control = await chooseRelay(f.page);
    await f.page.locator('[data-relay-status="off"]').waitFor();
    const intro = (await control.textContent()) ?? "";
    assert.ok(intro.includes("Use your own relay"));
    assert.ok(!intro.includes("The official codexhost relay"));
    const name = control.getByRole("textbox", { name: "Address name (optional)" });
    const invite = control.getByRole("textbox", { name: "Invitation code" });
    assert.equal(await name.count(), 0);
    assert.equal(await invite.count(), 0);
    const enable = control.getByRole("button", { name: "Enable relay" });
    assert.equal(await enable.isEnabled(), true);
    assert.equal(readServiceOptions(f.data).relayEnabled, false);
    await enable.click();
    for (let i = 0; (await f.access()).relay?.state.status !== "missing-certificate" && i < 50; i++)
      await delay(20);
    await control.getByRole("button", { name: "Refresh status" }).click();
    await f.page.locator('[data-relay-status="missing-certificate"]').waitFor();
    await control.getByText(/Preparing…|Temporarily unavailable/u).waitFor();
    assert.equal(requests[0]?.name, undefined);
    assert.equal(requests[0]?.invite, undefined);
    const saved = readServiceOptions(f.data);
    assert.equal(saved.relayRegistrations[defined(saved.relayHost)]?.hostname, "alice.relay.test");
    assert.equal(await name.count(), 0);
    assert.equal(await invite.count(), 0);
    assert.equal(
      await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    const bounds = await control.boundingBox();
    assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 375);
    await control.getByRole("button", { name: "Turn off relay" }).click();
    await f.page.locator('[data-relay-status="off"]').waitFor();
    const state = await f.access();
    assert.equal(state.relay?.state.status, "off");
    assert.equal(state.relay?.customHostname, "alice.relay.test");
    assert.equal(await name.count(), 0);
    await open(f.page, f.login);
    await chooseRelay(f.page);
    assert.equal(await name.count(), 0);
    assert.equal(await invite.count(), 0);
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
    await phone
      .getByRole("dialog")
      .getByRole("button", { name: "Remote access", exact: true })
      .click();
    await phone.locator('[data-connect-notice="non-local"]').waitFor();
    assert.equal(await phone.locator('[data-connect-route="relay"]').count(), 0);
  },
);

it(
  "keeps certificates out of sight except for pauses, at phone width",
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
            ...defined(base.relay),
            enabled: true,
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
        const control = await chooseRelay(f.page);
        const text = (await control.textContent()) ?? "";
        const retry = await f.page.evaluate((date) => new Date(date).toLocaleString(), retryAt);
        // Certificates stay out of sight unless a pause needs the user.
        for (const hidden of ["Certificate valid until", "certificate", "Requesting"])
          assert.ok(!text.includes(hidden), `${status}/${phase} shows ${hidden}`);
        const expected =
          phase === "paused"
            ? "Needs attention. Fix the issue below, then turn the relay off and enable it again."
            : status === "connected"
              ? "Connect across networks without an extra phone app."
              : phase === "failed"
                ? `Temporarily unavailable. Retrying automatically at ${retry}.`
                : "Preparing… This usually takes under a minute.";
        assert.ok(text.includes(expected), `${status}/${phase}: ${text}`);
        assert.equal(text.includes(detail), phase === "paused");
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
    let shown: WebAccessState = base;
    await f.page.route("**/api/codexhost/accessTokenGet", (route) =>
      route.fulfill({ json: { result: { ok: true, value: shown } } }),
    );
    const states: Array<[WebRelayState, string]> = [
      [{ status: "off" }, "Use your own relay"],
      [{ status: "connecting" }, "Preparing…"],
      [
        {
          status: "connected",
          url: "https://computer.relay.test/",
          certificate: { issuing: false, expiresAt: "2027-01-01T00:00:00Z" },
        },
        "Connect across networks",
      ],
      [
        {
          status: "missing-certificate",
          url: "https://computer.relay.test/",
          certificate: { issuing: false },
        },
        "Preparing…",
      ],
      [{ status: "stopped", reason: "replaced" }, "another computer is using this identity"],
      [{ status: "stopped", reason: "rejected" }, "the relay rejected this computer"],
      [{ status: "stopped", reason: "unsupported-version" }, "Update codexhost"],
    ];
    for (const [state, text] of states) {
      shown = {
        ...base,
        relay: { ...defined(base.relay), enabled: state.status !== "off", state },
      };
      await open(f.page, f.login);
      const control = await chooseRelay(f.page);
      assert.ok((await control.textContent())?.includes(text));
      const action = state.status === "off" ? "Enable relay" : "Turn off relay";
      assert.equal(await control.getByRole("button", { name: action }).count(), 1);
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
        // The server lists the relay address exactly while the relay is connected.
        relay: {
          ...defined(base.relay),
          enabled: i <= 1,
          state:
            i <= 1
              ? {
                  status: "connected",
                  url: defined(urls[1]).url,
                  certificate: { issuing: false, expiresAt: "2027-01-01T00:00:00Z" },
                }
              : { status: "off" },
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
    assert.equal(await f.page.locator('[data-connect-route="relay"]').count(), 0);
  },
);

for (const locale of ["en-US", "zh-CN"]) {
  it(
    `shows real registration refusals and quota notices in ${locale} at phone width`,
    { timeout: 60_000 },
    async (t) => {
      let outcome: "invite" | "name-taken" | "banned" | "full" | "quota" = "invite";
      const f = await fixture(
        t,
        {
          check: () =>
            outcome === "quota"
              ? { name: "alice", dailyQuota: 100, usedToday: 100 }
              : { reject: outcome },
        },
        locale,
      );
      await open(f.page, f.login);
      const control = await chooseRelay(f.page);
      const chinese = locale === "zh-CN";
      const enable = () =>
        control.getByRole("button", { name: chinese ? "启用中转" : "Enable relay" });
      const name = control.getByRole("textbox", {
        name: chinese ? "地址名（可选）" : "Address name (optional)",
      });
      assert.equal(await name.count(), 0);
      const cases = [
        [
          "invite",
          chinese ? "邀请码无效或已被使用" : "Invitation code is invalid or has already been used",
        ],
        [
          "name-taken",
          chinese
            ? "这个名字已被占用，请换一个"
            : "This name is already taken. Choose another one.",
        ],
        [
          "banned",
          chinese ? "此电脑已被停止使用该中转" : "This computer has been disabled on this relay",
        ],
        ["full", chinese ? "中转已满，正在自动重试" : "The relay is full. Retrying automatically."],
      ] as const;
      for (const [reason, message] of cases) {
        outcome = reason;
        await enable().click();
        await control.getByText(message, { exact: true }).waitFor();
        assert.equal(readServiceOptions(f.data).relayEnabled, reason === "full");
        if (reason !== "full") {
          assert.equal(await enable().count(), 1);
        }
        assert.equal(
          await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
        );
      }
      await control.getByRole("button", { name: chinese ? "关闭中转" : "Turn off relay" }).click();
      outcome = "quota";
      await enable().click();
      await control
        .getByText(chinese ? "今日流量已用完" : "Today's traffic allowance is used up", {
          exact: true,
        })
        .waitFor();
      const state = await f.access();
      const until = defined(defined(state.relay).quotaUntil);
      const date = await f.page.evaluate((value) => new Date(value).toLocaleString(), until);
      assert.ok(
        (await control.textContent())?.includes(
          chinese ? `将于 ${date} 恢复` : `Available again at ${date}`,
        ),
      );
      assert.equal(await name.count(), 0);
      assert.equal(readServiceOptions(f.data).relayEnabled, true);
      assert.equal(
        await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
    },
  );
}

it(
  "reads settled relay quota notices on page open and manual refresh without polling",
  { timeout: 60_000 },
  async (t) => {
    const f = await fixture(t);
    const base = await f.access();
    let quotaUntil: string | undefined;
    let reads = 0;
    await f.page.clock.install();
    await f.page.route("**/api/codexhost/accessTokenGet", (route) => {
      reads++;
      return route.fulfill({
        json: {
          result: {
            ok: true,
            value: {
              ...base,
              relay: {
                ...base.relay,
                customHostname: "alice.relay.test",
                ...(quotaUntil ? { quotaUntil } : {}),
                state: {
                  status: "connected",
                  url: "https://alice.relay.test/",
                  certificate: { issuing: false },
                },
              },
            },
          },
        },
      });
    });
    await open(f.page, f.login);
    const control = await chooseRelay(f.page);
    quotaUntil = await f.page.evaluate(() => new Date(Date.now() + 60_000).toISOString());
    const settled = reads;
    await f.page.clock.fastForward(30_000);
    assert.equal(reads, settled);
    assert.equal(await control.getByText("Today's traffic allowance is used up").count(), 0);
    await open(f.page, f.login);
    await chooseRelay(f.page);
    await control.getByText("Today's traffic allowance is used up", { exact: true }).waitFor();
    const before = reads;
    quotaUntil = undefined;
    await f.page.clock.fastForward(40_000);
    assert.equal(reads, before);
    await control.getByRole("button", { name: "Refresh status" }).click();
    await control
      .getByText("Connect across networks without an extra phone app.", { exact: false })
      .waitFor();
    assert.equal(reads, before + 1);
    assert.equal(await control.getByText("Today's traffic allowance is used up").count(), 0);
  },
);

it(
  "follows registration and first issuance until the state settles",
  { timeout: 60_000 },
  async (t) => {
    const f = await fixture(t);
    const base = await f.access();
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
        json: {
          result: {
            ok: true,
            value: {
              ...base,
              relay: { ...defined(base.relay), enabled: true, state },
            },
          },
        },
      });
    });
    await open(f.page, f.login);
    const control = f.page.locator("[data-relay-status]");
    await f.page.locator('[data-relay-status="missing-certificate"]').waitFor();
    assert.ok(
      (await control.textContent())?.includes("Preparing… This usually takes under a minute."),
    );
    await f.page.locator('[data-relay-status="connected"]').waitFor();
    const settled = reads;
    await f.page.waitForTimeout(5_000);
    assert.equal(reads, settled);
  },
);
