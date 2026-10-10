import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { it } from "node:test";
import { chromium } from "playwright";
import { FakeChHost, startFakeChDebugger } from "../support/ch-host.ts";
import { startServer } from "../support/server.ts";

it(
  "switches promptly after polling a 1600-Thread catalog without requiring a reload",
  { timeout: 65_000 },
  async (t) => {
    const host = new FakeChHost();
    for (let i = 0; i < 1600; i++) host.add(`bulk-${i}`, "/generated", `Old Thread ${i}`, false);
    for (const id of ["first", "second"]) {
      const row = host.add(id, "/computer/project", `${id} conversation`);
      row.updatedAt = 3000;
      const answer = row.turns[0]?.items.find((item) => item.type === "agentMessage");
      assert.ok(answer);
      answer.text = `${id} historical answer`;
    }
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
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    let catalogUpdates = 0;
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("websocket", (socket) =>
      socket.on("framereceived", ({ payload }) => {
        const frame = JSON.parse(String(payload)) as {
          value?: { event?: string; args?: Array<{ sessionId?: string }> };
        };
        const id = frame.value?.args?.[0]?.sessionId;
        if (frame.value?.event === "api-session/added" && id && !id.startsWith("draft-"))
          catalogUpdates++;
      }),
    );
    await page.goto(url);
    // Let startup settings/catalog hydration finish before toggling a folder;
    // this test measures steady-state switching, not the initial sidebar restore.
    await page.waitForLoadState("networkidle");
    const folder = page.getByRole("treeitem").filter({ hasText: /^project$/ });
    await folder.waitFor();
    if ((await folder.getAttribute("aria-expanded")) === "false") await folder.click();
    await page.getByRole("treeitem").filter({ hasText: "first conversation" }).click();
    await page.getByText("first historical answer", { exact: true }).waitFor();
    // Two real polling ticks: the regression is an event storm during ordinary
    // operation, not the initial list response or a mocked click handler.
    await page.waitForTimeout(21_000);
    assert.equal(catalogUpdates, 0, "unchanged native Threads must not be rebroadcast");
    for (const id of ["second", "first", "second"]) {
      const start = performance.now();
      await page
        .getByRole("treeitem")
        .filter({ hasText: `${id} conversation` })
        .click({ timeout: 3000 });
      await page.getByText(`${id} historical answer`, { exact: true }).waitFor({ timeout: 3000 });
      assert.ok(performance.now() - start < 3000, "switch should not require reloading the page");
    }
    assert.deepEqual(errors, []);
    if (process.env.CODEXHOST_TEST_SCREENSHOTS) {
      mkdirSync(process.env.CODEXHOST_TEST_SCREENSHOTS, { recursive: true });
      await page.screenshot({
        path: join(process.env.CODEXHOST_TEST_SCREENSHOTS, "catalog-switching-after-two-polls.png"),
      });
    }
  },
);
