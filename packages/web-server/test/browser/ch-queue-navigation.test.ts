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

for (const leaveWhileSending of [false, true])
  it(
    `restores the authoritative queue after navigation (sending: ${leaveWhileSending})`,
    { timeout: 30_000 },
    async (t) => {
      const directory = mkdtempSync(join(tmpdir(), "ch-queue-navigation-"));
      t.after(() => rmSync(directory, { recursive: true, force: true }));
      const host = new FakeChChannel();
      const row = host.add("queue-thread", "/computer/queue-project", "Queue navigation");
      host.add("other-thread", "/computer/queue-project", "Other conversation");
      row.status = { type: "active" };
      let queue: NonNullable<ClientThreadSnapshot["queue"]> = { items: [], pausedReason: null };
      const snapshot = host.snapshot.bind(host);
      host.snapshot = async (id) => ({
        ...(await snapshot(id)),
        ...(id === row.id ? { queue: structuredClone(queue) } : {}),
      });
      const requested = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const accepted = Promise.withResolvers<void>();
      t.after(() => release.resolve());
      let submissions = 0;
      const request = host.request.bind(host);
      host.request = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
        if (method !== "turn/start") return request<T>(method, params);
        submissions++;
        assert.equal(params.delivery, "queue");
        requested.resolve();
        if (leaveWhileSending) await release.promise;
        queue = {
          pausedReason: null,
          items: [
            {
              id: "queued",
              clientUserMessageId: String(params.clientUserMessageId),
              input: params.input as (typeof queue.items)[number]["input"],
              presentationInput: null,
            },
          ],
        };
        host.changed(row.id, "codexhost/thread/queue/updated");
        accepted.resolve();
        return { queued: true, queuedSubmission: queue.items[0] } as T;
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
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(url);
      const folder = page.getByRole("treeitem").filter({ hasText: /^queue-project$/u });
      await folder.waitFor();
      if ((await folder.getAttribute("aria-expanded")) === "false") await folder.click();
      const open = async (title: string) => {
        await page.getByRole("treeitem").filter({ hasText: title }).click();
        await page.getByText("existing CH answer", { exact: true }).waitFor();
      };
      const pending = page
        .locator("[data-queue-dock]")
        .getByText("Navigation message", { exact: true });
      const admitted = page.locator(
        '[data-queue-dock] button[aria-label="Remove queued message"]:enabled',
      );
      await open("Queue navigation");
      await page.locator('[contenteditable="true"]').fill("Navigation message");
      await page.getByRole("button", { name: "Queue message", exact: true }).click();
      await requested.promise;
      await pending.waitFor();
      if (!leaveWhileSending) await admitted.waitFor();
      await open("Other conversation");
      release.resolve();
      await accepted.promise;
      await open("Queue navigation");
      await pending.waitFor();
      await admitted.waitFor();

      // No transcript event or watermark advance: a GUI deletion while this
      // Thread is not selected must still replace its cached queue on return.
      await open("Other conversation");
      queue = { items: [], pausedReason: null };
      host.changed(row.id, "codexhost/thread/queue/updated");
      await open("Queue navigation");
      await pending.waitFor({ state: "hidden", timeout: 5000 });
      assert.equal(submissions, 1, "navigation must not resubmit an accepted message");
      assert.deepEqual(errors, []);
    },
  );
