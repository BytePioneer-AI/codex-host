/** Mobile connection feedback must not depend on an open sidebar or a page reload. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { chromium } from "playwright";
import { FakeChChannel, startFakeChChannel } from "../support/ch-channel.ts";
import { startFakeChDebugger } from "../support/ch-host.ts";
import { startServer } from "../support/server.ts";

it(
  "keeps history synchronization quiet while showing connection failures and retaining drafts",
  { timeout: 40_000 },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "ch-mobile-connection-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const host = new FakeChChannel();
    const row = host.add("mobile-thread", "/computer/mobile-project", "Mobile connection");
    row.status = { type: "active" };
    const turn = row.turns.at(-1);
    assert.ok(turn);
    turn.status = "inProgress";
    const debuggerServer = await startFakeChDebugger(host);
    t.after(() => debuggerServer.close());
    const channel = await startFakeChChannel(host, directory);
    t.after(() => channel.close());
    const url = await startServer(
      t,
      resolve(import.meta.dirname, "../.."),
      ["--import", "tsx", "src/main.ts"],
      [
        "--session-source",
        "codexhost",
        "--ch-cdp",
        debuggerServer.endpoint,
        "--ch-control-directory",
        directory,
      ],
    );
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let holdHistory = false;
    let failHistory = false;
    let endHistory: (() => void) | undefined;
    let historyHeld = Promise.withResolvers<void>();
    const pending: Array<() => void> = [];
    await page.routeWebSocket("**/api/remote.mux", (socket) => {
      const server = socket.connectToServer();
      const follows = new Set<string>();
      const rejected = new Set<string>();
      socket.onMessage((message) => {
        const frame = JSON.parse(String(message));
        if (frame.type === "open" && frame.endpoint === "session/follow") {
          follows.add(frame.streamId);
          endHistory = () => socket.send(JSON.stringify({ type: "end", streamId: frame.streamId }));
        }
        server.send(message);
      });
      server.onMessage((message) => {
        const frame = JSON.parse(String(message));
        if (rejected.has(frame.streamId)) return;
        if (failHistory && follows.has(frame.streamId)) {
          failHistory = false;
          rejected.add(frame.streamId);
          socket.send(
            JSON.stringify({
              type: "error",
              streamId: frame.streamId,
              error: { code: "gateway/internal", message: "Test history failure", details: {} },
            }),
          );
        } else if (holdHistory && follows.has(frame.streamId)) {
          pending.push(() => socket.send(message));
          historyHeld.resolve();
        } else socket.send(message);
      });
    });
    await page.goto(url);
    const folder = page.getByRole("treeitem").filter({ hasText: /^mobile-project$/u });
    await folder.waitFor();
    if ((await folder.getAttribute("aria-expanded")) === "false") await folder.click();
    await page
      .locator('[data-row-key^="session:"]')
      .filter({ hasText: "Mobile connection" })
      .click();
    await page.getByText("existing CH answer", { exact: true }).waitFor();
    await page.locator("[data-web-connection]").waitFor({ state: "hidden" });
    await page.setViewportSize({ width: 390, height: 844 });
    // A page-owned sentinel proves recovery does not replace the document.
    await page.evaluate(() => {
      (window as unknown as { connectionTest: string }).connectionTest = "same-page";
    });
    const composer = page.locator("[data-composer-input]");
    await composer.fill("Keep this mobile draft");
    // Native history replacement ends only the follow stream, not the connection.
    // Hold each new baseline so even a short-lived synchronization banner is detected.
    for (let attempt = 0; attempt < 2; attempt++) {
      historyHeld = Promise.withResolvers<void>();
      holdHistory = true;
      assert.ok(endHistory);
      endHistory();
      await historyHeld.promise;
      await page.waitForTimeout(100);
      assert.equal(await page.locator("[data-web-connection]").count(), 0);
      assert.equal(await page.getByText("existing CH answer", { exact: true }).count(), 1);
      assert.equal(await composer.innerText(), "Keep this mobile draft");
      holdHistory = false;
      pending.splice(0).forEach((send) => send());
    }
    await page.context().setOffline(true);
    const offline = page.locator('[data-web-connection="offline"]');
    await offline.waitFor({ timeout: 3000 });
    const bounds = await offline.boundingBox();
    assert.ok(
      bounds && bounds.x >= 0 && bounds.x + bounds.width <= 391 && bounds.y >= 0 && bounds.y < 200,
    );
    await page
      .getByText("Connection interrupted; task status unconfirmed", { exact: true })
      .last()
      .waitFor();
    assert.equal(await page.getByText("existing CH answer", { exact: true }).count(), 1);
    assert.equal(await composer.innerText(), "Keep this mobile draft");
    historyHeld = Promise.withResolvers<void>();
    holdHistory = true;
    await page.context().setOffline(false);
    await historyHeld.promise;
    await page.locator("[data-web-connection]").waitFor({ state: "hidden", timeout: 5000 });
    assert.ok(pending.length > 0);
    assert.equal(await composer.innerText(), "Keep this mobile draft");
    holdHistory = false;
    pending.splice(0).forEach((send) => send());
    await page.locator("[data-web-connection]").waitFor({ state: "hidden", timeout: 5000 });
    assert.equal(await composer.innerText(), "Keep this mobile draft");
    // Restoring a cached page revalidates the carrier. A terminal history failure
    // must remain visible and the retry action must actually reopen that history.
    failHistory = true;
    await page.evaluate(() =>
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })),
    );
    await page.locator('[data-web-connection="error"]').waitFor({ timeout: 5000 });
    assert.equal(await page.getByText("existing CH answer", { exact: true }).count(), 1);
    await page.locator('[data-web-connection="error"] button').click();
    await page.locator("[data-web-connection]").waitFor({ state: "hidden", timeout: 5000 });
    assert.equal(await composer.innerText(), "Keep this mobile draft");
    assert.equal(
      await page.evaluate(() => (window as unknown as { connectionTest: string }).connectionTest),
      "same-page",
    );
    assert.equal(
      host.requests.some(({ method }) => method === "turn/start" || method === "turn/interrupt"),
      false,
    );
    assert.deepEqual(errors, []);
  },
);

it(
  "keeps a healthy connection on tab return and replaces one that stops answering",
  { timeout: 40_000 },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "ch-tab-return-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const host = new FakeChChannel();
    const row = host.add("tab-thread", "/computer/tab-project", "Tab return");
    row.status = { type: "active" };
    const turn = row.turns.at(-1);
    assert.ok(turn);
    turn.status = "inProgress";
    const debuggerServer = await startFakeChDebugger(host);
    t.after(() => debuggerServer.close());
    const channel = await startFakeChChannel(host, directory);
    t.after(() => channel.close());
    const url = await startServer(
      t,
      resolve(import.meta.dirname, "../.."),
      ["--import", "tsx", "src/main.ts"],
      [
        "--session-source",
        "codexhost",
        "--ch-cdp",
        debuggerServer.endpoint,
        "--ch-control-directory",
        directory,
      ],
    );
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    // Records every status that appears, including one too short to be caught by polling.
    await page.addInitScript(`
      window.__visibility = "visible";
      window.__statuses = [];
      Object.defineProperty(document, "visibilityState", { get: () => window.__visibility });
      setInterval(() => {
        for (const node of document.querySelectorAll("[data-web-connection], [data-chat-running]")) {
          const text = node.textContent;
          if (!window.__statuses.includes(text)) window.__statuses.push(text);
        }
      }, 10);
    `);
    let sockets = 0;
    let pings = 0;
    let dropPongs = false;
    await page.routeWebSocket("**/api/remote.mux", (socket) => {
      sockets++;
      const server = socket.connectToServer();
      socket.onMessage((message) => {
        if (JSON.parse(String(message)).type === "ping") pings++;
        server.send(message);
      });
      server.onMessage((message) => {
        if (dropPongs && JSON.parse(String(message)).type === "pong") return;
        socket.send(message);
      });
    });
    const returnToTab = () =>
      page.evaluate(`
        window.__visibility = "hidden";
        document.dispatchEvent(new Event("visibilitychange"));
        window.__visibility = "visible";
        document.dispatchEvent(new Event("visibilitychange"));
      `);
    const statuses = () => page.evaluate<string[]>("window.__statuses");
    await page.goto(url);
    const folder = page.getByRole("treeitem").filter({ hasText: /^tab-project$/u });
    await folder.waitFor();
    if ((await folder.getAttribute("aria-expanded")) === "false") await folder.click();
    await page.locator('[data-row-key^="session:"]').filter({ hasText: "Tab return" }).click();
    await page.getByText("existing CH answer", { exact: true }).waitFor();
    await page.locator("[data-chat-running]").first().waitFor();
    await page.evaluate("window.__statuses = []");

    await returnToTab();
    await page.waitForTimeout(500);
    assert.equal(sockets, 1);
    assert.equal(pings, 1);
    assert.ok(
      (await statuses()).every((status) => status.startsWith("Working")),
      `unexpected status: ${JSON.stringify(await statuses())}`,
    );

    // No reply: the probe deadline withdraws the socket and the existing retry replaces it.
    await page.evaluate("window.__statuses = []");
    dropPongs = true;
    await returnToTab();
    const deadline = Date.now() + 8000;
    while (sockets < 2 && Date.now() < deadline) await page.waitForTimeout(50);
    dropPongs = false;
    assert.equal(sockets, 2);
    await page.locator("[data-web-connection]").waitFor({ state: "hidden", timeout: 5000 });
    assert.equal(await page.getByText("existing CH answer", { exact: true }).count(), 1);
    assert.equal(
      host.requests.some(({ method }) => method === "turn/start" || method === "turn/interrupt"),
      false,
    );
  },
);
