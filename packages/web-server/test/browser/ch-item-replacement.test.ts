import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { chromium } from "playwright";
import { FakeChChannel, startFakeChChannel } from "../support/ch-channel.ts";
import { startFakeChDebugger } from "../support/ch-host.ts";
import { startServer } from "../support/server.ts";

it(
  "reopens native Item replacements without duplicating live answers or tools",
  { timeout: 30_000 },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "ch-item-replacement-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const host = new FakeChChannel();
    const row = host.add("replacement-thread", "/computer/replacement", "Item replacement");
    const turn = {
      id: "replacement-turn",
      status: "inProgress",
      items: [
        { id: "user", type: "userMessage", content: [{ type: "text", text: "Run it" }] },
        {
          id: "live-tool",
          type: "commandExecution",
          command: "echo ready",
          status: "completed",
          aggregatedOutput: "ready",
        },
        { id: "live-answer", type: "agentMessage", text: "The final answer" },
      ],
    };
    row.turns = [turn];
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
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(url);
    await page.waitForLoadState("networkidle");
    const folder = page.getByRole("treeitem").filter({ hasText: /^replacement$/u });
    await folder.waitFor();
    if ((await folder.getAttribute("aria-expanded")) === "false") await folder.click();
    await page.getByRole("treeitem").filter({ hasText: "Item replacement" }).click();
    const answer = page.getByText("The final answer", { exact: true });
    await answer.waitFor();

    turn.items = turn.items.map((item) => ({ ...item, id: item.id.replace("live-", "native-") }));
    turn.status = "completed";
    row.status = { type: "idle" };
    host.changed(row.id, "turn/completed");

    const process = page.getByRole("button", { name: /Completed in/u });
    await process.waitFor({ timeout: 5000 });
    await process.click();
    assert.equal(await answer.count(), 1);
    assert.equal(await answer.isVisible(), true);
    assert.equal(await page.getByText("Ran commands", { exact: true }).count(), 1);
    assert.deepEqual(errors, []);
  },
);
