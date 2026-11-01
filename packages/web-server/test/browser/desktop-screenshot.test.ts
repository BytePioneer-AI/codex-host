import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { chromium, type Route } from "playwright";
import { FakeChHost, startFakeChDebugger } from "../support/ch-host.ts";
import { startServer } from "../support/server.ts";

it(
  "shows only explicitly requested desktop images, replaces them, and discards closed or switched captures",
  { timeout: 45_000 },
  async (t) => {
    const workspace = mkdtempSync(join(tmpdir(), "codexhost-screenshot-ui-"));
    t.after(() => rmSync(workspace, { recursive: true, force: true }));
    const host = new FakeChHost();
    host.add("first", workspace, "First conversation", false);
    host.add("second", workspace, "Second conversation", false);
    const debug = await startFakeChDebugger(host);
    t.after(() => debug.close());
    const url = await startServer(
      t,
      resolve(import.meta.dirname, "../.."),
      ["--import", "tsx", "src/main.ts"],
      ["--ch-cdp", debug.endpoint],
    );
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const fixture = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 1280;
      canvas.height = 720;
      const context = canvas.getContext("2d");
      if (context === null) throw new Error("Canvas fixture unavailable");
      context.fillStyle = "#e4ecf0";
      context.fillRect(0, 0, 1280, 720);
      context.fillStyle = "#24434e";
      context.font = "32px sans-serif";
      context.fillText("Test image — not a real desktop capture", 80, 100);
      return canvas.toDataURL("image/png").slice("data:image/png;base64,".length);
    });
    const image = Buffer.from(fixture, "base64");
    let requests = 0;
    let failure = false;
    let hold = false;
    let receiveHeld: ((route: Route) => void) | undefined;
    const nextHeld = () =>
      new Promise<Route>((resolve) => {
        receiveHeld = resolve;
      });
    const fulfill = (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: "image/png",
        headers: {
          "x-codexhost-captured-at": "2026-11-01T12:34:56.000Z",
          "cache-control": "no-store",
        },
        body: image,
      });
    await page.route("**/api/desktop/screenshot", async (route) => {
      requests++;
      assert.equal(route.request().method(), "POST");
      if (hold) {
        receiveHeld?.(route);
        receiveHeld = undefined;
        return;
      }
      if (failure) {
        await route.fulfill({
          status: 403,
          contentType: "application/json",
          body: JSON.stringify({ error: "permission-denied" }),
        });
      } else await fulfill(route);
    });
    const target = new URL(url);
    target.searchParams.set("session", "first");
    await page.goto(target.href);
    await page.getByText("earlier question", { exact: true }).waitFor();
    const entry = page.getByRole("button", { name: "Desktop screenshot", exact: true });
    await entry.waitFor();
    const composer = page.locator("[data-composer-input]");
    await composer.fill("Keep my draft");
    assert.equal(requests, 0);

    await entry.click();
    const preview = page.getByRole("region", { name: "Desktop screenshot", exact: true });
    const thumbnail = preview.locator("img");
    await thumbnail.waitFor();
    const original = await thumbnail.getAttribute("src");
    assert.ok(original);
    assert.ok(original.startsWith("blob:"));
    await preview.getByText("Captured:", { exact: false }).waitFor();
    await preview.getByRole("button", { name: "Enlarge desktop screenshot" }).click();
    const dialog = page.getByRole("dialog", { name: "Desktop screenshot", exact: true });
    await dialog.waitFor();
    await dialog.getByRole("button", { name: "Close desktop screenshot" }).click();
    const bounds = await preview.boundingBox();
    assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 391);
    assert.equal(await composer.innerText(), "Keep my draft");
    assert.equal(host.requests.filter((request) => request.method === "turn/start").length, 0);
    if (process.env.CODEXHOST_TEST_SCREENSHOTS) {
      mkdirSync(process.env.CODEXHOST_TEST_SCREENSHOTS, { recursive: true });
      await page.screenshot({
        path: join(process.env.CODEXHOST_TEST_SCREENSHOTS, "desktop-screenshot-mobile.png"),
      });
    }

    failure = true;
    await preview.getByRole("button", { name: "Take another screenshot" }).click();
    await preview.getByText("System Settings → Privacy & Security", { exact: false }).waitFor();
    await preview
      .getByText("The image below is the previous screenshot.", { exact: false })
      .waitFor();
    assert.equal(await thumbnail.getAttribute("src"), original);
    failure = false;
    await preview.getByRole("button", { name: "Take another screenshot" }).click();
    await page.waitForFunction(
      (old) =>
        document
          .querySelector('section[aria-label="Desktop screenshot"] img')
          ?.getAttribute("src") !== old,
      original,
    );
    assert.equal(
      await page.evaluate(async (url) => {
        try {
          await fetch(url);
          return true;
        } catch {
          return false;
        }
      }, original),
      false,
    );

    hold = true;
    const closedRequest = nextHeld();
    await preview.getByRole("button", { name: "Take another screenshot" }).click();
    const closedRoute = await closedRequest;
    await preview.getByText("Capturing the desktop…").waitFor();
    assert.equal(await entry.isDisabled(), true);
    await preview.getByRole("button", { name: "Close desktop screenshot" }).click();
    await fulfill(closedRoute).catch(() => undefined);
    assert.equal(await preview.count(), 0);

    const switchedRequest = nextHeld();
    await entry.click();
    const switchedRoute = await switchedRequest;
    await preview.getByText("Capturing the desktop…").waitFor();
    await page.getByRole("button", { name: "Open sidebar", exact: true }).click();
    await page.getByText("Second conversation", { exact: true }).click();
    await entry.waitFor();
    await fulfill(switchedRoute).catch(() => undefined);
    assert.equal(await preview.count(), 0);
    hold = false;
    await entry.click();
    await preview.locator("img").waitFor();
    await preview.getByRole("button", { name: "Close desktop screenshot" }).click();
    assert.equal(await preview.count(), 0);
    assert.equal(requests, 6);
    assert.deepEqual(errors, []);
  },
);
