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
        <style>body{margin:0;min-height:3000px;background:rgb(12,34,56)} input,button,a{position:absolute;left:20px;width:200px;height:40px}input{top:80px}button{top:140px}a{top:200px}</style>
        <script>addEventListener('scroll',()=>{if(document.title==='Browser fixture'||document.title.startsWith('scroll-'))document.title='scroll-'+scrollY})</script>
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
      hasTouch: true,
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
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => {
      const frame = document.querySelector("canvas[data-sidebar-browser-frame]");
      return frame !== null && frame.getBoundingClientRect().width < 390;
    });
    const keyboard = page.getByRole("textbox", { name: "Web page input" });
    await keyboard.evaluate((element) => {
      element.addEventListener("focus", () => element.setAttribute("data-was-focused", "true"));
    });
    // A mouse-like event on a narrow/touch viewer must not request the software keyboard.
    await remote(10, 20);
    assert.equal(await keyboard.getAttribute("data-was-focused"), null);
    assert.equal(await canvas.evaluate((element) => document.activeElement === element), true);
    // Canvas focus retains navigation keys even though the IME textarea is not focused.
    await page.keyboard.press("ArrowDown");
    await page.getByRole("tab", { name: /scroll-[1-9]/u }).waitFor();
    await page.keyboard.press("ArrowUp");
    await page.getByRole("tab", { name: /scroll-0/u }).waitFor();
    const box = await canvas.boundingBox();
    assert.ok(box);
    const cdp = await page.context().newCDPSession(page);
    const swipe = async (fromY: number, toY: number) => {
      const at = (y: number) => [{ x: box.x + 40, y: box.y + y }];
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: at(fromY) });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: at(toY) });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    };
    // A drag beginning over an editable field still scrolls without ever focusing the IME.
    await swipe(100, 40);
    await page.getByRole("tab", { name: /scroll-60/u }).waitFor();
    assert.equal(await keyboard.getAttribute("data-was-focused"), null);
    await swipe(40, 100);
    await page.getByRole("tab", { name: /scroll-0/u }).waitFor();
    assert.equal(await keyboard.getAttribute("data-was-focused"), null);
    // A tap on ordinary content does not request input either.
    await canvas.tap({ position: { x: 10, y: 20 } });
    // Exercise compatibility mouse events explicitly: preventDefault alone is not the guard.
    for (const type of ["mousedown", "mouseup"])
      await canvas.dispatchEvent(type, {
        clientX: box.x + 10,
        clientY: box.y + 20,
        button: 0,
        detail: 1,
      });
    assert.equal(await keyboard.getAttribute("data-was-focused"), null);
    await canvas.tap({ position: { x: 40, y: 100 } });
    assert.equal(await keyboard.evaluate((element) => document.activeElement === element), true);
    await page.keyboard.type("touch-");
    await canvas.tap({ position: { x: 40, y: 160 } });
    await page.getByRole("tab", { name: /touch-/u }).waitFor();
    assert.equal(await keyboard.evaluate((element) => document.activeElement === element), false);
    await cdp.detach();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.waitForFunction(() => {
      const frame = document.querySelector("canvas[data-sidebar-browser-frame]");
      return frame !== null && frame.getBoundingClientRect().width > 390;
    });
    // Desktop text, including a committed IME result, still reaches the remote field.
    await remote(40, 100);
    await page.keyboard.press("ControlOrMeta+A");
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
    // The address arrives before the next streamed image; wait until the text field is painted.
    await page.waitForFunction(() => {
      const frame = document.querySelector<HTMLCanvasElement>("canvas[data-sidebar-browser-frame]");
      const pixel = frame?.getContext("2d")?.getImageData(360, 200, 1, 1).data;
      return pixel !== undefined && (pixel[0] ?? 0) > 200;
    });
    // Re-establish a custom title after history navigation, which may reload rather than use BFCache.
    await remote(40, 100);
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.type("remote-中");
    await remote(40, 160);
    await page.getByRole("tab", { name: /remote-中/u }).waitFor();
    // A window the page opens becomes another sidebar tab on the same address.
    await remote(40, 280);
    await page
      .getByRole("tab", { name: /127\.0\.0\.1|Browser fixture|Next/u })
      .first()
      .waitFor();
    // The tab lives on the server: reloading the viewer reattaches to the same page.
    await page.reload();
    await page.locator('canvas[data-sidebar-browser-frame="remote"]').first().waitFor();
    await page.getByRole("tab", { name: /remote-中/u }).waitFor({ timeout: 15_000 });
    assert.deepEqual(errors, []);
  },
);
