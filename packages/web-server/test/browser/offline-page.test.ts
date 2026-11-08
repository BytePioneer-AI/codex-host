/** Navigation fallback and recovery with an authenticated, Service Worker-controlled browser. */
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { it, type TestContext } from "node:test";
import { chromium, type Page } from "playwright";
import { FakeChHost, startFakeChDebugger } from "../support/ch-host.ts";
import { startServer } from "../support/server.ts";

const TOKEN = "offline-page-local-test-token";
const TITLE = "Connecting…";
const webUi = resolve(import.meta.dirname, "../../../../apps/web-ui");

async function fixture(t: TestContext, locale = "en-US", args: string[] = []) {
  const data = mkdtempSync(join(tmpdir(), "codexhost-offline-page-"));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  const host = new FakeChHost();
  host.add("offline-thread", "/computer/project", "Offline notification");
  const debuggerServer = await startFakeChDebugger(host);
  t.after(() => debuggerServer.close());
  let child: ChildProcess;
  let port = "0";
  const start = async () => {
    const url = await startServer(
      t,
      resolve(import.meta.dirname, "../.."),
      ["--import", "tsx", "src/main.ts"],
      [
        "--data",
        data,
        "--token",
        TOKEN,
        "--port",
        port,
        "--ch-cdp",
        debuggerServer.endpoint,
        ...args,
      ],
      {
        authenticated: true,
        environment: { CODEXHOST_CONSOLE_PORT: "0" },
        onSpawn: (process) => {
          child = process;
        },
      },
    );
    port = new URL(url).port;
    return url;
  };
  const stop = async () => {
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    await exited;
  };
  const url = await start();
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const context = await browser.newContext({ locale });
  const page = await context.newPage();
  const errors: string[] = [];
  context.on("page", (opened) => opened.on("pageerror", (error) => errors.push(error.message)));
  page.on("pageerror", (error) => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  return { url, start, stop, context, page };
}

async function signIn(page: Page, url: string) {
  await page.goto(url);
  await page.getByRole("button", { name: "Settings", exact: true }).waitFor();
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  assert.equal(new URL(page.url()).search, "");
  assert.equal(await page.evaluate(async () => (await fetch("api/auth/status")).status), 200);
  assert.ok((await page.context().cookies()).some((cookie) => cookie.httpOnly));
}

it(
  "survives Web shutdown, new tabs and notification clicks, then automatically recovers",
  {
    timeout: 60_000,
  },
  async (t) => {
    const { url, start, stop, context, page } = await fixture(t);
    await signIn(page, url);
    const address = page.url();
    await stop();
    const response = await page.reload();
    assert.equal(response?.status(), 503);
    assert.equal(response.headers()["content-type"], "text/html; charset=utf-8");
    assert.equal(response.headers()["cache-control"], "no-store");
    await page.getByRole("heading", { name: TITLE }).waitFor();
    assert.equal(await page.locator("#address").textContent(), address);

    const tab = await context.newPage();
    await tab.goto(address);
    await tab.getByRole("heading", { name: TITLE }).waitFor();
    await tab.close();

    const worker = context.serviceWorkers()[0];
    assert.ok(worker);
    await worker.evaluate(async () => {
      const scope = globalThis as unknown as {
        clients: { matchAll(): Promise<Array<{ postMessage(message: unknown): void }>> };
      };
      for (const client of await scope.clients.matchAll())
        client.postMessage({ type: "codexhost/open-session", sessionId: "offline-thread" });
    });
    await page.waitForURL("**/?session=offline-thread");
    await page.getByRole("heading", { name: TITLE }).waitFor();
    await start();
    await page.getByText("existing CH answer", { exact: true }).waitFor({ timeout: 20_000 });
    assert.equal(new URL(page.url()).search, "");
  },
);

it(
  "replaces only gateway navigation responses and preserves redirects and authentication",
  {
    timeout: 60_000,
  },
  async (t) => {
    const { url, context, page } = await fixture(t);
    await signIn(page, url);
    const address = page.url();
    let status = 502;
    let workerRequests = 0;
    const routePattern = `${address}**`;
    await context.route(routePattern, (route) => {
      const request = route.request();
      const target = new URL(request.url());
      if (target.pathname !== "/") return route.continue();
      if (request.serviceWorker()) workerRequests++;
      if (target.search === "?redirected")
        return route.fulfill({ contentType: "text/html", body: "<h1>Redirect destination</h1>" });
      return route.fulfill({
        status,
        contentType: "text/html",
        headers: status === 302 ? { location: "/?redirected" } : {},
        body: `<h1>Original ${String(status)}</h1>`,
      });
    });
    await page.clock.install();
    for (status of [502, 503, 504]) {
      assert.equal((await page.goto(address))?.status(), 503);
      await page.getByRole("heading", { name: TITLE }).waitFor();
    }
    assert.equal(workerRequests, 3);
    // A healthy auth API must not cause reloads while the document still returns 503.
    status = 503;
    let navigations = 0;
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) navigations++;
    });
    assert.equal(await page.evaluate(async () => (await fetch("api/auth/status")).status), 200);
    for (let attempt = 0; attempt < 2; attempt++) {
      const probe = page.waitForResponse((response) => response.url() === address);
      await page.clock.runFor(10_000);
      assert.equal((await probe).status(), 503);
    }
    assert.equal(navigations, 0);
    assert.equal(workerRequests, 3, "recovery probes are not intercepted by the Worker");

    for (status of [401, 404]) {
      assert.equal((await page.goto(address))?.status(), status);
      await page.getByRole("heading", { name: `Original ${String(status)}` }).waitFor();
    }
    status = 302;
    await page.goto(address);
    await page.getByRole("heading", { name: "Redirect destination" }).waitFor();
    assert.equal(new URL(page.url()).search, "?redirected");
    await context.unroute(routePattern);
    await context.clearCookies();
    assert.equal((await page.goto(address))?.status(), 401);
    await page.getByPlaceholder("Access token").waitFor();
    // The server's own token exchange is a 302 that must still set its cookie.
    await signIn(page, url);
    await context.route(routePattern, (route) => {
      if (new URL(route.request().url()).pathname === "/")
        return route.fulfill({ status: 503, body: "Gateway unavailable" });
      return route.continue();
    });
    await page.reload();
    await page.getByRole("heading", { name: TITLE }).waitFor();
    await context.clearCookies();
    await context.unroute(routePattern);
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await page.getByPlaceholder("Access token").waitFor();
  },
);

it(
  "immediately retries transient navigation failures and accepts six-second recovery responses",
  { timeout: 40_000 },
  async (t) => {
    const { url, context, page } = await fixture(t);
    await signIn(page, url);
    const address = page.url();
    for (const latency of [0, 6_000]) {
      let first = true;
      let probes = 0;
      await context.route(address, async (route) => {
        if (first) {
          first = false;
          return route.fulfill({ status: 503, body: "Temporary gateway failure" });
        }
        if (!route.request().serviceWorker()) {
          probes++;
          await new Promise((resolve) => setTimeout(resolve, latency));
        }
        return route.continue();
      });
      const probe = page.waitForRequest(
        (request) => request.url() === address && !request.serviceWorker(),
        { timeout: 2_000 },
      );
      await page.reload();
      await probe;
      if (latency) {
        await page.getByRole("heading", { name: TITLE }).waitFor();
        assert.equal(await page.locator("#help").isVisible(), false);
      }
      await page.getByRole("button", { name: "Settings", exact: true }).waitFor();
      assert.equal(probes, 1);
      await context.unroute(address);
    }
  },
);

it(
  "uses ten-second deadlines for navigation and deduplicated recovery probes",
  {
    timeout: 45_000,
  },
  async (t) => {
    const { url, context, page } = await fixture(t);
    await signIn(page, url);
    const address = page.url();
    let hang = true;
    let probes = 0;
    let probeStarted = 0;
    await context.route(address, (route) => {
      if (!route.request().serviceWorker()) {
        probes++;
        probeStarted = Date.now();
      }
      if (hang) return;
      return route.continue();
    });
    const failed = page.waitForEvent("requestfailed", {
      predicate: (request) => request.url() === address && !request.serviceWorker(),
    });
    const started = Date.now();
    assert.equal((await page.reload())?.status(), 503);
    assert.ok(Date.now() - started >= 9_500);
    assert.ok(Date.now() - started < 15_000);
    await page.getByRole("heading", { name: TITLE }).waitFor();
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await page.evaluate(() => {
      window.dispatchEvent(new Event("online"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await failed;
    assert.equal(probes, 1, "clicks and resume events must reuse the active probe");
    assert.ok(Date.now() - probeStarted >= 9_500);
    assert.ok(Date.now() - probeStarted < 15_000);
    await page.getByRole("heading", { name: TITLE }).waitFor();
    hang = false;
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await page.getByRole("button", { name: "Settings", exact: true }).waitFor();
  },
);

it(
  "shows network state in Chinese, fits mobile themes and leaves non-navigation requests alone",
  {
    timeout: 40_000,
  },
  async (t) => {
    const { url, context, page } = await fixture(t, "zh-CN");
    // The app's Settings label is localized; authentication and Worker control are language-neutral.
    await page.goto(url);
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
    await page.setViewportSize({ width: 320, height: 640 });
    await page.clock.install();
    const address = `${page.url()}?address=${"long-address-".repeat(30)}`;
    await context.route(address, (route) => route.fulfill({ status: 503, body: "gateway" }));
    await page.goto(address);
    await context.setOffline(true);
    await page.getByRole("heading", { name: "正在连接…" }).waitFor();
    await page.getByText("等待网络恢复，将自动重连。", { exact: true }).waitFor();
    assert.equal(await page.title(), "正在连接…");
    assert.equal(await page.locator("#help").isVisible(), false);
    assert.equal(await page.locator("html").getAttribute("lang"), "zh");
    assert.equal(await page.locator("#address").textContent(), address);
    assert.equal(await page.locator("script[src], link, img").count(), 0);
    const backgrounds: string[] = [];
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
      const button = await page.getByRole("button", { name: "重试" }).boundingBox();
      assert.ok(button && button.x >= 0 && button.x + button.width <= 320 && button.height >= 44);
      backgrounds.push(
        await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor),
      );
    }
    assert.notEqual(backgrounds[0], backgrounds[1]);
    assert.equal(
      await page.evaluate(async () => {
        try {
          await fetch("api/auth/status");
          return "response";
        } catch {
          return "network error";
        }
      }),
      "network error",
    );
    await context.route("**/*", (route) => {
      if (new URL(route.request().url()).pathname === "/")
        return route.fulfill({ status: 503, body: "gateway" });
      return route.fulfill({
        status: 502,
        contentType: "application/json",
        body: '{"error":"gateway"}',
      });
    });
    const onlineProbe = page.waitForResponse(address);
    await context.setOffline(false);
    await onlineProbe;
    await page.getByRole("heading", { name: "正在连接…" }).waitFor();
    await page.getByText("正在自动重连，连接恢复后将继续打开。", { exact: true }).waitFor();
    await page.clock.runFor(30_000);
    await page
      .getByText("连接耗时较长，请检查网络并确认电脑上的 Web 正在运行。", { exact: true })
      .waitFor();
    const api = await page.evaluate(async () => {
      const response = await fetch("api/auth/status");
      return { status: response.status, body: await response.text() };
    });
    assert.deepEqual(api, { status: 502, body: '{"error":"gateway"}' });
    await context.unrouteAll();
    await page.getByRole("button", { name: "重试" }).click();
    await page.locator("#retry").waitFor({ state: "detached" });
  },
);

it(
  "replaces an installed notification-only Worker without changing app registration",
  {
    timeout: 40_000,
  },
  async (t) => {
    const copy = mkdtempSync(join(tmpdir(), "codexhost-offline-upgrade-"));
    t.after(() => rmSync(copy, { recursive: true, force: true }));
    cpSync(webUi, copy, {
      recursive: true,
      filter: (source) => !["node_modules", "src", "tests", ".git"].includes(basename(source)),
    });
    const { url, context, page, stop } = await fixture(t, "en-US", ["--dev-web-ui", copy]);
    const source = readFileSync(join(webUi, "apps/web/public/sw.js"), "utf8");
    // The notification-only version has the same install, activate, push and click handlers.
    const previous =
      source.slice(0, source.indexOf('self.addEventListener("fetch"')) +
      source.slice(source.indexOf('self.addEventListener("push"'));
    const built = join(copy, "apps/web/dist/sw.js");
    const current = readFileSync(built, "utf8");
    writeFileSync(built, previous);
    await signIn(page, url);
    assert.equal(
      await context.serviceWorkers()[0]?.evaluate(() => "navigate" in globalThis),
      false,
    );
    writeFileSync(built, current);
    await page.evaluate(async () => {
      const changed = new Promise<void>((resolve) => {
        navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), {
          once: true,
        });
      });
      const registration = await navigator.serviceWorker.getRegistration();
      await registration?.update();
      await changed;
    });
    await stop();
    assert.equal((await page.reload())?.status(), 503);
    await page.getByRole("heading", { name: TITLE }).waitFor();
  },
);
