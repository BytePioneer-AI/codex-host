import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { chromium, type Page, type Route } from "playwright";
import { FakeChHost, startFakeChDebugger } from "../support/ch-host.ts";
import { startServer } from "../support/server.ts";
import { PNG } from "../support/image.ts";

async function shot(page: Page, name: string) {
  if (!process.env.CODEXHOST_TEST_SCREENSHOTS) return;
  mkdirSync(process.env.CODEXHOST_TEST_SCREENSHOTS, { recursive: true });
  await page.screenshot({ path: join(process.env.CODEXHOST_TEST_SCREENSHOTS, name + ".png") });
}

for (const outcome of [
  "success",
  "failure-empty",
  "failure-typed",
  "navigate",
  "navigate-failure",
] as const) {
  it(`mobile attachment send: ${outcome}`, { timeout: 60_000 }, async (t) => {
    const host = new FakeChHost();
    host.add("sending", "/computer/images", "Attachment test");
    host.add("other", "/computer/images", "Other thread");
    const native = host.request.bind(host);
    host.request = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
      const value = await native<T>(method, params);
      if (method === "turn/start") {
        assert.equal(params.threadId, "sending");
        const row = host.threads.get("sending");
        assert.ok(row);
        const turn = row.turns.at(-1);
        assert.ok(turn);
        turn.status = "inProgress";
        turn.items = turn.items.filter((item) => item.type !== "agentMessage");
        row.status = { type: "active" };
      }
      return value;
    };
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
    const context = await browser.newContext({
      viewport: { width: 390, height: 900 },
      isMobile: true,
      hasTouch: true,
    });
    const held: Route[] = [];
    const uploadFor = (name: string, attempt = 0): Route => {
      const route = held.filter(
        (item) => new URL(item.request().url()).searchParams.get("name") === name,
      )[attempt];
      assert.ok(route);
      return route;
    };
    await context.route("**/api/session/uploadFileBinary?*", (route) => {
      held.push(route);
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(url);
    await page.getByText("Native Model", { exact: true }).waitFor({ state: "attached" });
    const select = async (id: string) => {
      await page
        .getByRole("button", { name: "Open sidebar", exact: true })
        .filter({ visible: true })
        .first()
        .click();
      const folder = page
        .getByRole("treeitem")
        .filter({ has: page.getByText("images", { exact: true }) })
        .first();
      if ((await folder.getAttribute("aria-expanded")) === "false") await folder.click();
      await page.locator(`[data-row-key="session:${id}"]`).click();
      await page.waitForFunction(() => {
        const phone = document.querySelector("[data-phone]");
        const drawer = phone?.querySelector('[class*="phoneDrawer"]');
        return (
          phone?.hasAttribute("data-sidebar-collapsed") &&
          drawer &&
          drawer.getBoundingClientRect().right <= 0.5
        );
      });
      await page.locator('[data-composer-card] [contenteditable="true"]').waitFor();
    };
    await select("sending");
    await page.locator("[data-composer-input]:visible").pressSequentially("/");
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("option", { name: /^File\b/u }).click();
    await (
      await chooser
    ).setFiles([
      { name: "photo.png", mimeType: "image/png", buffer: Buffer.from(PNG, "base64") },
      { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("notes") },
    ]);
    const pending = page.getByRole("group", { name: "Pending attachments", exact: true });
    await pending.locator("img").waitFor();
    await pending
      .getByText(/Uploading \d+%/u)
      .first()
      .waitFor();
    while (held.length < 2) await new Promise((resolve) => setTimeout(resolve, 10));
    const composer = page.locator('[data-composer-card] [contenteditable="true"]');
    await composer.fill("Keep this message");
    assert.equal(
      await page.getByRole("button", { name: "Send message", exact: true }).isEnabled(),
      true,
    );
    if (outcome === "success") await shot(page, "attachment-mobile-image-uploading");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    const echo = page.locator("[data-submission-echo]");
    await echo.getByText("Keep this message", { exact: true }).waitFor();
    await echo.locator("[data-upload-progress]").first().waitFor();
    assert.equal(await echo.locator("[data-upload-progress]").count(), 2);
    assert.equal(await composer.innerText(), "");
    assert.equal(host.requests.filter((request) => request.method === "turn/start").length, 0);
    if (outcome === "success") await shot(page, "attachment-mobile-pending-progress");
    if (outcome === "failure-typed") await composer.fill("New text");
    if (outcome.startsWith("navigate")) await select("other");
    if (outcome === "navigate-failure") {
      const failed = page.waitForEvent(
        "requestfailed",
        (request) =>
          request.url().includes("uploadFileBinary") && request.url().includes("photo.png"),
      );
      await uploadFor("photo.png").abort("failed");
      await failed;
      const finished = page.waitForResponse(
        (response) =>
          response.url().includes("uploadFileBinary") && response.url().includes("notes.txt"),
      );
      await uploadFor("notes.txt").continue();
      await (await finished).finished();
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      assert.equal(
        await composer.innerText(),
        "",
        "failure does not enter another Session's draft",
      );
      assert.equal(host.requests.filter((request) => request.method === "turn/start").length, 0);
      await select("sending");
      await echo.waitFor({ state: "detached" });
      await pending
        .getByRole("button", { name: "Retry uploading photo.png", exact: true })
        .waitFor();
      assert.equal(await pending.getByText("notes.txt", { exact: true }).count(), 1);
      assert.equal(
        await composer.innerText(),
        "Keep this message",
        "returning to the page-retained Session reveals its recovered draft",
      );
      await shot(page, "attachment-mobile-failure-after-navigation");
      assert.deepEqual(errors, []);
      return;
    }
    if (outcome.startsWith("failure")) {
      await uploadFor("photo.png").abort("failed");
      await uploadFor("notes.txt").continue();
      await echo.waitFor({ state: "detached" });
      await pending
        .getByRole("button", { name: "Retry uploading photo.png", exact: true })
        .waitFor();
      const expectDraft = async () =>
        assert.equal(
          (await composer.innerText()).replace(/\n+/gu, "\n\n"),
          outcome === "failure-typed" ? "New text\n\nKeep this message" : "Keep this message",
        );
      await expectDraft();
      assert.equal(await pending.getByText("notes.txt", { exact: true }).count(), 1);
      assert.equal(host.requests.filter((request) => request.method === "turn/start").length, 0);
      await page
        .getByText("Retry or remove failed attachments before sending", { exact: true })
        .waitFor();
      await shot(page, `attachment-mobile-${outcome}`);
      await page.getByRole("button", { name: "Send message", exact: true }).click();
      await expectDraft();
      await pending.getByRole("button", { name: "Retry uploading photo.png", exact: true }).click();
      while (held.length < 3) await new Promise((resolve) => setTimeout(resolve, 10));
      await uploadFor("photo.png", 1).continue();
      await pending.getByText(/Uploading/u).waitFor({ state: "detached" });
      await page.getByRole("button", { name: "Send message", exact: true }).click();
    } else {
      await uploadFor("photo.png").continue();
      assert.equal(host.requests.filter((request) => request.method === "turn/start").length, 0);
      await uploadFor("notes.txt").continue();
    }
    if (outcome === "navigate") {
      for (
        let i = 0;
        i < 200 && !host.requests.some((request) => request.method === "turn/start");
        i++
      )
        await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(host.requests.filter((request) => request.method === "turn/start").length, 1);
      await select("sending");
    }
    await page.locator("[data-submission-echo]").waitFor({ state: "detached" });
    const sent = host.requests.find((request) => request.method === "turn/start");
    assert.ok(sent);
    const input = sent.params.input as Array<{ text: string }>;
    assert.equal(
      input[0]?.text.split("## My request:\n").at(-1),
      outcome === "failure-typed" ? "New text\n\nKeep this message" : "Keep this message",
    );
    await page.locator("[data-message-attachments] img").waitFor();
    const working = page.getByText(/^Working(?: ·|$)/u).first();
    await working.waitFor();
    assert.equal(
      await working.isVisible(),
      true,
      "existing Agent working state is visible at phone width",
    );
    assert.equal(await page.locator("[data-upload-progress]").count(), 0);
    if (outcome === "success") await shot(page, "attachment-mobile-agent-working");
    assert.deepEqual(errors, []);
  });
}
