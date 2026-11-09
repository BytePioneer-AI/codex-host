import assert from "node:assert/strict";
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
  "updates files and command output only in following pages, including equal-seq snapshots after switching back",
  { timeout: 60_000 },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "ch-browser-scoped-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const host = new FakeChChannel();
    host.add("a", "/computer/project", "Session A");
    const row = host.add("b", "/computer/project", "Session B");
    const file = (path: string) => ({
      path,
      kind: { type: "update", move_path: null },
      diff: `--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`,
    });
    const changes = {
      id: "files",
      type: "fileChange",
      status: "completed",
      changes: [file("a.ts")],
    };
    const command = {
      id: "command",
      type: "commandExecution",
      status: "inProgress",
      command: "echo progress",
      aggregatedOutput: "first output",
    };
    row.status = { type: "active" };
    row.turns = [
      {
        id: "live",
        status: "inProgress",
        codexhostFileOperations: [],
        items: [
          { id: "user", type: "userMessage", content: [{ type: "text", text: "edit files" }] },
          changes,
          command,
        ],
      },
    ];
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
    const pages = await Promise.all([browser.newPage(), browser.newPage()]);
    const errors: string[] = [];
    const traffic = pages.map(() => ({
      control: [] as string[],
      catalog: [] as string[],
      follow: [] as string[],
      streams: new Map<string, { endpoint: string; sessionId?: string; cancelled?: boolean }>(),
    }));
    for (const [index, page] of pages.entries()) {
      const seen = defined(traffic[index]);
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("websocket", (socket) => {
        socket.on("framesent", ({ payload }) => {
          const frame = JSON.parse(String(payload));
          if (frame.type === "open")
            seen.streams.set(frame.streamId, {
              endpoint: frame.endpoint,
              sessionId: frame.payload?.args?.request?.address?.sessionId,
            });
          if (frame.type === "cancel") defined(seen.streams.get(frame.streamId)).cancelled = true;
        });
        socket.on("framereceived", ({ payload }) => {
          const frame = JSON.parse(String(payload));
          const stream = seen.streams.get(frame.streamId);
          if (frame.value?.event === "api-session/added") seen.catalog.push(String(payload));
          if (stream?.endpoint === "session/control") seen.control.push(String(payload));
          if (stream?.endpoint === "session/follow") seen.follow.push(String(payload));
        });
      });
      await page.goto(url);
      await page.waitForLoadState("networkidle");
      const folder = page.getByRole("treeitem").filter({ hasText: /^project$/u });
      await folder.waitFor();
      if ((await folder.getAttribute("aria-expanded")) === "false") await folder.click();
      await page.locator('[data-row-key="session:b"]').click();
      await expect(page.getByRole("status").filter({ hasText: "1 files changed" })).toBeVisible();
      await page.locator('[data-sample="bash"]').click();
      await expect(page.getByText("first output", { exact: true })).toBeVisible();
    }
    changes.changes.push(file("b.ts"));
    command.aggregatedOutput = "second output";
    host.changed(row.id);
    for (const page of pages) {
      await expect(page.getByRole("status").filter({ hasText: "2 files changed" })).toBeVisible();
      await expect(page.getByText("second output", { exact: true })).toBeVisible();
    }
    const a = defined(pages[0]);
    const b = defined(pages[1]);
    const firstTraffic = defined(traffic[0]);
    await a.locator('[data-row-key="session:a"]').click();
    await expect(a.getByText("existing CH answer", { exact: true })).toBeVisible();
    await expect
      .poll(() =>
        [...firstTraffic.streams.values()].some(
          (stream) => stream.sessionId === row.id && !stream.cancelled,
        ),
      )
      .toBe(false);
    const receivedBefore = firstTraffic.follow.length;
    changes.changes.push(file("c.ts"));
    command.aggregatedOutput = "latest output";
    row.name = "Renamed B";
    host.changed(row.id, "thread/name/updated");
    await expect(b.getByRole("status").filter({ hasText: "3 files changed" })).toBeVisible();
    await expect(b.getByText("latest output", { exact: true })).toBeVisible();
    for (const page of pages)
      await expect(page.locator('[data-row-key="session:b"]')).toContainText("Renamed B");
    assert.equal(firstTraffic.follow.length, receivedBefore, "A has no background B follow deltas");
    await a.locator('[data-row-key="session:b"]').click();
    await expect(a.getByRole("status").filter({ hasText: "3 files changed" })).toBeVisible();
    const bash = a.locator('[data-sample="bash"]');
    if ((await bash.getAttribute("aria-expanded")) !== "true") await bash.click();
    await expect(a.getByText("latest output", { exact: true })).toBeVisible();
    for (const seen of traffic) {
      assert.ok(seen.control.length > 0);
      assert.ok(
        seen.follow.some(
          (frame) =>
            frame.includes('"type":"projection"') && frame.includes("codexhostTurnChanges"),
        ),
      );
      assert.ok(
        seen.follow.some(
          (frame) => frame.includes('"type":"projection"') && frame.includes("codexhostToolOutput"),
        ),
      );
      assert.equal(
        seen.control.some((frame) => /codexhostTurnChanges|codexhostToolOutput/u.test(frame)),
        false,
      );
      assert.ok(
        seen.control.some(
          (frame) => frame.includes('"key":"title"') && frame.includes("Renamed B"),
        ),
      );
    }
    // Running and settled sidebar state remains shared with the page viewing A.
    await a.locator('[data-row-key="session:a"]').click();
    await expect(
      a.locator('[data-row-key="session:b"] [data-session-status="ongoing"]'),
    ).toBeVisible();
    command.status = "completed";
    defined(row.turns[0]).status = "completed";
    row.status = { type: "idle" };
    host.changed(row.id, "turn/completed");
    await expect(
      a.locator('[data-row-key="session:b"] [data-session-status="ongoing"]'),
    ).toHaveCount(0);
    for (const seen of traffic) {
      assert.ok(seen.catalog.length > 0, "catalog changes still reach every page");
      assert.equal(
        [...seen.control, ...seen.catalog].some((frame) =>
          /codexhostTurnChanges|codexhostToolOutput/u.test(frame),
        ),
        false,
      );
    }
    assert.deepEqual(errors, []);
  },
);
