/** Browser regression for the public Cordis navigation face; uses only synthetic Host history. */
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { it } from "node:test";
import { chromium } from "playwright";
import { FakeChHost, startFakeChDebugger } from "../support/ch-host.ts";
import { startServer } from "../support/server.ts";

it(
  "cold direct entry resolves through the traced navigation service and restores recent history",
  { timeout: 30_000 },
  async (t) => {
    assert.equal(process.env.CODEXHOST_TEST_WEB_BUNDLE, undefined);
    assert.equal(process.env.CODEXHOST_TEST_WEB_EXTENSION_DIRECTORY, undefined);
    const host = new FakeChHost();
    const id = "core-cold-direct";
    const answer = "Synthetic core navigation answer";
    const row = host.add(id, "/synthetic/core-navigation", id);
    const message = row.turns[0]?.items.find((item) => item.type === "agentMessage");
    assert.ok(message);
    message.text = answer;
    const debug = await startFakeChDebugger(host);
    t.after(() => debug.close());
    const url = await startServer(
      t,
      resolve(import.meta.dirname, "../.."),
      ["--import", "tsx", "src/main.ts"],
      ["--session-source", "codexhost", "--ch-cdp", debug.endpoint],
      {
        authenticated: true,
        onSpawn(child) {
          t.diagnostic(`owned gateway pid=${child.pid}`);
          child.once("exit", () => t.diagnostic("owned gateway exit confirmed"));
        },
      },
    );
    const browser = await chromium.launch({
      ...(process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH
        ? { executablePath: process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH }
        : {}),
    });
    t.after(async () => {
      await browser.close();
      assert.equal(browser.isConnected(), false);
      t.diagnostic("owned browser close confirmed");
    });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: "en-US" });
    const errors: string[] = [];
    const api: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      const endpoint = new URL(request.url()).pathname;
      if (!endpoint.startsWith("/api/")) return;
      if (endpoint.endsWith("/session/list")) {
        const args = request.postDataJSON()?.payload?.args;
        const business = args?.request ?? args?._request ?? args;
        api.push(`${endpoint}:${business?.sessionId ?? "head"}`);
      } else api.push(endpoint);
    });
    const target = new URL(url);
    target.searchParams.set("session", id);
    try {
      await page.goto(target.href);
      await page.locator("[data-shell-bottom]").locator("..").waitFor({ timeout: 5_000 });
      await page.getByText(answer, { exact: true }).waitFor({ timeout: 5_000 });
      assert.ok(api.includes(`/api/session/list:${id}`), "the exact-ID lookup actually ran");
      assert.equal(await page.locator("[data-session-opening]").count(), 0);
      await page.locator("[data-composer-input]").fill("synthetic unsent draft");
      assert.equal(
        await page.locator("[data-composer-input]").innerText(),
        "synthetic unsent draft",
      );
      // A genuine reload uses persisted selection and the same traced service lifecycle.
      await page.reload();
      await page.getByText(answer, { exact: true }).waitFor({ timeout: 5_000 });
      assert.equal(await page.locator("[data-session-opening]").count(), 0);
    } finally {
      t.diagnostic(
        JSON.stringify({
          api,
          opening: await page.locator("[data-session-opening]").allTextContents(),
          selected: await page.evaluate(() => localStorage.getItem("dsh.sessions.current")),
          historyVisible: await page.getByText(answer, { exact: true }).isVisible(),
          errors,
        }),
      );
      assert.equal(
        host.requests.some(({ method }) => method === "turn/start"),
        false,
      );
      assert.deepEqual(errors, []);
    }
  },
);
