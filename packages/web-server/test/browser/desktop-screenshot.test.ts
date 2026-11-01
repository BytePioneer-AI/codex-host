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
      reducedMotion: "no-preference",
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

    hold = true;
    const firstRequest = nextHeld();
    await entry.tap();
    const float = page.getByRole("group", { name: "Desktop screenshot", exact: true });
    await float.getByRole("button", { name: "Capturing the desktop…" }).waitFor();
    assert.equal(await entry.getAttribute("aria-busy"), "true");
    assert.equal(await entry.locator("rect").count(), 0);
    const spinner = entry.locator('span[aria-hidden="true"]').first();
    assert.notEqual(await spinner.evaluate((node) => getComputedStyle(node).animationName), "none");
    await page.emulateMedia({ reducedMotion: "reduce" });
    assert.equal(await spinner.evaluate((node) => getComputedStyle(node).animationName), "none");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    const thumbnail = float.locator("img");
    assert.equal(await thumbnail.count(), 0);
    const firstRoute = await firstRequest;
    assert.equal(requests, 1);
    hold = false;
    await fulfill(firstRoute);
    await thumbnail.waitFor();
    assert.equal(await entry.getAttribute("aria-busy"), "false");
    const original = await thumbnail.getAttribute("src");
    assert.ok(original);
    assert.ok(original.startsWith("blob:"));

    // A fresh capture opens the viewer at once, upright, with a one-time zoom hint.
    const dialog = page.getByRole("dialog", { name: "Desktop screenshot", exact: true });
    await dialog.waitFor();
    const canvas = dialog.getByRole("img", { name: "Connected computer · Main display" });
    await canvas.waitFor();
    const upright = await canvas.boundingBox();
    assert.ok(upright && upright.width > upright.height);
    await dialog.getByText("Pinch to zoom", { exact: false }).waitFor();
    await dialog.getByRole("button", { name: "Close desktop screenshot" }).click();
    await dialog.waitFor({ state: "detached" });

    // A drag moves the bubble without enlarging it, and stays inside the viewport.
    const bubble = float.getByRole("button", { name: "Enlarge desktop screenshot" });
    const before = await float.boundingBox();
    assert.ok(before);
    await page.mouse.move(before.x + 30, before.y + 30);
    await page.mouse.down();
    await page.mouse.move(before.x - 80, before.y + 150, { steps: 6 });
    await page.mouse.up();
    const moved = await float.boundingBox();
    assert.ok(moved);
    assert.ok(moved.y > before.y + 100 && moved.x < before.x - 40);
    assert.ok(moved.x >= 0 && moved.x + moved.width <= 390);
    assert.equal(await page.getByRole("dialog").count(), 0);

    await bubble.click();
    await dialog.waitFor();

    // Landscape turns the whole stage; marks drawn there still land on the image.
    await canvas.waitFor();
    const portraitBox = await canvas.boundingBox();
    assert.ok(portraitBox && portraitBox.height < portraitBox.width);
    // Wheel zoom enlarges the image about the pointer; Fit restores it.
    await page.mouse.move(
      portraitBox.x + portraitBox.width / 2,
      portraitBox.y + portraitBox.height / 2,
    );
    await page.mouse.wheel(0, -600);
    const zoomed = await canvas.boundingBox();
    assert.ok(zoomed && zoomed.width > portraitBox.width * 1.5);
    await dialog.getByRole("button", { name: /Fit/ }).click();
    const fitted = await canvas.boundingBox();
    assert.ok(fitted && Math.abs(fitted.width - portraitBox.width) < 2);

    // Save hands the image to the browser as a PNG download.
    const download = page.waitForEvent("download");
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    assert.match((await download).suggestedFilename(), /^desktop-screenshot-.*\.png$/u);

    // Cropping keeps only the selected region; the original can be restored.
    await dialog.getByRole("button", { name: "Crop", exact: true }).click();
    const cropBox = await canvas.boundingBox();
    assert.ok(cropBox);
    await page.mouse.move(cropBox.x + cropBox.width * 0.1, cropBox.y + cropBox.height * 0.1);
    await page.mouse.down();
    await page.mouse.move(cropBox.x + cropBox.width * 0.4, cropBox.y + cropBox.height * 0.4, {
      steps: 5,
    });
    await page.mouse.up();
    await dialog.getByRole("button", { name: "Done" }).click();
    await dialog.getByRole("button", { name: "Restore original" }).waitFor();
    const cropped = await canvas.evaluate((node: HTMLCanvasElement) => [node.width, node.height]);
    assert.ok(Math.abs((cropped[0] ?? 0) - 640) <= 6 && Math.abs((cropped[1] ?? 0) - 360) <= 6);
    await dialog.getByRole("button", { name: "Restore original" }).click();
    await page.waitForFunction(
      () => document.querySelector<HTMLCanvasElement>('[role="dialog"] canvas')?.width === 1280,
    );

    await dialog.getByRole("button", { name: "Landscape" }).click();
    const landscapeBox = await canvas.boundingBox();
    assert.ok(landscapeBox && landscapeBox.height > landscapeBox.width);
    await dialog.getByRole("button", { name: "Mark up" }).click();
    const paint = async () => {
      const box = await canvas.boundingBox();
      assert.ok(box);
      await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.3);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.7, { steps: 5 });
      await page.mouse.up();
    };
    const pixels = () =>
      canvas.evaluate((node: HTMLCanvasElement) => {
        const context = node.getContext("2d");
        const data = context?.getImageData(0, 0, node.width, node.height).data ?? [];
        let red = 0;
        for (let index = 0; index < data.length; index += 4)
          if (
            (data[index] ?? 0) > 200 &&
            (data[index + 1] ?? 255) < 90 &&
            (data[index + 2] ?? 255) < 90
          )
            red++;
        return red;
      });
    assert.equal(await pixels(), 0);
    await paint();
    assert.ok((await pixels()) > 100);
    await dialog.getByRole("button", { name: "Undo" }).click();
    assert.equal(await pixels(), 0);
    await paint();
    await dialog.getByRole("button", { name: "Done" }).click();
    await dialog.getByRole("button", { name: "Restore original" }).waitFor();
    assert.ok((await pixels()) > 100);
    await dialog.getByRole("button", { name: "Add to conversation" }).click();
    await dialog.waitFor({ state: "detached" });
    await page.locator('[data-composer-card] img[src^="blob:"]').first().waitFor();
    assert.equal(await composer.innerText(), "Keep my draft");

    await bubble.click();
    await dialog.waitFor();
    await dialog.getByRole("button", { name: "Close desktop screenshot" }).click();

    assert.equal(await composer.innerText(), "Keep my draft");
    assert.equal(host.requests.filter((request) => request.method === "turn/start").length, 0);
    if (process.env.CODEXHOST_TEST_SCREENSHOTS) {
      mkdirSync(process.env.CODEXHOST_TEST_SCREENSHOTS, { recursive: true });
      await page.screenshot({
        path: join(process.env.CODEXHOST_TEST_SCREENSHOTS, "desktop-screenshot-mobile.png"),
      });
    }

    failure = true;
    await entry.click();
    await float.getByText("tried to open Screen Recording settings", { exact: false }).waitFor();
    await float.getByText("System Settings → Privacy & Security", { exact: false }).waitFor();
    assert.equal(await thumbnail.getAttribute("src"), original);
    failure = false;
    await float.getByRole("button", { name: /Take another screenshot/ }).click();
    await page.waitForFunction(
      (old) =>
        document
          .querySelector('[role="group"][aria-label="Desktop screenshot"] img')
          ?.getAttribute("src") !== old,
      original,
    );
    await dialog.getByRole("button", { name: "Close desktop screenshot" }).click();
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
    await entry.click();
    const closedRoute = await closedRequest;
    await float.getByRole("button", { name: "Capturing the desktop…" }).waitFor();
    await float.getByRole("button", { name: "Close desktop screenshot" }).click();
    await fulfill(closedRoute).catch(() => undefined);
    assert.equal(await float.count(), 0);

    const switchedRequest = nextHeld();
    await entry.click();
    const switchedRoute = await switchedRequest;
    await float.getByRole("button", { name: "Capturing the desktop…" }).waitFor();
    await page.getByRole("button", { name: "Open sidebar", exact: true }).click();
    await page.getByText("Second conversation", { exact: true }).click();
    await entry.waitFor();
    await fulfill(switchedRoute).catch(() => undefined);
    assert.equal(await float.count(), 0);
    hold = false;
    await entry.click();
    await dialog.waitFor();

    // Writing a line and sending adds the image to this draft and submits it in one step.
    await dialog.getByRole("textbox", { name: /Add a line/ }).fill("It fails here");
    await dialog.getByRole("button", { name: "Send", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    await page.waitForFunction(() => true);
    for (let attempt = 0; attempt < 50; attempt++) {
      if (host.requests.some((request) => request.method === "turn/start")) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const sent = host.requests.find((request) => request.method === "turn/start");
    assert.ok(sent);
    const text = JSON.stringify(sent.params);
    assert.ok(text.includes("It fails here") && text.includes("Image attachment: true"));
    await float.getByRole("button", { name: "Close desktop screenshot" }).click();
    assert.equal(await float.count(), 0);
    assert.equal(requests, 6);
    assert.deepEqual(errors, []);
  },
);
