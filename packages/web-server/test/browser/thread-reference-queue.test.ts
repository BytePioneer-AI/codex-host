/** Queue UI regression against an isolated owner fixture, not live Harness acceptance. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { it } from "node:test";
import { chromium } from "playwright";
import type { ClientThreadSnapshot } from "@codexhost/shared-contracts";
import { FakeChChannel, startFakeChChannel } from "../support/ch-channel.ts";
import { startFakeChDebugger } from "../support/ch-host.ts";
import { startServer } from "../support/server.ts";

it(
  "queue editing appends reference text while preserving an existing chip draft",
  { timeout: 40_000 },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "thread-reference-queue-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const host = new FakeChChannel();
    host.add("destination", "/computer/queue-project", "Destination").status = { type: "active" };
    host.add("reference-a", "/computer/queue-project", "Target title");
    const queuedText =
      "Read [@Target title](thread://reference-a?hostId=local) and thread://other?hostId=remote-explicit";
    let queue: ClientThreadSnapshot["queue"] = {
      pausedReason: null,
      items: [
        {
          id: "original",
          clientUserMessageId: "original-request",
          input: [{ type: "text", text: queuedText }],
          presentationInput: null,
        },
      ],
    };
    const snapshot = host.snapshot.bind(host);
    host.snapshot = async (id) => ({
      ...(await snapshot(id)),
      queue: id === "destination" ? structuredClone(queue) : { pausedReason: null, items: [] },
    });
    const request = host.request.bind(host);
    host.request = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
      if (method === "thread/queue/delete") {
        host.requests.push({ method, params });
        assert.equal(params.queuedSubmissionId, "original");
        queue = { pausedReason: null, items: [] };
        host.changed("destination", "codexhost/thread/queue/updated");
        return { deleted: true } as T;
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
    const page = await browser.newPage();
    await page.goto(url);
    const folder = page
      .locator('[data-row-key^="workspace:"]')
      .filter({ hasText: /^queue-project$/u });
    if ((await folder.getAttribute("aria-expanded")) === "false") await folder.click();
    await page.locator('[data-row-key="session:destination"]').click();
    const editor = page.locator("[data-composer-input]");
    const queuedChip = page.locator('[data-queue-dock] [data-ref-chip="session"]');
    await queuedChip.waitFor();
    assert.equal(await queuedChip.innerText(), "Target title");
    assert.equal(
      await queuedChip.getAttribute("title"),
      "[@Target title](thread://reference-a?hostId=local)",
    );
    assert.ok(
      (await page.locator("[data-queue-dock]").innerText()).includes(
        "thread://other?hostId=remote-explicit",
      ),
    );
    await editor.fill("Draft kept ");
    await page.locator('[data-row-key="session:reference-a"]').dragTo(editor);
    const chip = editor.locator('[data-composer-chip="codexhost-thread"]');
    await chip.waitFor();
    await page.getByRole("button", { name: "Edit queued message", exact: true }).click();
    await page.waitForFunction(
      (text) => document.querySelector("[data-composer-input]")?.textContent?.includes(text),
      queuedText,
    );
    assert.equal(await chip.count(), 1, "existing reference remains decorated");
    assert.ok((await editor.innerText()).includes("Draft kept"));
    assert.ok((await editor.innerText()).includes(queuedText));
    assert.equal(host.requests.filter((request) => request.method === "turn/start").length, 0);
    const response = page.waitForResponse((response) =>
      response.url().endsWith("/api/session/prompt"),
    );
    await page.getByRole("button", { name: "Queue message", exact: true }).click();
    await response;
    const sent = host.requests.find((request) => request.method === "turn/start");
    assert.ok(sent);
    const text = (sent.params.input as Array<{ text: string }>)[0]?.text;
    assert.ok(text);
    assert.ok(text.includes("Draft kept [@Target title](thread://reference-a?hostId=local)"));
    assert.ok(text.includes(queuedText));
    assert.equal(host.threads.get("reference-a")?.turns.length, 1);
  },
);
