/** Completed file summaries use compact rows while preserving inline diff inspection. */
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { chromium, expect } from "@playwright/test";
import { FakeChHost, startFakeChDebugger } from "../support/ch-host.ts";
import { startServer } from "../support/server.ts";

it(
  "shows three changed files, expands remaining files and diffs, and fits narrow screens",
  { timeout: 60_000 },
  async (t) => {
    const host = new FakeChHost();
    const row = host.add("file-summary", "/computer/project", "File summaries");
    const addedLines = Array.from({ length: 24 }, (_, index) => `added line ${index}`);
    row.turns = [1, 4].map((count) => ({
      id: `turn-${count}`,
      status: "completed",
      items: [
        {
          id: `user-${count}`,
          type: "userMessage",
          content: [{ type: "text", text: `Edit ${count} files` }],
        },
        {
          id: `changes-${count}`,
          type: "fileChange",
          status: "completed",
          changes: Array.from({ length: count }, (_, index) => ({
            path: `src/long-directory/components/file-${index}.ts`,
            kind: { type: "update", move_path: null },
            diff: `--- a/src/long-directory/components/file-${index}.ts\n+++ b/src/long-directory/components/file-${index}.ts\n@@ -1,1 +1,25 @@\n-old ${index}\n+new ${index}\n${addedLines.map((line) => `+${line}`).join("\n")}\n`,
          })),
        },
        {
          id: `answer-${count}`,
          type: "agentMessage",
          text: `Edited ${count} files successfully.`,
        },
      ],
    }));
    const debug = await startFakeChDebugger(host);
    t.after(() => debug.close());
    const url = await startServer(
      t,
      resolve(import.meta.dirname, "../.."),
      ["--import", "tsx", "src/main.ts"],
      ["--session-source", "codexhost", "--ch-cdp", debug.endpoint],
    );
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    const errors: string[] = [];
    const diffRequests: Array<{ turn: number; path?: string }> = [];
    const initialSummaries: unknown[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      if (request.url().endsWith("/api/codexhost/turnDiffs"))
        diffRequests.push(request.postDataJSON().payload.args.request);
    });
    page.on("websocket", (socket) =>
      socket.on("framereceived", ({ payload }) => {
        const frame = JSON.parse(String(payload));
        if (
          frame.value?.type === "snapshot" &&
          frame.value.projections?.values?.codexhostTurnChanges
        )
          initialSummaries.push(frame.value.projections.values.codexhostTurnChanges);
      }),
    );
    await page.goto(url);
    const folder = page.getByRole("treeitem").filter({ hasText: /^project$/u });
    await folder.waitFor();
    if ((await folder.getAttribute("aria-expanded")) === "false") await folder.click();
    await page.locator('[data-row-key^="session:"]').filter({ hasText: "File summaries" }).click();
    const single = page.locator("[data-turn-changes]").filter({ hasText: "Edited file-0.ts" });
    const multiple = page.locator("[data-turn-changes]").filter({ hasText: "Edited 4 files" });
    await expect(multiple).toBeVisible();
    await expect(single.locator("li")).toHaveCount(0);
    await expect(multiple.locator("[data-path-label]")).toHaveCount(3);
    await expect(multiple.getByRole("button", { name: "Show 1 more", exact: true })).toBeVisible();
    assert.equal(await multiple.getByRole("button", { name: /Undo|Reapply/u }).count(), 0);
    const screenshotDirectory = process.env.CODEXHOST_TEST_SCREENSHOTS;
    if (screenshotDirectory) {
      mkdirSync(screenshotDirectory, { recursive: true });
      await multiple.screenshot({ path: join(screenshotDirectory, "turn-changes-light.png") });
    }
    await multiple.getByRole("button", { name: "Show 1 more", exact: true }).click();
    await expect(multiple.locator("[data-path-label]")).toHaveCount(4);
    await multiple.getByRole("button", { name: "Collapse files", exact: true }).click();
    await expect(multiple.locator("[data-path-label]")).toHaveCount(3);
    const firstFile = multiple
      .getByRole("button")
      .filter({ has: page.locator('[data-path-label][title$="file-0.ts"]') });
    assert.equal(
      diffRequests.length,
      0,
      "opening a Session and listing files does not fetch diff bodies",
    );
    assert.ok(initialSummaries.length > 0);
    assert.equal(/oldText|newText/u.test(JSON.stringify(initialSummaries)), false);
    await firstFile.click();
    await expect(firstFile).toHaveAttribute("aria-expanded", "true");
    await expect(multiple.getByText("new 0", { exact: true })).toBeVisible();
    assert.equal(diffRequests.length, 1);
    assert.equal(diffRequests[0]?.path, "src/long-directory/components/file-0.ts");
    for (const line of addedLines) {
      await expect(multiple.getByText(line, { exact: true })).toBeVisible();
    }
    await expect(
      multiple.locator("[data-diff]").getByRole("button", { name: /hidden lines/u }),
    ).toHaveCount(0);
    await firstFile.click();
    await expect(multiple.getByText("new 0", { exact: true })).toHaveCount(0);
    await multiple.getByRole("button", { name: "View changes", exact: true }).click();
    await expect(multiple.getByText("new 3", { exact: true })).toBeVisible();
    assert.deepEqual(
      diffRequests.map((request) => request.path).sort(),
      Array.from({ length: 4 }, (_, index) => `src/long-directory/components/file-${index}.ts`),
      "expanding a whole Turn requests only its missing files by path",
    );
    await multiple.getByRole("button", { name: "Hide changes", exact: true }).click();
    await expect(multiple.getByText("new 3", { exact: true })).toHaveCount(0);
    await single.getByRole("button", { name: "View changes", exact: true }).click();
    await expect(single.getByText("new 0", { exact: true })).toBeVisible();
    await expect(single.getByText("added line 12", { exact: true })).toBeVisible();
    await single.getByRole("button", { name: "Hide changes", exact: true }).click();
    await expect(single.locator("li")).toHaveCount(0);
    await page.evaluate(() => document.body.setAttribute("data-ds-dark-theme", ""));
    if (screenshotDirectory)
      await multiple.screenshot({ path: join(screenshotDirectory, "turn-changes-dark.png") });
    await page.evaluate(() => document.body.removeAttribute("data-ds-dark-theme"));
    await page.setViewportSize({ width: 320, height: 844 });
    await multiple.scrollIntoViewIfNeeded();
    for (const control of [
      multiple,
      multiple.getByRole("button", { name: "View changes", exact: true }),
    ]) {
      const box = await control.boundingBox();
      assert.ok(box && box.x >= 0 && box.x + box.width <= 320);
    }
    if (screenshotDirectory)
      await multiple.screenshot({ path: join(screenshotDirectory, "turn-changes-narrow.png") });
    assert.deepEqual(errors, []);
  },
);
