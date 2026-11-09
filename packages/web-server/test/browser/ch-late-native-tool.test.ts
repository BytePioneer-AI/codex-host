import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { chromium, expect } from "@playwright/test";
import { FakeChChannel, startFakeChChannel } from "../support/ch-channel.ts";
import { startFakeChDebugger } from "../support/ch-host.ts";
import { startServer } from "../support/server.ts";
import type { ChItem } from "../../src/ch-thread-view.ts";

for (const terminalStatus of ["completed", "interrupted"])
  it(
    `rebuilds a late native command before its following steer, including after ${terminalStatus} and reload`,
    { timeout: 30_000 },
    async (t) => {
      const directory = mkdtempSync(join(tmpdir(), "ch-late-command-"));
      t.after(() => rmSync(directory, { recursive: true, force: true }));
      const host = new FakeChChannel();
      const row = host.add("late-command", "/computer/project", "Late command");
      const items: ChItem[] = [
        {
          id: "opening",
          type: "userMessage",
          clientId: "first",
          content: [{ type: "text", text: "Opening task" }],
        },
        {
          id: "steer",
          type: "userMessage",
          clientId: "second",
          content: [{ type: "text", text: "Following steer" }],
        },
      ];
      const turn = { id: "turn", status: "inProgress", items };
      row.turns = [turn];
      row.status = { type: "active" };
      const debug = await startFakeChDebugger(host);
      t.after(() => debug.close());
      const channel = await startFakeChChannel(host, directory);
      t.after(() => channel.close());
      const url = await startServer(
        t,
        resolve(import.meta.dirname, "../.."),
        ["--import", "tsx", "src/main.ts"],
        ["--ch-cdp", debug.endpoint, "--ch-control-directory", directory],
      );
      const browser = await chromium.launch();
      t.after(() => browser.close());
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(`${url}?session=${row.id}`);
      await expect(page.getByText("Following steer", { exact: true })).toBeVisible();

      const tool: ChItem = {
        id: "tool",
        type: "commandExecution",
        command: "printf ready",
        aggregatedOutput: "ready",
        status: "inProgress",
      };
      items.splice(1, 0, tool);
      host.changed(row.id, "item/started");
      await expect(page.getByText("Ran commands", { exact: true })).toBeVisible();
      const checkOrder = async (label: string) => {
        const body = await page.locator("body").innerText();
        assert.ok(body.indexOf(label) > body.indexOf("Opening task"));
        assert.ok(body.indexOf(label) < body.indexOf("Following steer"));
        assert.equal(await page.getByText("Following steer", { exact: true }).count(), 1);
      };
      await checkOrder("Ran commands");
      await page.getByRole("button", { name: "Ran commands", exact: true }).click();
      await expect(page.locator('[data-sample="bash"][data-state="running"]')).toBeVisible();
      turn.status = terminalStatus;
      row.status = { type: "idle" };
      host.changed(row.id, "turn/completed");
      await expect(page.locator("[data-chat-running]")).toHaveCount(0);
      // A native background command may finish after the assistant Turn has already ended.
      tool.status = "completed";
      tool.aggregatedOutput = "ready\nfinished";
      tool.exitCode = 0;
      host.changed(row.id, "item/completed");
      await expect(page.getByText("Ran commands", { exact: true })).toBeVisible();
      await checkOrder("Ran commands");
      await page.reload();
      await expect(page.getByText("Ran commands", { exact: true })).toBeVisible();
      await checkOrder("Ran commands");
      assert.equal(await page.locator('[data-submission-echo="true"]').count(), 0);
      assert.deepEqual(errors, []);
    },
  );
