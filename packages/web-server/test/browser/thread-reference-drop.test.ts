/** Native Chromium drag feedback over an isolated CH fixture; never sends to a real Harness. */
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { it, type TestContext } from "node:test";
import { chromium, type Page, type Locator } from "playwright";
import { FakeChHost, startFakeChDebugger } from "../support/ch-host.ts";
import { startServer } from "../support/server.ts";

async function setup(t: TestContext, locale = "en-US") {
  const host = new FakeChHost();
  host.add("source", "/computer/project", "任务：整理默认口径表并测试");
  host.add("other", "/computer/project", "Other chat");
  host.add("destination", "/computer/project", "Destination");
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
  );
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(url);
  await page.getByText("Native Model", { exact: true }).waitFor();
  if (locale === "zh-CN") {
    const response = await page.request.post(new URL("/api/settings/mutate", url).href, {
      headers: { origin: new URL(url).origin },
      data: {
        type: "client-request",
        rpcId: "fixture-locale",
        method: "settings/mutate",
        payload: {
          args: { ns: "locale", ops: [{ op: "set", path: ["preference"], value: "zh" }] },
        },
      },
    });
    assert.equal(response.ok(), true);
    assert.equal((await response.json()).result.ok, true);
    await page.reload();
    await page.getByText("Native Model", { exact: true }).waitFor();
  }
  const folder = page.locator('[data-row-key^="workspace:"]').filter({ hasText: /^project$/ });
  if ((await folder.getAttribute("aria-expanded")) === "false") await folder.click();
  await page.locator('[data-row-key="session:destination"]').click();
  const content = page.locator('[data-conversation-session="destination"]');
  const composer = content.locator("[data-composer-input]");
  await composer.waitFor();
  return {
    host,
    page,
    content,
    composer,
    errors,
    source: page.locator('[data-row-key="session:source"]'),
    overlay: page.locator("[data-thread-reference-drop]"),
  };
}

async function dragInto(page: Page, source: Locator, target: Locator) {
  await page.waitForFunction(() =>
    document.getAnimations().every((animation) => animation.playState !== "running"),
  );
  const start = await source.boundingBox(),
    end = await target.boundingBox();
  assert.ok(start && end);
  await page.mouse.move(start.x + 100, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(start.x + 110, start.y + start.height + 5, { steps: 6 });
  await page.mouse.move(end.x + end.width / 2, end.y + end.height / 3, { steps: 12 });
}

async function shot(page: Page, name: string) {
  if (!process.env.CODEXHOST_TEST_SCREENSHOTS) return;
  mkdirSync(process.env.CODEXHOST_TEST_SCREENSHOTS, { recursive: true });
  await page.screenshot({
    path: join(process.env.CODEXHOST_TEST_SCREENSHOTS, `${name}.png`),
    animations: "disabled",
  });
}

it(
  "chat body has a full blue invitation and title preview; drop inserts once at the retained caret",
  { timeout: 60_000 },
  async (t) => {
    const { page, host, content, composer, source, overlay, errors } = await setup(t);
    await composer.fill("Before After");
    await composer.press("Home");
    for (let i = 0; i < 7; i++) await composer.press("ArrowRight");
    await page.getByRole("button", { name: "Add files or run commands", exact: true }).click();
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("option", { name: /^File\b/u }).click();
    await (
      await chooser
    ).setFiles({
      name: "kept.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("keep attachment"),
    });
    const pending = page.getByRole("group", { name: "Pending attachments", exact: true });
    await pending.getByText("kept.txt", { exact: true }).waitFor();
    const order = await page
      .locator('[data-row-key^="session:"]')
      .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-row-key")));
    await dragInto(page, source, content);
    await overlay.getByText("Release to reference chat", { exact: true }).waitFor();
    assert.equal(await overlay.locator("[data-thread-reference-preview] svg").count(), 1);
    assert.ok((await overlay.innerText()).includes("任务：整理默认口径表并测试"));
    const bounds = await content.boundingBox(),
      cover = await overlay.boundingBox();
    assert.deepEqual(cover, bounds, "overlay covers the entire receivable chat, not only Composer");
    assert.equal(await overlay.evaluate((el) => getComputedStyle(el).pointerEvents), "none");
    await shot(page, "thread-drop-body-hover");
    const editorBounds = await composer.boundingBox();
    assert.ok(editorBounds);
    await page.evaluate(() => {
      const overlay = document.querySelector("[data-thread-reference-drop]");
      const root = overlay?.parentElement;
      if (!overlay || !root) throw new Error("Missing drop overlay");
      const observer = new MutationObserver((records) => {
        if (records.some((record) => [...record.removedNodes].includes(overlay)))
          root.setAttribute("data-overlay-removed", "true");
      });
      observer.observe(root, { childList: true });
    });
    await page.mouse.move(editorBounds.x + 20, editorBounds.y + 10, { steps: 12 });
    assert.equal(await overlay.count(), 1);
    assert.equal(
      await content.getAttribute("data-overlay-removed"),
      null,
      "no flicker across chat children",
    );
    const bodyBounds = await content.boundingBox();
    assert.ok(bodyBounds);
    await page.mouse.move(bodyBounds.x + 40, bodyBounds.y + bodyBounds.height / 2, { steps: 10 });
    await page.mouse.up();
    await overlay.waitFor({ state: "detached" });
    const chip = composer.locator('[data-composer-chip="codexhost-thread"]');
    await chip.waitFor();
    assert.equal(await chip.count(), 1);
    assert.equal(
      (await composer.innerText()).replace(/\s+/gu, " "),
      "Before 任务：整理默认口径表并测试 After",
    );
    await pending.getByText("kept.txt", { exact: true }).waitFor();
    assert.equal(await content.getAttribute("data-conversation-session"), "destination");
    assert.deepEqual(
      await page
        .locator('[data-row-key^="session:"]')
        .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-row-key"))),
      order,
    );
    assert.equal(
      host.requests.some((request) => request.method === "turn/start"),
      false,
    );
    assert.equal(
      host.requests.some(
        (request) => request.method === "thread/turns/list" && request.params.threadId === "source",
      ),
      false,
    );
    await shot(page, "thread-drop-body-inserted");
    await composer.press("ControlOrMeta+z");
    await chip.waitFor({ state: "detached" });
    assert.equal(await composer.innerText(), "Before After");
    assert.deepEqual(errors, []);
  },
);

it(
  "leaving, reentering, Escape, dragend, blur and target replacement clear feedback without changing the draft",
  { timeout: 60_000 },
  async (t) => {
    const { page, content, composer, source, overlay, errors } = await setup(t, "zh-CN");
    await composer.fill("已有草稿");
    await dragInto(page, source, content);
    await overlay.waitFor();
    await overlay.getByText("松开以引用聊天", { exact: true }).waitFor();
    await shot(page, "thread-drop-zh-hover");
    await source.hover();
    await overlay.waitFor({ state: "detached" });
    const bounds = await content.boundingBox();
    assert.ok(bounds);
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 120, { steps: 10 });
    await overlay.waitFor();
    await page.keyboard.press("Escape");
    await page.mouse.up();
    await overlay.waitFor({ state: "detached" });
    assert.equal(await composer.innerText(), "已有草稿");
    // Native lifecycle events also clear a preview when cancellation has no key event.
    for (const event of ["dragend", "blur"]) {
      await dragInto(page, source, content);
      await overlay.waitFor();
      await page.evaluate((type) => window.dispatchEvent(new Event(type)), event);
      await overlay.waitFor({ state: "detached" });
      await page.keyboard.press("Escape");
      await page.mouse.up();
      assert.equal(await composer.innerText(), "已有草稿");
    }
    await dragInto(page, source, content);
    await overlay.waitFor();
    await page
      .locator('[data-row-key="session:other"]')
      .evaluate((row: HTMLElement) => row.click());
    await page.locator('[data-conversation-session="other"]').waitFor();
    await overlay.waitFor({ state: "detached" });
    await page.keyboard.press("Escape");
    await page.mouse.up();
    assert.deepEqual(errors, []);
  },
);

it(
  "unknown, remote, plain-text and file drags cannot claim the chat reference feedback",
  { timeout: 60_000 },
  async (t) => {
    const { page, content, composer, overlay } = await setup(t);
    await composer.fill("Kept draft");
    for (const payload of [
      { threadId: "not-in-catalog", hostId: "local", title: "Unknown" },
      { threadId: "source", hostId: "remote", title: "Remote" },
    ]) {
      const transfer = await page.evaluateHandle((payload) => {
        const transfer = new DataTransfer();
        transfer.setData("application/x-codexhost-thread-reference", JSON.stringify(payload));
        return transfer;
      }, payload);
      await page.locator("body").dispatchEvent("dragstart", { dataTransfer: transfer });
      await content.dispatchEvent("dragover", { dataTransfer: transfer });
      assert.equal(await overlay.count(), 0);
      await content.dispatchEvent("drop", { dataTransfer: transfer });
      await transfer.dispose();
      assert.equal(await composer.innerText(), "Kept draft");
    }
    const files = await page.evaluateHandle(() => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(["file regression"], "dropped.txt", { type: "text/plain" }));
      transfer.setData(
        "application/x-codexhost-thread-reference",
        JSON.stringify({ threadId: "source", hostId: "local", title: "Source" }),
      );
      return transfer;
    });
    await content.dispatchEvent("dragenter", { dataTransfer: files });
    await content.dispatchEvent("dragover", { dataTransfer: files });
    assert.equal(await overlay.count(), 0);
    await content.dispatchEvent("drop", { dataTransfer: files });
    await files.dispose();
    await page
      .getByRole("group", { name: "Pending attachments", exact: true })
      .getByText("dropped.txt", { exact: true })
      .waitFor();
    assert.equal(await composer.innerText(), "Kept draft");
    const text = await page.evaluateHandle(() => {
      const transfer = new DataTransfer();
      transfer.setData("text/plain", "thread://source?hostId=local");
      return transfer;
    });
    await page.locator("body").dispatchEvent("dragstart", { dataTransfer: text });
    await content.dispatchEvent("dragover", { dataTransfer: text });
    assert.equal(await overlay.count(), 0);
    await page.evaluate(() => window.dispatchEvent(new Event("dragend")));
    await text.dispose();
  },
);

it("read-only Composer clears and rejects the reference target", { timeout: 60_000 }, async (t) => {
  const { page, content, composer, source, overlay } = await setup(t);
  await composer.fill("Kept draft");
  await dragInto(page, source, content);
  await overlay.waitFor();
  // Exercise the editor's existing read-only gate, without introducing a UI-only disable flag.
  await composer.evaluate((element) => {
    const editor = (
      element as HTMLElement & { __lexicalEditor?: { setEditable(value: boolean): void } }
    ).__lexicalEditor;
    if (!editor) throw new Error("No mounted Composer editor");
    editor.setEditable(false);
  });
  await overlay.waitFor({ state: "detached" });
  await page.mouse.up();
  assert.equal(await composer.locator("[data-composer-chip]").count(), 0);
  assert.equal(await composer.innerText(), "Kept draft");
});
