import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";
import type { ClientThreadSnapshot } from "@codexhost/shared-contracts";
import { chromium } from "playwright";
import { FakeChChannel, startFakeChChannel } from "../support/ch-channel.ts";
import { startFakeChDebugger } from "../support/ch-host.ts";
import { startServer } from "../support/server.ts";

for (const scenario of ["delete", "reconnect", "auto-send"] as const)
  it(
    `removes queued messages from the open Thread (${scenario})`,
    { timeout: 30_000 },
    async (t) => {
      const reconnect = scenario === "reconnect";
      const directory = mkdtempSync(join(tmpdir(), "ch-browser-queue-"));
      t.after(() => rmSync(directory, { recursive: true, force: true }));
      const host = new FakeChChannel();
      const row = host.add("queue-thread", "/computer/queue-project", "Queue synchronization");
      row.status = { type: "active" };
      let queue: ClientThreadSnapshot["queue"] = { items: [], pausedReason: null };
      const snapshot = host.snapshot.bind(host);
      host.snapshot = async (id) => ({ ...(await snapshot(id)), queue: structuredClone(queue) });
      const request = host.request.bind(host);
      host.request = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
        if (scenario === "auto-send" && method === "turn/start") {
          assert.equal(params.delivery, "queue");
          queue = {
            pausedReason: null,
            items: [
              {
                id: "queued-id",
                clientUserMessageId: String(params.clientUserMessageId),
                input: params.input as NonNullable<
                  ClientThreadSnapshot["queue"]
                >["items"][number]["input"],
                presentationInput: null,
              },
            ],
          };
          host.changed(row.id, "codexhost/thread/queue/updated");
          return { queued: true, queuedSubmission: queue.items[0] } as T;
        }
        return request<T>(method, params);
      };
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
      page.on("console", (message) => {
        if (message.type() === "error" && message.text().includes("control stream failed"))
          errors.push(message.text());
      });
      await page.goto(url);
      const folder = page.getByRole("treeitem").filter({ hasText: /^queue-project$/u });
      await folder.waitFor();
      if ((await folder.getAttribute("aria-expanded")) === "false") await folder.click();
      await page.getByRole("treeitem").filter({ hasText: "Queue synchronization" }).click();
      await page.getByText("existing CH answer", { exact: true }).waitFor();
      // Keep an unsent draft on the server: control-stream reconnects must
      // prepare its metadata without allowing live updates before the baseline.
      await page
        .getByRole("button", { name: "New session", exact: true })
        .filter({ hasText: "New Session" })
        .click();
      await page.getByRole("treeitem").filter({ hasText: "Queue synchronization" }).click();
      await page.getByText("existing CH answer", { exact: true }).waitFor();
      const prompt = page
        .locator("[data-queue-dock]")
        .getByText("Queued from GUI", { exact: true });
      queue = {
        pausedReason: null,
        items: [
          {
            id: "queued-id",
            clientUserMessageId: "gui-message",
            input: [{ type: "text", text: "Queued from GUI" }],
            presentationInput: null,
          },
        ],
      };
      if (scenario === "auto-send") {
        queue = { items: [], pausedReason: null };
        await page.locator('[contenteditable="true"]').fill("Queued from GUI");
        await page.getByRole("button", { name: "Queue message", exact: true }).click();
      } else {
        host.changed(row.id, "codexhost/thread/queue/updated");
      }
      await prompt.waitFor({ timeout: 3000 });
      await page
        .locator('[data-queue-dock] button[aria-label="Remove queued message"]:enabled')
        .waitFor();
      if (process.env.CODEXHOST_TEST_SCREENSHOTS)
        await page.screenshot({
          path: join(process.env.CODEXHOST_TEST_SCREENSHOTS, "queue-added.png"),
        });
      if (reconnect) await page.context().setOffline(true);
      const clientId = queue.items[0]?.clientUserMessageId;
      queue = { items: [], pausedReason: null };
      if (scenario === "auto-send") {
        row.turns.push({
          id: "automatically-started",
          status: "inProgress",
          items: [
            {
              id: "queued-user",
              type: "userMessage",
              clientId,
              content: [{ type: "text", text: "Queued from GUI" }],
            },
            { id: "queued-answer", type: "agentMessage", text: "Reply to queued message" },
          ],
        });
      }
      host.changed(row.id, "codexhost/thread/queue/updated");
      if (reconnect) {
        await new Promise((resolve) => setTimeout(resolve, 300));
        await page.context().setOffline(false);
        await page.getByText(/^Reconnecting/u).waitFor({ state: "hidden", timeout: 10_000 });
      }
      await prompt.waitFor({ state: "hidden", timeout: 5000 });
      if (scenario === "auto-send")
        await page.getByText("Reply to queued message", { exact: true }).waitFor();
      // Clearing projections during reconnect is not proof the live stream
      // recovered. Require another add/delete round trip on that same page.
      queue = {
        pausedReason: null,
        items: [
          {
            id: "after-reconnect",
            clientUserMessageId: "later-gui-message",
            input: [{ type: "text", text: "Queued from GUI" }],
            presentationInput: null,
          },
        ],
      };
      host.changed(row.id, "codexhost/thread/queue/updated");
      await prompt.waitFor({ timeout: 5000 });
      queue = { items: [], pausedReason: null };
      host.changed(row.id, "codexhost/thread/queue/updated");
      await prompt.waitFor({ state: "hidden", timeout: 5000 });
      if (process.env.CODEXHOST_TEST_SCREENSHOTS)
        await page.screenshot({
          path: join(process.env.CODEXHOST_TEST_SCREENSHOTS, "queue-deleted.png"),
        });
      assert.deepEqual(errors, []);
    },
  );
