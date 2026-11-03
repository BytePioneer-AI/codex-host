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
