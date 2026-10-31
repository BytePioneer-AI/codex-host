import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";

import { chromium } from "playwright";

import { FakeChHost, startFakeChDebugger } from "../support/ch-host.ts";
import { startServer } from "../support/server.ts";

it(
  "opens a page on the Web server's loopback through its forwarding listener",
  { timeout: 60_000 },
  async (t) => {
    const workspace = mkdtempSync(join(tmpdir(), "codexhost-browser-tab-"));
    t.after(() => rmSync(workspace, { recursive: true, force: true }));
    // A frame-denying local service: forwarding must still show it inside the sidebar.
    const site = createServer((_request, response) => {
      response.writeHead(200, {
        "content-type": "text/html",
        "x-frame-options": "DENY",
        "content-security-policy": "frame-ancestors 'none'",
      });
      response.end("<!doctype html><title>Browser fixture</title><h1>Browser body</h1>");
    });
    await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
    t.after(() => site.close());
    const address = site.address() as { port: number };
    const website = `http://127.0.0.1:${String(address.port)}/`;

    const host = new FakeChHost();
    host.add("local-thread", workspace, "Local Thread");
    const debug = await startFakeChDebugger(host);
    t.after(() => debug.close());
    const url = await startServer(
      t,
      resolve(import.meta.dirname, "../.."),
      ["--import", "tsx", "src/main.ts"],
      [
        "--session-source",
        "codexhost",
        "--ch-cdp",
        debug.endpoint,
        "--adapters",
        "test/fake-harness",
      ],
      { authenticated: true },
    );
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const target = new URL(url);
    target.searchParams.set("session", "local-thread");
    await page.goto(target.href);
    await page.getByText("earlier question", { exact: true }).waitFor();
    await page.locator("[data-sidebar-right-expand]").click();
    const guideEntry = page.locator('[data-sidebar-right-guide-entry="browser"]');
    if ((await guideEntry.count()) === 0)
      await page.getByRole("button", { name: "New tab" }).click();
    await page.locator('[data-sidebar-right-guide-entry="browser"]').click();
    const input = page.getByPlaceholder("Enter an HTTP(S) address");
    await input.waitFor();
    await input.fill(website);
    await input.press("Enter");
    const frame = page.locator("[data-sidebar-right-panel] iframe").first();
    await frame.waitFor();
    const forwarded = await page.waitForFunction(
      (port) => {
        const element = document.querySelector("[data-sidebar-right-panel] iframe");
        if (!(element instanceof HTMLIFrameElement) || element.src === "") return undefined;
        const src = new URL(element.src);
        return src.hostname === "127.0.0.1" && src.port !== port && src.port !== location.port
          ? src.href
          : undefined;
      },
      String(address.port),
      { timeout: 15_000 },
    );
    const forwardedUrl = (await forwarded.jsonValue()) as string;
    await page
      .frameLocator("[data-sidebar-right-panel] iframe")
      .getByRole("heading", { name: "Browser body" })
      .waitFor({ timeout: 15_000 });
    assert.equal(await input.inputValue(), website);
    // Opening outside the sidebar uses the forwarded address, not the viewer's own loopback.
    const [opened] = await Promise.all([
      page.context().waitForEvent("page"),
      page.getByRole("button", { name: "Open in system browser" }).click(),
    ]);
    await opened.waitForURL(forwardedUrl);
    await opened.getByRole("heading", { name: "Browser body" }).waitFor();
    assert.deepEqual(errors, []);
  },
);
