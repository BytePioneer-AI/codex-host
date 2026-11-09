import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { chromium, type Locator, type Page } from "playwright";
import { FakeChHost, startFakeChDebugger } from "../support/ch-host.ts";
import { startServer } from "../support/server.ts";

const box = async (locator: Locator) => {
  const rect = await locator.boundingBox();
  assert.ok(rect, "element must be laid out");
  return rect;
};

async function settleEntry(page: Page) {
  await page.locator("[data-composer-tray]").evaluate(async (entry) => {
    await Promise.all(entry.getAnimations().map((animation) => animation.finished));
  });
}

/** Open the Session with voice reported available, then start recording. */
async function startRecording(page: Page, url: string, cardWidth?: number) {
  // Headless Chromium leaves getUserMedia pending; a generated tone drives the same recorder.
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      const audio = new AudioContext();
      const tone = audio.createOscillator();
      const output = audio.createMediaStreamDestination();
      tone.connect(output);
      tone.start();
      return output.stream;
    };
  });
  await page.route("**/api/codexhost/voice/status", (route) =>
    route.fulfill({ json: { result: { ok: true, value: { available: true } } } }),
  );
  const target = new URL(url);
  target.searchParams.set("session", "thread");
  await page.goto(target.href);
  const toolbar = page.locator("[data-composer-toolbar]");
  const card = toolbar.locator("..");
  const model = page.getByRole("button", { name: /^Select model, current Native Model/u });
  await model.waitFor();
  await page.getByRole("button", { name: "Voice input", exact: true }).waitFor();
  if (cardWidth !== undefined) {
    await card.evaluate((element, width) => {
      element.style.maxWidth = `${width}px`;
    }, cardWidth);
  }
  const before = await box(card);
  const screenshot = page.getByRole("button", { name: "Desktop screenshot", exact: true });
  const screenshotBefore = await box(screenshot);
  const modelBefore = await box(model);
  await page.getByRole("button", { name: "Voice input", exact: true }).click();
  const stop = page.getByRole("button", { name: "Stop and insert into draft", exact: true });
  await assert.doesNotReject(
    stop.and(page.locator(":enabled")).waitFor(),
    "recording must start with the generated microphone stream",
  );
  await settleEntry(page);
  return { card, before, model, stop, screenshot, screenshotBefore, modelBefore };
}

it(
  "reserves recorder space and restores toolbar controls without growing the composer",
  { timeout: 90_000 },
  async (t) => {
    const workspace = mkdtempSync(join(tmpdir(), "voice-recorder-layout-"));
    t.after(() => rmSync(workspace, { recursive: true, force: true }));
    const host = new FakeChHost();
    host.add("thread", workspace, "Voice thread");
    const debug = await startFakeChDebugger(host);
    t.after(() => debug.close());
    const url = await startServer(
      t,
      resolve(import.meta.dirname, "../.."),
      ["--import", "tsx", "src/main.ts"],
      ["--session-source", "codexhost", "--ch-cdp", debug.endpoint],
    );
    const browser = await chromium.launch();
    t.after(() => browser.close());

    await t.test("phone", async () => {
      const context = await browser.newContext({
        viewport: { width: 360, height: 780 },
        hasTouch: true,
        isMobile: true,
        userAgent:
          "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 Version/18.6 Mobile/15E148 Safari/604.1",
      });
      t.after(() => context.close());
      const page = await context.newPage();
      const { card, before, model, stop } = await startRecording(page, url);
      const strip = page.getByRole("group", { name: "Voice input", exact: true });
      const send = page.getByRole("button", { name: "Send message", exact: true });
      const cancel = page.getByRole("button", { name: "Cancel recording", exact: true });

      const after = await box(card);
      assert.ok(
        after.height <= before.height + 1,
        "recording must not grow the composer even if idle controls wrap",
      );
      const stripBox = await box(strip);
      const sendBox = await box(send);
      assert.ok(stripBox.x >= after.x && stripBox.x + stripBox.width <= sendBox.x);
      assert.ok(stripBox.x >= 0 && sendBox.x + sendBox.width <= after.x + after.width);
      // The strip replaces the accessory controls; the main submit still sends.
      assert.equal(await model.isVisible(), false);
      assert.equal(await send.isEnabled(), true);
      assert.equal(
        await page.getByRole("button", { name: "Transcribe and send", exact: true }).count(),
        0,
      );
      // 26px controls keep 44px touch targets.
      for (const control of [cancel, stop]) {
        const rect = await box(control);
        const hit = await page.evaluate(
          ({ x, y }) => document.elementFromPoint(x, y)?.closest("button")?.ariaLabel ?? null,
          { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 - 20 },
        );
        assert.equal(hit, await control.getAttribute("aria-label"));
      }

      await cancel.click();
      await strip.waitFor({ state: "detached" });
      await model.waitFor();
      assert.ok(Math.abs((await box(card)).height - before.height) <= 1);
    });

    await t.test("desktop keeps the inline bar beside the toolbar controls", async () => {
      const context = await browser.newContext({
        viewport: { width: 1280, height: 900 },
      });
      t.after(() => context.close());
      const page = await context.newPage();
      const { card, before, model, stop, screenshot, screenshotBefore, modelBefore } =
        await startRecording(page, url);
      assert.equal(await model.isVisible(), true);
      assert.equal(
        await page.getByRole("button", { name: "Transcribe and send", exact: true }).count(),
        1,
      );
      assert.ok(Math.abs((await box(card)).height - before.height) <= 1);
      const recorder = page.getByRole("group", { name: "Voice input", exact: true });
      const screenshotDuring = await box(screenshot);
      const recorderBox = await box(recorder);
      assert.ok(screenshotDuring.x < screenshotBefore.x - 190, "left sibling moves left");
      assert.ok(screenshotDuring.x + screenshotDuring.width <= recorderBox.x);
      assert.ok(Math.abs(screenshotDuring.y - screenshotBefore.y) <= 1);
      assert.ok(
        Math.abs((await box(model)).x - modelBefore.x) <= 1,
        "right controls stay anchored",
      );
      assert.equal(
        await screenshot.evaluate((button) => {
          const rect = button.getBoundingClientRect();
          return (
            document
              .elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
              ?.closest("button") === button
          );
        }),
        true,
        "the left control remains clickable",
      );
      let finishTranscription!: () => void;
      const transcribing = new Promise<void>((resolve) => {
        finishTranscription = resolve;
      });
      await page.route("**/api/voice/transcribe", async (route) => {
        await transcribing;
        await route.fulfill({ json: { ok: true, text: "Voice draft" } });
      });
      await stop.click();
      await recorder.getByRole("status").waitFor();
      assert.ok(Math.abs((await box(screenshot)).x - screenshotDuring.x) <= 1);
      finishTranscription();
      await page.getByRole("group", { name: "Voice input", exact: true }).waitFor({
        state: "detached",
      });
      await settleEntry(page);
      assert.ok(Math.abs((await box(screenshot)).x - screenshotBefore.x) <= 1);
      assert.ok(Math.abs((await box(model)).x - modelBefore.x) <= 1);
    });

    await t.test("narrow desktop uses the strip when all controls cannot fit", async () => {
      const context = await browser.newContext({ viewport: { width: 620, height: 900 } });
      t.after(() => context.close());
      const page = await context.newPage();
      const { card, before, model } = await startRecording(page, url, 420);
      assert.equal(await model.isVisible(), false);
      const strip = await box(page.getByRole("group", { name: "Voice input", exact: true }));
      const send = await box(page.getByRole("button", { name: "Send message", exact: true }));
      const after = await box(card);
      assert.ok(strip.x >= after.x && strip.x + strip.width <= send.x);
      assert.ok(after.height <= before.height + 1);
      await page.keyboard.press("Escape");
      await model.waitFor();
      await settleEntry(page);
      assert.ok(Math.abs((await box(card)).height - before.height) <= 1);
    });
  },
);
