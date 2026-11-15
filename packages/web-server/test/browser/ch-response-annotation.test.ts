/**
 * Isolated Web run-through for "select text in a reply → Add to chat": a real
 * Web server process against a fixture Host channel and a headless Chromium
 * context of its own. Screenshots are written only when the run sets
 * CODEXHOST_ANNOTATION_SHOTS to a directory.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { chromium } from "playwright";
import { FakeChChannel } from "../support/ch-channel.ts";
import { startFakeChDebugger } from "../support/ch-host.ts";
import { startServer } from "../support/server.ts";

/** Prompts Codex Desktop composes for the same annotations and body. */
const GOLDEN = JSON.parse(
  readFileSync(
    resolve(
      import.meta.dirname,
      "../../../../packages/shared-contracts/test/fixtures/desktop-annotations.json",
    ),
    "utf8",
  ),
) as { readonly cases: readonly { readonly name: string; readonly desktop: string }[] };

const desktopPrompt = (name: string): string => {
  const entry = GOLDEN.cases.find((item) => item.name === name);
  if (entry === undefined) throw new Error(`missing Desktop case ${name}`);
  return entry.desktop;
};

const shots = process.env.CODEXHOST_ANNOTATION_SHOTS;
if (shots !== undefined) mkdirSync(shots, { recursive: true });
const shoot = async (
  page: { screenshot: (o: { path: string }) => Promise<unknown> },
  name: string,
) => {
  if (shots === undefined) return;
  await page.screenshot({ path: join(shots, name) });
};

it(
  "attaches a selected reply passage and sends it with the Desktop annotation block",
  { timeout: 60_000 },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "ch-response-annotation-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const host = new FakeChChannel();
    const id = "annotation-thread";
    const row = host.add(id, "/synthetic/annotation", "Annotation thread");
    const answer = "The drain loop keeps the queue bounded before the scheduler runs.";
    const turn = row.turns[0];
    assert.ok(turn);
    const message = turn.items.find((item) => item.type === "agentMessage");
    assert.ok(message);
    message.text = answer;
    const debug = await startFakeChDebugger(host);
    t.after(() => debug.close());
    const url = await startServer(
      t,
      resolve(import.meta.dirname, "../.."),
      ["--import", "tsx", "src/main.ts"],
      ["--session-source", "codexhost", "--ch-cdp", debug.endpoint],
      { authenticated: true },
    );
    const browser = await chromium.launch({
      ...(process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH
        ? { executablePath: process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH }
        : {}),
    });
    t.after(async () => {
      await browser.close();
      assert.equal(browser.isConnected(), false);
    });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: "en-US" });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const target = new URL(url);
    target.searchParams.set("session", id);
    await page.goto(target.href);
    const sentence = page.getByText(answer, { exact: true });
    await sentence.waitFor({ timeout: 10_000 });

    // Select one phrase inside the finished answer, the way a drag ends.
    const selected = "keeps the queue bounded";
    await page.evaluate((phrase) => {
      const host_ = document.querySelector("[data-selection-answer]");
      const walker = document.createTreeWalker(host_ as Node, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const at = node.textContent?.indexOf(phrase) ?? -1;
        if (at < 0) continue;
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + phrase.length);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        return;
      }
      throw new Error("phrase not found in the answer");
    }, selected);
    await page.evaluate(() => {
      document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
      document.dispatchEvent(new Event("pointerup", { bubbles: true }));
    });
    const action = page.locator("[data-selection-actions] button");
    await action.waitFor({ timeout: 5_000 });
    assert.equal(await action.textContent(), "Add to chat");
    // Desktop anchors the action's bottom edge 8px above the selection's top.
    const desktopPopover = await page.evaluate(() => {
      const element = document.querySelector<HTMLElement>("[data-selection-actions]");
      const box = element?.getBoundingClientRect();
      const selectionBox = window.getSelection()?.getRangeAt(0).getBoundingClientRect();
      return element === null || box === undefined || selectionBox === undefined
        ? null
        : { bottom: box.bottom, selectionTop: selectionBox.top };
    });
    assert.ok(desktopPopover !== null);
    assert.equal(
      Math.round(desktopPopover.bottom),
      Math.round(desktopPopover.selectionTop) - 8,
      "the action sits 8px above the selection",
    );
    await shoot(page, "01-selection-overlay.png");

    await action.click();
    const chip = page.locator("[data-composer-annotations] > div").first();
    await chip.waitFor({ timeout: 5_000 });
    await shoot(page, "02-composer-annotation.png");

    await chip.locator("button").first().click();
    const card = page.locator("[role='dialog']");
    await card.waitFor({ timeout: 5_000 });
    assert.match((await card.textContent()) ?? "", /Selected text:/);
    assert.match((await card.textContent()) ?? "", new RegExp(selected));
    await shoot(page, "03-annotation-card.png");
    await page.keyboard.press("Escape");

    await page.locator("[data-composer-input]").click();
    await page.keyboard.type("Explain why this bound holds.");
    await page.locator("[data-composer-input]").press("Enter");
    // The Host receives the prompt text: the annotation block, then the request.
    await page.waitForTimeout(1000);
    const sent = host.requests.filter(
      (request) => request.method === "turn/start" || request.method === "turn/addUserMessage",
    );
    const params = sent.at(-1)?.params as
      { input?: readonly { type: string; text?: string }[] } | undefined;
    const text = (params?.input ?? []).flatMap((item) =>
      item.type === "text" && typeof item.text === "string" ? [item.text] : [],
    )[0];
    assert.ok(text, "the Host received one text input");
    // The exact prompt Codex Desktop composes for the same selection, recorded
    // from the installed app's own assembly rather than restated here.
    assert.equal(
      text,
      desktopPrompt("single")
        .replace('"keep the drain loop"', JSON.stringify(selected))
        .replace("Explain why.", "Explain why this bound holds."),
    );
    // The sent bubble carries the request body, never the annotation block,
    // and shows the passage as a chip above it.
    const sentStack = page.locator("[data-message-annotations]").last().locator("..");
    await sentStack.waitFor({ timeout: 5_000 });
    assert.equal(await sentStack.locator("[data-message-annotations] > div").count(), 1);
    const bubble = sentStack.getByText("Explain why this bound holds.", { exact: true });
    assert.equal(await bubble.count(), 1, "the bubble shows exactly the request body");
    assert.equal(
      await sentStack.getByText("# Response annotations:", { exact: false }).count(),
      0,
      "the block stays out of the bubble",
    );
    await shoot(page, "06-sent-bubble-annotation.png");
    // The recorded message is the whole truth: a reload rebuilds the same row.
    await page.reload();
    const reloadedStack = page.locator("[data-message-annotations]").last().locator("..");
    await reloadedStack.waitFor({ timeout: 10_000 });
    assert.equal(await reloadedStack.locator("[data-message-annotations] > div").count(), 1);
    assert.equal(
      await reloadedStack.getByText("Explain why this bound holds.", { exact: true }).count(),
      1,
    );
    assert.deepEqual(errors, []);

    // Phone viewport: the same flow keeps the action below the selection and
    // the chip row inside the composer card.
    const phone = await browser.newPage({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 3,
      locale: "en-US",
    });
    t.after(async () => {
      await phone.close();
    });
    await phone.goto(target.href);
    const phoneAnswer = phone.getByText(answer, { exact: true });
    await phoneAnswer.waitFor({ timeout: 10_000 });
    await phoneAnswer.scrollIntoViewIfNeeded();
    await phone.evaluate((phrase) => {
      const answer = document.querySelector("[data-selection-answer]");
      const walker = document.createTreeWalker(answer as Node, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const at = node.textContent?.indexOf(phrase) ?? -1;
        if (at < 0) continue;
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + phrase.length);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        return;
      }
      throw new Error("phrase not found in the answer");
    }, selected);
    await phone.evaluate(() => {
      document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
      document.dispatchEvent(new Event("pointerup", { bubbles: true }));
    });
    const phoneAction = phone.locator("[data-selection-actions] button");
    await phoneAction.waitFor({ timeout: 5_000 });
    const actionBox = await phoneAction.boundingBox();
    const phoneSelection = await phone.evaluate(() => {
      const selection = window.getSelection();
      const range = selection?.getRangeAt(0);
      const box = range?.getBoundingClientRect();
      return box === undefined ? null : { top: box.top, bottom: box.bottom };
    });
    assert.ok(actionBox !== null && phoneSelection !== null);
    assert.ok(
      actionBox.y >= phoneSelection.bottom - 2,
      "the action sits below the selection, clear of the system callout above it",
    );
    await shoot(phone, "04-phone-selection-overlay.png");
    await phoneAction.click();
    await phone.locator("[data-composer-annotations]").waitFor({ timeout: 5_000 });
    const composerBox = await phone.locator("[data-composer-card]").boundingBox();
    const chipBox = await phone.locator("[data-composer-annotations]").boundingBox();
    assert.ok(composerBox !== null && chipBox !== null);
    assert.ok(
      chipBox.x >= composerBox.x &&
        chipBox.x + chipBox.width <= composerBox.x + composerBox.width + 1,
      "the chip row stays inside the composer card",
    );
    await shoot(phone, "05-phone-composer-annotation.png");
  },
);
