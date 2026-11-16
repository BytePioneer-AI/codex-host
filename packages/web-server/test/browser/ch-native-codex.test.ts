/** Browser contract test: the fixture represents one native backend shared with Desktop. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { chromium } from "playwright";
import { FakeChChannel, startFakeChChannel } from "../support/ch-channel.ts";
import { nativeCodex } from "../support/native-codex.ts";
import { startFakeChDebugger } from "../support/ch-host.ts";
import { startServer } from "../support/server.ts";

it(
  "native Codex appears without import and shares live history with desktop and mobile browsers",
  { timeout: 60_000 },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "web-native-browser-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const host = nativeCodex(new FakeChChannel());
    const row = host.add("native-original", "/computer/shared", "Original native Codex chat");
    row.modelProvider = "openai";
    const channel = await startFakeChChannel(host, directory);
    t.after(() => channel.close());
    const debuggerServer = await startFakeChDebugger(host);
    t.after(() => debuggerServer.close());
    const url = await startServer(
      t,
      resolve(import.meta.dirname, "../.."),
      ["--import", "tsx", "src/main.ts"],
      [
        "--session-source",
        "codexhost",
        "--ch-control-directory",
        directory,
        "--ch-cdp",
        debuggerServer.endpoint,
      ],
    );
    const browser = await chromium.launch({
      ...(process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH
        ? { executablePath: process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH }
        : {}),
    });
    t.after(() => browser.close());
    const pages = [
      await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: "en-US" }),
      await browser.newPage({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        locale: "en-US",
      }),
    ];
    const errors: string[] = [];
    for (const page of pages) {
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(url);
      await page.waitForLoadState("networkidle");
      const sidebar = page.getByRole("button", { name: "Open sidebar", exact: true });
      if (await sidebar.first().isVisible()) await sidebar.first().click();
      const folder = page.getByRole("treeitem").filter({ hasText: /^shared$/u });
      await folder.waitFor({ timeout: 5000 }).catch(async (error: unknown) => {
        throw new Error(
          `${String(error)}\n${await page.locator("body").innerText()}\n${errors.join("\n")}`,
        );
      });
      if ((await folder.getAttribute("aria-expanded")) === "false") await folder.click();
      await page.locator('[data-row-key="session:native-original"]').click();
      await page.getByText("existing CH answer", { exact: true }).waitFor();
      assert.equal(await page.locator("[data-codexhost-import-source]").count(), 0);
    }
    row.turns.push({
      id: "desktop-turn",
      status: "inProgress",
      items: [
        {
          id: "desktop-user",
          type: "userMessage",
          content: [{ type: "text", text: "Sent in Desktop" }],
        },
        { id: "desktop-answer", type: "agentMessage", text: "Desktop streamed answer" },
      ],
    });
    row.status = { type: "active" };
    host.changed(row.id, "turn/started");
    for (const page of pages)
      await page.getByText("Desktop streamed answer", { exact: true }).waitFor({ timeout: 3000 });
    const desktopTurn = row.turns.at(-1);
    assert.ok(desktopTurn);
    desktopTurn.status = "completed";
    row.status = { type: "idle" };
    host.changed(row.id, "turn/completed");
    for (const [index, page] of pages.entries()) {
      await page
        .getByRole("textbox", {
          name: "Message or run a task, / commands, @ files or sessions",
          exact: true,
        })
        .fill(`Native follow-up ${index}`);
      await page.getByRole("button", { name: "Send message", exact: true }).click();
      for (const observer of pages) {
        await observer
          .getByText(`CH response: Native follow-up ${index}`, { exact: true })
          .waitFor({ timeout: 5000 });
        assert.equal(
          await observer
            .getByText(`CH response: Native follow-up ${index}`, { exact: true })
            .count(),
          1,
        );
      }
    }
    assert.equal(host.requests.filter((r) => r.method === "turn/start").length, 2);
    assert.ok(
      host.requests
        .filter((r) => r.method === "turn/start")
        .every((r) => r.params.threadId === row.id),
    );
    assert.equal(
      host.requests.some(
        (r) => r.method === "thread/start" || r.method.includes("session-import/import"),
      ),
      false,
    );
    const draftPage = await browser.newPage({
      viewport: { width: 1280, height: 900 },
      locale: "en-US",
    });
    draftPage.on("pageerror", (error) => errors.push(error.message));
    await draftPage.goto(url);
    await draftPage
      .getByRole("button", { name: "Select Harness, current Codex", exact: true })
      .click();
    assert.equal(await draftPage.getByRole("menuitem", { name: "Codex", exact: true }).count(), 1);
    assert.equal(
      await draftPage.getByRole("menuitem", { name: "Codex CLI", exact: true }).count(),
      0,
    );
    await draftPage.keyboard.press("Escape");
    const permission = draftPage.getByRole("button", {
      name: "Access mode, current: Follow Codex settings",
      exact: true,
    });
    await permission.waitFor();
    assert.equal(
      await permission.getAttribute("title"),
      "No permission profile is selected; Codex applies its current configuration.",
    );
    await permission.click();
    await draftPage.getByRole("menuitem", { name: "Workspace write", exact: true }).waitFor();
    await draftPage.keyboard.press("Escape");
    await draftPage.locator('[contenteditable="true"]').fill("New official Codex chat");
    await draftPage.getByRole("button", { name: "Send message", exact: true }).click();
    await draftPage.getByText("CH response: New official Codex chat", { exact: true }).waitFor();
    const start = host.requests.find((entry) => entry.method === "thread/start");
    assert.deepEqual(start?.params.model, { id: "gpt-5.4" });
    assert.equal(start?.params.permissions, undefined);
    assert.equal(start?.params.cwd, undefined);
    assert.deepEqual(start?.params.projectlessWorkspace, { prompt: "New official Codex chat" });
    const created = [...host.threads.values()].at(-1);
    assert.ok(created);
    assert.ok(created.id.startsWith("native-created-"));
    assert.equal(
      host.requests.filter((entry) => entry.method === "turn/start").at(-1)?.params.threadId,
      created.id,
    );
    assert.deepEqual(errors, []);
  },
);
