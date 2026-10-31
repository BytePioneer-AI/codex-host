import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { it, type TestContext } from "node:test";
import { chromium, type Page } from "playwright";
import { FakeChHost, startFakeChDebugger } from "../support/ch-host.ts";
import { startServer } from "../support/server.ts";

async function setup(t: TestContext) {
  const host = new FakeChHost();
  host.add("reference-a", "/computer/project", "Same title");
  host.add("reference-b", "/computer/project", "Same title");
  host.add("recent-reference", "/computer/loose", "Recent title", false);
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
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
    permissions: ["clipboard-read", "clipboard-write"],
  });
  await page.goto(url);
  await page.getByText("Native Model", { exact: true }).waitFor();
  const folder = page.locator('[data-row-key^="workspace:"]').filter({ hasText: /^project$/ });
  if ((await folder.getAttribute("aria-expanded")) === "false") await folder.click();
  await page.locator('[data-row-key="session:destination"]').click();
  await page.locator('[data-conversation-session="destination"] [data-composer-input]').waitFor();
  return { host, page };
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
  "shared Recents can drag a local canonical reference without enabling sorting",
  { timeout: 60_000 },
  async (t) => {
    const { page, host } = await setup(t);
    const recent = page.locator('[data-row-key="recent:recent-reference"]');
    assert.equal(await recent.getAttribute("draggable"), "true");
    const before = await page
      .locator('[data-sidebar-group=""] [data-row-key^="recent:"]')
      .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-row-key")));
    await page.evaluate(() => {
      document.addEventListener("dragstart", (event) => {
        document.body.dataset.referenceDrag = JSON.stringify({
          effect: event.dataTransfer?.effectAllowed,
          payload: event.dataTransfer?.getData("application/x-codexhost-thread-reference"),
          text: event.dataTransfer?.getData("text/plain"),
        });
      });
      document.addEventListener("dragover", (event) => event.preventDefault());
      document.addEventListener("drop", (event) => event.preventDefault());
    });
    await recent.dragTo(page.locator('[data-row-key="session:reference-a"]'));
    const dragText = await page.locator("body").getAttribute("data-reference-drag");
    assert.ok(dragText);
    const drag = JSON.parse(dragText);
    assert.equal(drag.effect, "copy");
    assert.deepEqual(JSON.parse(drag.payload), {
      threadId: "recent-reference",
      hostId: "local",
      title: "Recent title",
    });
    assert.equal(drag.text, "[@Recent title](thread://recent-reference?hostId=local)");
    assert.deepEqual(
      await page
        .locator('[data-sidebar-group=""] [data-row-key^="recent:"]')
        .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-row-key"))),
      before,
    );
    assert.equal(
      await page.locator("[data-conversation-content]").getAttribute("data-conversation-session"),
      "destination",
    );
    assert.equal(
      host.requests.some((request) => request.method === "turn/start"),
      false,
    );
    await shot(page, "thread-reference-recents");
  },
);

it(
  "Composer drops blue atomic session chips among text, keeps attachments, and never commits a stale reorder",
  { timeout: 60_000 },
  async (t) => {
    const { page, host } = await setup(t);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const composer = page.locator("[data-composer-input]");
    const row = (id: string) =>
      page.locator(`[data-row-key="session:${id}"], [data-row-key="recent:${id}"]`).first();
    const order = () =>
      page
        .locator('[data-row-key^="session:"]')
        .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-row-key")));
    await composer.fill("before after");
    await composer.press("Home");
    for (let i = 0; i < 7; i++) await composer.press("ArrowRight");
    await page.locator("[data-composer-input]:visible").pressSequentially("/");
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("option", { name: /^File\b/u }).click();
    await (
      await chooser
    ).setFiles({
      name: "kept.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("kept attachment"),
    });
    const pending = page.getByRole("group", { name: "Pending attachments", exact: true });
    await pending.getByText("kept.txt", { exact: true }).waitFor();
    const initialOrder = await order();
    const source = await row("reference-a").boundingBox();
    const target = await row("reference-b").boundingBox();
    const destination = await composer.boundingBox();
    assert.ok(source && target && destination);
    // A native drag traverses a valid sidebar sorting target before entering Composer.
    await page.mouse.move(source.x + 100, source.y + source.height / 2);
    await page.mouse.down();
    await page.mouse.move(target.x + 100, target.y + target.height - 2, { steps: 10 });
    await page.mouse.move(destination.x + 50, destination.y + 10, { steps: 10 });
    await page.mouse.up();
    const chips = composer.locator('[data-composer-chip="codexhost-thread"]');
    await chips.waitFor();
    assert.equal(await chips.innerText(), "Same title");
    assert.equal(await chips.locator("svg").count(), 1);
    const color = await chips
      .locator("span[title]")
      .evaluate((element) => getComputedStyle(element).color);
    assert.equal(color, "rgb(65, 118, 230)", "existing business-primary blue");
    assert.equal((await composer.innerText()).replace(/\s+/gu, " "), "before Same title after");
    await composer.press("ControlOrMeta+z");
    await chips.waitFor({ state: "detached" });
    assert.equal(await composer.innerText(), "before after");
    await composer.press("ControlOrMeta+Shift+z");
    await chips.waitFor();
    await chips.evaluate((chip) => {
      const range = document.createRange();
      range.setStartBefore(chip);
      range.collapse(true);
      const selection = window.getSelection();
      if (selection === null) throw new Error("No browser selection");
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });
    await composer.press("Delete");
    await chips.waitFor({ state: "detached", timeout: 3000 });
    assert.equal(await chips.count(), 0, "chip deletes as one whole reference");
    await composer.press("ControlOrMeta+z");
    await chips.waitFor();
    await row("reference-b").dragTo(composer);
    await page.waitForFunction(
      () => document.querySelectorAll('[data-composer-chip="codexhost-thread"]').length === 2,
    );
    await row("recent-reference").dragTo(composer);
    await page.waitForFunction(
      () => document.querySelectorAll('[data-composer-chip="codexhost-thread"]').length === 3,
    );
    assert.deepEqual(await order(), initialOrder);
    assert.equal(
      await page.locator("[data-conversation-content]").getAttribute("data-conversation-session"),
      "destination",
    );
    await pending.getByText("kept.txt", { exact: true }).waitFor();
    assert.equal(
      host.requests.some((request) => request.method === "turn/start"),
      false,
    );
    assert.equal(
      host.requests.some(
        (request) =>
          request.method === "thread/turns/list" &&
          ["reference-a", "reference-b", "recent-reference"].includes(
            String(request.params.threadId),
          ),
      ),
      false,
    );
    await shot(page, "thread-reference-inline-blue");
    const files = await page.evaluateHandle(() => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(["file drop regression"], "dropped.txt", { type: "text/plain" }));
      return transfer;
    });
    await composer.dispatchEvent("drop", { dataTransfer: files });
    await files.dispose();
    await pending.getByText("dropped.txt", { exact: true }).waitFor();
    assert.equal(await chips.count(), 3, "file intake leaves references intact");
    // A subsequent real sidebar drop must still reorder (copy handling cannot disable sorting).
    await row("reference-a").dragTo(row("reference-b"), {
      targetPosition: { x: 100, y: target.height - 2 },
    });
    assert.notDeepEqual(await order(), initialOrder);
    const response = page.waitForResponse((response) =>
      response.url().endsWith("/api/session/prompt"),
    );
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    assert.equal((await response).ok(), true);
    const submitted = host.requests.find((request) => request.method === "turn/start");
    assert.ok(submitted);
    const text = (submitted.params.input as Array<{ text: string }>)[0]?.text;
    assert.ok(text);
    assert.ok(text.includes("[@Same title](thread://reference-a?hostId=local)"));
    assert.ok(text.includes("[@Same title](thread://reference-b?hostId=local)"));
    assert.ok(text.includes("[@Recent title](thread://recent-reference?hostId=local)"));
    assert.deepEqual(errors, []);
  },
);

it(
  "session menu copies the canonical local link, reports clipboard denial, and pastes only text",
  { timeout: 60_000 },
  async (t) => {
    const { page, host } = await setup(t);
    const composer = page.locator("[data-composer-input]");
    await composer.fill("Kept draft ");
    const row = page.locator('[data-row-key="session:reference-b"]');
    const open = async () => {
      await row.hover();
      await row.getByRole("button", { name: /^Session actions for/ }).click();
      await page.getByRole("menuitem", { name: "Copy session link", exact: true }).waitFor();
    };
    await open();
    await page.getByRole("menuitem", { name: "Copy session link", exact: true }).click();
    await page.getByText("Copied", { exact: true }).waitFor();
    assert.equal(
      await page.evaluate(() => navigator.clipboard.readText()),
      "thread://reference-b?hostId=local",
    );
    assert.equal(await composer.innerText(), "Kept draft ");
    assert.equal(
      await page.locator("[data-conversation-content]").getAttribute("data-conversation-session"),
      "destination",
    );
    await composer.click();
    await composer.press("ControlOrMeta+End");
    await composer.press("ControlOrMeta+v");
    await page.waitForFunction(() =>
      document
        .querySelector("[data-composer-input]")
        ?.textContent?.includes("thread://reference-b?hostId=local"),
    );
    assert.equal(await composer.locator("[data-composer-chip]").count(), 0);
    const text = await composer.innerText();
    await shot(page, "thread-reference-menu-pasted-text");
    await page.getByText("Copied", { exact: true }).waitFor({ state: "hidden" });
    await page.evaluate(`Object.defineProperty(navigator.clipboard, "writeText", {
    configurable: true,
    value: async function () { throw new DOMException("Clipboard denied", "NotAllowedError"); }
  })`);
    await open();
    await page.getByRole("menuitem", { name: "Copy session link", exact: true }).click();
    await page.getByText("Could not copy session link", { exact: true }).waitFor();
    assert.equal(await page.getByText("Copied", { exact: true }).count(), 0);
    assert.equal(await composer.innerText(), text);
    assert.equal(
      host.requests.some((request) => request.method === "turn/start"),
      false,
    );
    assert.equal(
      host.requests.some(
        (request) =>
          request.method === "thread/turns/list" && request.params.threadId === "reference-b",
      ),
      false,
    );
    await shot(page, "thread-reference-menu-denied");
  },
);

it(
  "chip clipboard and restored drafts retain identity through refusal and unknown submission outcome",
  { timeout: 60_000 },
  async (t) => {
    const { page, host } = await setup(t);
    const composer = page.locator("[data-composer-input]");
    const chips = composer.locator('[data-composer-chip="codexhost-thread"]');
    await composer.fill("Read this ");
    await page.locator('[data-row-key="session:reference-a"]').dragTo(composer);
    await chips.waitFor();
    await composer.click();
    await composer.press("ControlOrMeta+a");
    await composer.press("ControlOrMeta+c");
    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    assert.equal(clipboard.trim(), "Read this [@Same title](thread://reference-a?hostId=local)");
    await page.reload();
    await chips.waitFor();
    assert.equal(await chips.innerText(), "Same title");
    await composer.click();
    await composer.press("ControlOrMeta+a");
    await composer.press("ControlOrMeta+c");
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), clipboard);
    const native = host.request.bind(host);
    let attempts = 0,
      outcome = "refused";
    host.request = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
      if (method !== "turn/start") return native<T>(method, params);
      attempts++;
      assert.deepEqual(structuredClone(params.input), [
        { type: "text", text: clipboard.trim(), text_elements: [] },
      ]);
      if (outcome === "refused") throw new Error("Reference refused");
      // The owner writes, but loses the acknowledgement: the client must not resend.
      await native<T>(method, params);
      throw new Error("Reference outcome unknown");
    };
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await page.getByText(/Reference refused/u).waitFor();
    await chips.waitFor();
    assert.equal(attempts, 1);
    assert.equal(host.threads.get("destination")?.turns.length, 1);
    outcome = "unknown";
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await page.getByText(/Reference outcome unknown/u).waitFor();
    await chips.waitFor();
    await page.waitForTimeout(500);
    assert.equal(attempts, 2, "no automatic resend after the ambiguous result");
    assert.equal(host.threads.get("destination")?.turns.length, 2);
    assert.equal(host.threads.get("reference-a")?.turns.length, 1);
    await shot(page, "thread-reference-failure-kept");
  },
);

it(
  "manual IDs and both URI forms stay plain text with explicit sources unchanged",
  { timeout: 60_000 },
  async (t) => {
    const { page, host } = await setup(t);
    const text = [
      "01900000-1234-5678-9000-000000000001",
      "codex://threads/reference-a",
      "thread://reference-b?hostId=local",
      "[@Same title](thread://reference-a?hostId=local)",
      "thread://reference-b?hostId=remote-explicit",
    ].join("\n");
    const composer = page.locator("[data-composer-input]");
    await page.evaluate((text) => navigator.clipboard.writeText(text), text);
    await composer.click();
    await composer.press("ControlOrMeta+v");
    await page.waitForFunction(
      (text) => document.querySelector("[data-composer-input]")?.textContent?.includes(text),
      "hostId=remote-explicit",
    );
    assert.equal(await composer.locator("[data-composer-chip]").count(), 0);
    const response = page.waitForResponse((response) =>
      response.url().endsWith("/api/session/prompt"),
    );
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await response;
    assert.deepEqual(
      host.requests.find((request) => request.method === "turn/start")?.params.input,
      [{ type: "text", text, text_elements: [] }],
    );
    assert.equal(host.threads.get("reference-a")?.turns.length, 1);
    assert.equal(host.threads.get("reference-b")?.turns.length, 1);
  },
);

it(
  "flat-list reference drops cancel stale sorting and leave subsequent keyboard navigation usable",
  { timeout: 60_000 },
  async (t) => {
    const { page } = await setup(t);
    await page.getByRole("button", { name: "View options", exact: true }).click();
    await page.getByRole("menuitem", { name: "In one list", exact: true }).click();
    const row = (id: string) => page.locator(`[data-row-key="session:${id}"]`);
    const order = () =>
      page
        .locator('[data-row-key^="session:"]')
        .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-row-key")));
    const before = await order();
    const composer = page.locator("[data-composer-input]");
    await composer.fill("Flat draft ");
    const source = await row("reference-a").boundingBox();
    const over = await row("reference-b").boundingBox();
    const destination = await composer.boundingBox();
    assert.ok(source && over && destination);
    await page.mouse.move(source.x + 100, source.y + source.height / 2);
    await page.mouse.down();
    await page.mouse.move(over.x + 100, over.y + over.height - 2, { steps: 10 });
    await page.mouse.move(destination.x + 50, destination.y + 10, { steps: 10 });
    await page.mouse.up();
    await composer.locator('[data-composer-chip="codexhost-thread"]').waitFor();
    assert.deepEqual(await order(), before);
    assert.equal(
      await page.locator("[data-conversation-content]").getAttribute("data-conversation-session"),
      "destination",
    );
    await row("reference-a").focus();
    await row("reference-a").press("Enter");
    await page.locator('[data-conversation-session="reference-a"]').waitFor();
  },
);
