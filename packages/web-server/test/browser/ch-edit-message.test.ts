/** Real browser edits against the existing Host wire protocol, with disposable test services. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { chromium } from "playwright";
import { FakeChChannel, startFakeChChannel } from "../support/ch-channel.ts";
import { startFakeChDebugger } from "../support/ch-host.ts";
import { startServer } from "../support/server.ts";

it(
  "offers sent-message editing after creating and completing the first Web Turn",
  { timeout: 45_000 },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "ch-browser-created-edit-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const host = new FakeChChannel();
    host.inspection.capabilities.history.rollbackLastTurn = true;
    const debug = await startFakeChDebugger(host);
    t.after(() => debug.close());
    const channel = await startFakeChChannel(host, directory);
    t.after(() => channel.close());
    const url = await startServer(
      t,
      resolve(import.meta.dirname, "../.."),
      ["--import", "tsx", "src/main.ts"],
      [
        "--session-source",
        "codexhost",
        "--ch-cdp",
        debug.endpoint,
        "--ch-control-directory",
        directory,
      ],
    );
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(url);
    await page.getByText("Native Model", { exact: true }).waitFor();
    assert.equal(host.threads.size, 0);
    await page.locator("[data-composer-input]").fill("First message created in Web");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await page.getByText("CH response: First message created in Web", { exact: true }).waitFor();
    const created = [...host.threads.values()][0];
    assert.ok(created);
    assert.equal(
      host.requests.find((request) => request.method === "thread/start")?.params.historyMode,
      "paginated",
    );
    assert.equal(created.historyMode, "paginated");
    assert.equal(created.turns[0]?.status, "completed");
    const firstTurnId = created.turns[0]?.id;
    await page.getByRole("button", { name: "Edit message", exact: true }).click();
    const editor = page.getByRole("textbox", { name: "Edit message", exact: true });
    assert.equal(await editor.inputValue(), "First message created in Web");
    await editor.fill("Edited first Web message");
    await page
      .locator("[data-sent-message-editor]")
      .getByRole("button", { name: "Send", exact: true })
      .click();
    await page.getByText("CH response: Edited first Web message", { exact: true }).waitFor();
    assert.deepEqual(host.requests.find((request) => request.method === "thread/revert")?.params, {
      threadId: created.id,
      beforeTurnId: firstTurnId,
    });
    assert.equal(host.requests.filter((request) => request.method === "thread/start").length, 1);
    assert.equal(host.threads.size, 1);
    assert.equal(created.turns.length, 1);
    assert.deepEqual(errors, []);
  },
);

for (const outcome of ["accepted", "rejected", "unknown-start", "unsupported", "advanced"] as const)
  it(`sent message inline edit: ${outcome}`, { timeout: 45_000 }, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "ch-browser-edit-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const host = new FakeChChannel();
    host.inspection.capabilities.history.rollbackLastTurn = outcome !== "unsupported";
    const source = host.add("edit-source", "/computer/edit-project", "Edit sent verification");
    source.historyMode = "paginated";
    const first = source.turns[0];
    assert.ok(first);
    source.turns = Array.from({ length: 12 }, (_, index) => ({
      ...structuredClone(first),
      id: `native-${index}`,
      items: [
        {
          id: `u-${index}`,
          type: "userMessage",
          content: [{ type: "text", text: `Question ${index}` }],
        },
        { id: `a-${index}`, type: "agentMessage", text: `Answer ${index}` },
      ],
    }));
    const tailInput = source.turns.at(-1)?.items[0]?.content as Array<Record<string, unknown>>;
    tailInput.push({
      type: "image",
      url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    });
    const original = structuredClone(source);
    const requested = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    t.after(() => release.resolve(undefined));
    const request = host.request.bind(host);
    host.request = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
      if (method === "thread/revert") {
        requested.resolve(undefined);
        await release.promise;
        if (outcome === "rejected") {
          host.requests.push({ method, params });
          throw new Error("Synthetic Host refusal");
        }
        const result = await request<T>(method, params);
        host.changed(source.id, "thread/reverted");
        return result;
      }
      if (method === "turn/start" && outcome === "unknown-start") {
        host.requests.push({ method, params });
        throw new Error("Disconnected; rerun outcome unknown");
      }
      return request<T>(method, params);
    };
    const debug = await startFakeChDebugger(host);
    t.after(() => debug.close());
    const channel = await startFakeChChannel(host, directory);
    t.after(() => channel.close());
    const url = await startServer(
      t,
      resolve(import.meta.dirname, "../.."),
      ["--import", "tsx", "src/main.ts"],
      [
        "--session-source",
        "codexhost",
        "--ch-cdp",
        debug.endpoint,
        "--ch-control-directory",
        directory,
      ],
    );
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const observer = await browser.newPage();
    const errors: string[] = [];
    for (const p of [page, observer]) {
      p.on("pageerror", (error) => errors.push(error.message));
      await p.goto(url);
      const folder = p.getByRole("treeitem").filter({ hasText: /^edit-project$/ });
      await folder.waitFor();
      if ((await folder.getAttribute("aria-expanded")) === "false") await folder.click();
      await p.locator('[data-row-key="session:edit-source"]').click();
      await p.getByText("Answer 11", { exact: true }).waitFor();
    }
    const edit = page.getByRole("button", { name: "Edit message", exact: true });
    if (outcome === "unsupported") {
      await page.waitForTimeout(400);
      assert.equal(await edit.count(), 0);
      assert.deepEqual(source, original);
      return;
    }
    await edit.waitFor();
    assert.equal(await edit.count(), 1);
    const composer = page.locator('[contenteditable="true"]').last();
    await composer.fill("Unsent composer draft");
    await page.locator('input[type="file"]').setInputFiles({
      name: "draft-notes.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Preserve this draft attachment"),
    });
    const draftAttachments = page.getByRole("group", { name: "Pending attachments", exact: true });
    await draftAttachments.getByText("draft-notes.txt", { exact: true }).waitFor();
    await edit.click();
    const editor = page.getByRole("textbox", { name: "Edit message", exact: true });
    assert.equal(await editor.inputValue(), "Question 11");
    await editor.fill("Cancelled edit");
    await page
      .locator("[data-sent-message-editor]")
      .getByRole("button", { name: "Cancel", exact: true })
      .click();
    assert.equal(
      host.requests.some((r) => r.method === "thread/revert"),
      false,
    );
    assert.equal(await composer.innerText(), "Unsent composer draft");
    await edit.click();
    await editor.fill("Escape cancellation");
    await editor.press("Escape");
    assert.equal(await editor.count(), 0);
    await edit.click();
    assert.equal(await editor.inputValue(), "Question 11");
    await editor.fill("Edited final question");
    if (process.env.CODEXHOST_TEST_SCREENSHOTS) {
      mkdirSync(process.env.CODEXHOST_TEST_SCREENSHOTS, { recursive: true });
      await page.screenshot({
        path: join(process.env.CODEXHOST_TEST_SCREENSHOTS, `sent-edit-${outcome}-inline.png`),
      });
    }
    if (outcome === "advanced") {
      await request("turn/start", {
        threadId: source.id,
        input: [{ type: "text", text: "Message from another client" }],
      });
      host.changed(source.id, "turn/completed");
      await page.getByText("CH response: Message from another client", { exact: true }).waitFor();
      await page
        .getByRole("status")
        .filter({ hasText: /Conversation state changed/ })
        .waitFor();
      assert.equal(await editor.inputValue(), "Edited final question");
      assert.equal(
        await page
          .locator("[data-sent-message-editor]")
          .getByRole("button", { name: "Send", exact: true })
          .isDisabled(),
        true,
      );
      assert.equal(
        host.requests.some((r) => r.method === "thread/revert"),
        false,
      );
      assert.equal(await composer.innerText(), "Unsent composer draft");
      return;
    }
    const send = page
      .locator("[data-sent-message-editor]")
      .getByRole("button", { name: "Send", exact: true });
    if (outcome === "accepted") await editor.press("Enter");
    else await send.click();
    await requested.promise;
    assert.equal(await editor.isDisabled(), true);
    assert.equal(
      await page
        .locator("[data-sent-message-editor]")
        .getByRole("button", { name: "Cancel", exact: true })
        .isDisabled(),
      true,
    );
    assert.equal(
      host.requests.some((r) => r.method === "turn/start"),
      false,
    );
    release.resolve(undefined);
    if (outcome === "accepted") {
      await page.getByText("CH response: Edited final question", { exact: true }).waitFor();
      await observer.getByText("CH response: Edited final question", { exact: true }).waitFor();
      assert.equal(await page.getByText("Answer 11", { exact: true }).count(), 0);
      assert.equal(await observer.getByText("Answer 11", { exact: true }).count(), 0);
      assert.equal(await editor.count(), 0);
      assert.equal(source.turns.length, 12);
    } else {
      await page
        .getByRole("alert")
        .filter({
          hasText:
            outcome === "rejected" ? /Synthetic Host refusal/ : /Host confirmed the rollback/,
        })
        .waitFor();
      assert.equal(await editor.inputValue(), "Edited final question");
      assert.equal(await send.isDisabled(), true);
      if (outcome === "rejected") assert.deepEqual(source, original);
      else {
        assert.equal(source.turns.length, 11);
        await observer.getByText("Answer 10", { exact: true }).waitFor();
        await observer.getByText("Answer 11", { exact: true }).waitFor({ state: "hidden" });
      }
    }
    assert.equal(await composer.innerText(), "Unsent composer draft");
    if (outcome === "unknown-start") {
      assert.equal(await page.locator("[data-message-attachments] img").count(), 1);
    }
    await draftAttachments.getByText("draft-notes.txt", { exact: true }).waitFor();
    assert.equal(host.threads.size, 1);
    assert.deepEqual(
      host.requests.filter((r) => r.method === "thread/revert").map((r) => r.params),
      [{ threadId: source.id, beforeTurnId: "native-11" }],
    );
    assert.equal(
      host.requests.filter((r) => r.method === "turn/start").length,
      outcome === "rejected" ? 0 : 1,
    );
    assert.equal(
      host.requests.some((r) => r.method.includes("fork")),
      false,
    );
    if (process.env.CODEXHOST_TEST_SCREENSHOTS) {
      mkdirSync(process.env.CODEXHOST_TEST_SCREENSHOTS, { recursive: true });
      await page.screenshot({
        path: join(process.env.CODEXHOST_TEST_SCREENSHOTS, `sent-edit-${outcome}.png`),
      });
    }
    assert.deepEqual(errors, []);
  });
