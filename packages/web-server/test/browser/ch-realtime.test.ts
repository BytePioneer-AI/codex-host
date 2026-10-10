import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { chromium } from "playwright";
import { FakeChChannel, startFakeChChannel } from "../support/ch-channel.ts";
import { startFakeChDebugger } from "../support/ch-host.ts";
import { startServer } from "../support/server.ts";
import { defined } from "../support/defined.ts";

it(
  "two browsers share event-driven messages, approvals, configuration and Host restart recovery",
  { timeout: 60_000 },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "ch-browser-events-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const host = new FakeChChannel(),
      row = host.add("gui-live", "/computer/shared", "Shared GUI Thread");
    const debuggerServer = await startFakeChDebugger(host);
    t.after(() => debuggerServer.close());
    let channel = await startFakeChChannel(host, directory);
    t.after(() => channel.close());
    const url = await startServer(
      t,
      resolve(import.meta.dirname, "../.."),
      ["--import", "tsx", "src/main.ts"],
      [
        "--session-source",
        "codexhost",
        "--ch-cdp",
        debuggerServer.endpoint,
        "--ch-control-directory",
        directory,
      ],
    );
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const a = await browser.newPage({ viewport: { width: 1280, height: 900 } }),
      b = await browser.newPage({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      });
    const errors: string[] = [];
    for (const page of [a, b]) page.on("pageerror", (error) => errors.push(error.message));
    try {
      for (const page of [a, b]) {
        await page.goto(url);
        await page.waitForLoadState("networkidle");
        const sidebar = page.getByRole("button", { name: "Open sidebar", exact: true });
        if (await sidebar.first().isVisible()) await sidebar.first().click();
        const folder = page.getByRole("treeitem").filter({ hasText: /^shared$/u });
        await folder.waitFor();
        if ((await folder.getAttribute("aria-expanded")) === "false") await folder.click();
        await page.getByRole("treeitem").filter({ hasText: "Shared GUI Thread" }).click();
        await page.getByText("existing CH answer", { exact: true }).waitFor();
        await page.locator('[data-native-connection="connected"]').waitFor();
      }
      row.turns.push({
        id: "gui-turn",
        status: "inProgress",
        items: [
          {
            id: "gui-user",
            type: "userMessage",
            content: [{ type: "text", text: "Message accepted in GUI" }],
          },
          { id: "gui-agent", type: "agentMessage", text: "GUI stream: one" },
        ],
      });
      row.status = { type: "active" };
      host.changed(row.id, "turn/started");
      for (const page of [a, b])
        await page.getByText("GUI stream: one", { exact: true }).waitFor({ timeout: 3000 });
      const live = defined(row.turns.at(-1));
      defined(live.items[1]).text = "GUI stream: one two";
      host.changed(row.id);
      for (const page of [a, b]) {
        await page.getByText("GUI stream: one two", { exact: true }).waitFor({ timeout: 3000 });
        assert.equal(await page.getByText("GUI stream: one two", { exact: true }).count(), 1);
      }
      live.status = "completed";
      row.status = { type: "idle" };
      host.changed(row.id, "turn/completed");
      for (const [page, text] of [
        [a, "message from A"],
        [b, "message from B"],
      ] as const) {
        await page
          .getByRole("textbox", {
            name: "Message or run a task, / commands, @ files or sessions",
            exact: true,
          })
          .fill(text);
        await page.getByRole("button", { name: "Send message", exact: true }).click();
        for (const viewer of [a, b])
          await viewer
            .getByText(`CH response: ${text}`, { exact: true })
            .waitFor({ timeout: 3000 });
      }
      host.modes.set(row.id, "auto");
      host.changed(row.id, "codexhost/thread/configuration/updated");
      for (const page of [a, b])
        await page
          .getByRole("button", { name: "Access mode, current: Native Auto", exact: true })
          .waitFor({ timeout: 3000 });
      host.pending = [
        {
          requestId: -17,
          threadId: row.id,
          kind: "approval",
          interaction: {
            type: "approval",
            title: "Approve native test action",
            actions: [
              { id: "once", label: "Allow once", effect: "allowOnce" },
              { id: "no", label: "Deny", effect: "deny" },
            ],
          },
          request: {
            method: "mcpServer/elicitation/request",
            params: { requestedSchema: { type: "object", properties: {} } },
          },
        },
      ];
      host.changed(row.id, "mcpServer/elicitation/request");
      for (const page of [a, b])
        await page
          .getByRole("radio", { name: "Allow once", exact: true })
          .waitFor({ timeout: 3000 });
      if (process.env.CODEXHOST_TEST_SCREENSHOTS) {
        mkdirSync(process.env.CODEXHOST_TEST_SCREENSHOTS, { recursive: true });
        await b.screenshot({
          path: join(process.env.CODEXHOST_TEST_SCREENSHOTS, "realtime-mobile-approval.png"),
        });
      }
      await a.getByRole("radio", { name: "Allow once", exact: true }).click();
      await a.getByRole("radio", { name: "Allow once", exact: true }).press("Enter");
      for (const page of [a, b])
        await page
          .getByRole("radio", { name: "Allow once", exact: true })
          .waitFor({ state: "hidden", timeout: 3000 });
      assert.equal(host.answers.length, 1);
      assert.deepEqual(host.answers[0]?.result, { action: "accept", content: {} });
      await channel.close();
      for (const page of [a, b]) {
        await page.locator('[data-native-connection="reconnecting"]').waitFor({ timeout: 3000 });
        await page.getByText("CH response: message from B", { exact: true }).waitFor();
      }
      host.epoch = randomUUID();
      host.sequence = 0;
      // The restored native history can have different Turn/Item IDs. A new Host
      // epoch replaces the Web generation rather than appending duplicate text.
      for (const turn of row.turns) {
        turn.id = `restored-${turn.id}`;
        for (const item of turn.items) item.id = `restored-${item.id}`;
      }
      row.turns.push({
        id: "offline-turn",
        status: "completed",
        items: [
          {
            id: "offline-user",
            type: "userMessage",
            content: [{ type: "text", text: "While disconnected" }],
          },
          { id: "offline-agent", type: "agentMessage", text: "Recovered authoritative answer" },
        ],
      });
      channel = await startFakeChChannel(host, directory);
      for (const page of [a, b]) {
        await page.locator('[data-native-connection="connected"]').waitFor({ timeout: 5000 });
        await page
          .getByText("Recovered authoritative answer", { exact: true })
          .waitFor({ timeout: 3000 });
      }
      for (const page of [a, b])
        assert.equal(
          await page.getByText("CH response: message from A", { exact: true }).count(),
          1,
        );
      assert.equal(
        host.requests.filter((request) => request.method === "turn/start").length,
        2,
        "Reconnection must not resend commands",
      );
      assert.equal(
        host.requests.some((request) => request.method === "thread/resume"),
        false,
      );
      assert.deepEqual(errors, []);
    } catch (error) {
      if (process.env.CODEXHOST_TEST_SCREENSHOTS) {
        mkdirSync(process.env.CODEXHOST_TEST_SCREENSHOTS, { recursive: true });
        await a.screenshot({
          path: join(process.env.CODEXHOST_TEST_SCREENSHOTS, "realtime-failure.png"),
        });
      }
      console.error("desktop", (await a.locator("body").innerText()).slice(-6000));
      console.error("mobile", (await b.locator("body").innerText()).slice(-6000));
      console.error("page errors", errors);
      throw error;
    }
  },
);
