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
  "streams a tab of the CodexHost machine's browser into the right Sidebar",
  { timeout: 60_000 },
  async (t) => {
    const workspace = mkdtempSync(join(tmpdir(), "codexhost-browser-tab-"));
    t.after(() => rmSync(workspace, { recursive: true, force: true }));
    // Loopback-only and frame-denying: only the machine's own browser can show it.
    const site = createServer((request, response) => {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "x-frame-options": "DENY",
      });
      response.end(`<!doctype html><title>Browser fixture</title>
        <style>body{margin:0;background:rgb(12,34,56)} input,button,a{position:absolute;left:20px;width:200px;height:40px}input{top:80px}button{top:140px}a{top:200px}</style>
        ${
          request.url === "/next"
            ? "<h1>Next page</h1>"
            : `<input id="text"><button onclick="document.title=document.querySelector('input').value">Update title</button><a href="/next">Next</a><a style="top:260px" href="/next" target="_blank">Popup</a>`
        }`);
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
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
      deviceScaleFactor: 2,
    });
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
    const canvas = page.locator('canvas[data-sidebar-browser-frame="remote"]').first();
    await canvas.waitFor();
    // The page background reaches the canvas, drawn at physical pixels (2x) and 1:1 in CSS.
    await page.waitForFunction(
      () => {
        const element = document.querySelector<HTMLCanvasElement>(
          'canvas[data-sidebar-browser-frame="remote"]',
        );
        const pixel = element?.getContext("2d")?.getImageData(4, 4, 1, 1).data;
        return (
          element !== null &&
          element !== undefined &&
          element.width === Math.round(element.getBoundingClientRect().width * 2) &&
          pixel !== undefined &&
          Math.abs((pixel[0] ?? 0) - 12) < 4 &&
          Math.abs((pixel[1] ?? 0) - 34) < 4 &&
          Math.abs((pixel[2] ?? 0) - 56) < 4
        );
      },
      undefined,
      { timeout: 30_000 },
    );
    assert.equal(await page.locator("[data-sidebar-right-panel] iframe").count(), 0);
    assert.equal(await input.inputValue(), website);
    const remote = async (x: number, y: number) => {
      const box = await canvas.boundingBox();
      assert.ok(box);
      await page.mouse.click(box.x + x, box.y + y);
    };
    const addressIs = async (expected: string) => {
      await page.waitForFunction(
        (value) =>
          document.querySelector<HTMLInputElement>('input[placeholder="Enter an HTTP(S) address"]')
            ?.value === value,
        expected,
      );
    };
    // Text, including a committed IME result, reaches the focused remote field.
    await remote(40, 100);
    await page.keyboard.type("remote-");
    await page.getByRole("textbox", { name: "Web page input" }).evaluate((element) => {
      const textarea = element as HTMLTextAreaElement;
      textarea.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      textarea.value = "中文";
      textarea.dispatchEvent(
        new CompositionEvent("compositionend", { bubbles: true, data: "中文" }),
      );
    });
    await page.keyboard.press("Backspace");
    await remote(40, 160);
    await page.getByRole("tab", { name: /remote-中/u }).waitFor();
    await remote(40, 220);
    await addressIs(`${website}next`);
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await addressIs(website);
    // A window the page opens becomes another sidebar tab on the same address.
    await remote(40, 280);
    await page
      .getByRole("tab", { name: /127\.0\.0\.1|Browser fixture|Next/u })
      .nth(1)
      .waitFor();
    // The tab lives on the server: reloading the viewer reattaches to the same page.
    await page.reload();
    await page.locator('canvas[data-sidebar-browser-frame="remote"]').first().waitFor();
    await page.getByRole("tab", { name: /remote-中/u }).waitFor({ timeout: 15_000 });
    assert.deepEqual(errors, []);
  },
);
