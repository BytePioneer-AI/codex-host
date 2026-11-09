import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { chromium, expect } from "@playwright/test";
import { FakeChChannel, startFakeChChannel } from "../support/ch-channel.ts";
import { startFakeChDebugger } from "../support/ch-host.ts";
import { startServer } from "../support/server.ts";
import { defined } from "../support/defined.ts";

it(
  "keeps the Host final answer visible after streaming, late work and history reload",
  { timeout: 30_000 },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "ch-answer-phase-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const host = new FakeChChannel();
    const row = host.add("answer-phase", "/computer/phase", "Answer phases");
    row.turns = [
      {
        id: "turn",
        status: "inProgress",
        items: [
          { id: "user", type: "userMessage", content: [{ type: "text", text: "Update a file" }] },
          {
            id: "progress",
            type: "agentMessage",
            text: "Checking the file.",
            phase: "commentary",
            status: "completed",
          },
          {
            id: "answer",
            type: "agentMessage",
            text: "Visible reply",
            phase: null,
            status: "inProgress",
          },
        ],
      },
    ];
    row.status = { type: "active" };
    const debuggerServer = await startFakeChDebugger(host);
    t.after(() => debuggerServer.close());
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
        debuggerServer.endpoint,
        "--ch-control-directory",
        directory,
      ],
    );
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(url);
    await page.waitForLoadState("networkidle");
    const folder = page.getByRole("treeitem").filter({ hasText: /^phase$/u });
    await folder.waitFor();
    if ((await folder.getAttribute("aria-expanded")) === "false") await folder.click();
    await page.locator('[data-row-key^="session:"]').filter({ hasText: "Answer phases" }).click();
    await expect(page.getByText("Visible reply", { exact: true })).toBeVisible();

    const turn = defined(row.turns[0]);
    const answerItem = defined(turn.items.find((item) => item.id === "answer"));
    answerItem.text = "Visible reply completed.";
    host.changed(row.id);
    const answer = page.getByText("Visible reply completed.", { exact: true });
    await expect(answer).toBeVisible();
    answerItem.phase = "final_answer";
    answerItem.status = "completed";
    turn.items.push(
      { id: "analysis", type: "reasoning", summary: ["Private analysis."], content: [] },
      {
        id: "files",
        type: "fileChange",
        status: "completed",
        changes: [
          {
            path: "/computer/phase/example.md",
            kind: "update",
            diff: "--- a/example.md\n+++ b/example.md\n@@ -1 +1 @@\n-old\n+new\n",
          },
        ],
      },
      { id: "late-analysis", type: "reasoning", summary: ["Trailing analysis."], content: [] },
    );
    turn.status = "completed";
    row.status = { type: "idle" };
    host.changed(row.id, "turn/completed");
    const process = page.locator("button[data-turn-process]");
    await expect(process).toHaveAttribute("aria-expanded", "false");
    await expect(answer).toBeVisible();
    await expect(answer).toHaveCount(1);
    await expect(page.getByText("Checking the file.", { exact: true })).toBeHidden();
    await expect(page.getByText("Private analysis.", { exact: true })).toBeHidden();
    await expect(page.getByText("Trailing analysis.", { exact: true })).toBeHidden();
    await expect(page.locator("[data-turn-changes]")).toBeVisible();
    await process.click();
    await expect(page.getByText("Checking the file.", { exact: true })).toBeVisible();
    await process.click();
    await expect(answer).toBeVisible();

    const history = host.add("answer-history", row.cwd, "Historical answer");
    history.turns = structuredClone(row.turns);
    history.status = { type: "idle" };
    await page.reload();
    await expect(answer).toBeVisible();
    await page
      .locator('[data-row-key^="session:"]')
      .filter({ hasText: "Historical answer" })
      .click();
    await expect(process).toHaveAttribute("aria-expanded", "false");
    await expect(answer).toBeVisible();
    await expect(answer).toHaveCount(1);
  },
);
