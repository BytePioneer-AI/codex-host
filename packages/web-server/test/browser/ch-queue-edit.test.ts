/** Real Web UI against a simulated owner; native GUI protocol is tested in host-runtime. */
import type { ChildProcess } from "node:child_process";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";
import type { ClientThreadSnapshot } from "@codexhost/shared-contracts";
import { chromium } from "playwright";
import { FakeChChannel, startFakeChChannel } from "../support/ch-channel.ts";
import { startFakeChDebugger } from "../support/ch-host.ts";
import { startServer } from "../support/server.ts";

for (const outcome of ["deleted", "missing", "failed", "restarted"] as const)
  it(
    `edits a queued message through dequeue and composer: ${outcome}`,
    { timeout: 40_000 },
    async (t) => {
      const directory = mkdtempSync(join(tmpdir(), "ch-browser-queue-edit-"));
      t.after(() => rmSync(directory, { recursive: true, force: true }));
      const host = new FakeChChannel();
      const row = host.add("queue-thread", "/computer/queue-project", "Queue edit verification");
      row.status = { type: "active" };
      let queue: ClientThreadSnapshot["queue"] = {
        pausedReason: null,
        items: [
          {
            id: "old-item",
            clientUserMessageId: "original",
            input: [{ type: "text", text: "Original queued message" }],
            presentationInput: null,
          },
        ],
      };
      const snapshot = host.snapshot.bind(host);
      host.snapshot = async (id) => ({ ...(await snapshot(id)), queue: structuredClone(queue) });
      const requested = Promise.withResolvers<undefined>();
      const release = Promise.withResolvers<undefined>();
      t.after(() => release.resolve(undefined));
      const request = host.request.bind(host);
      host.request = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
        if (method === "thread/queue/delete") {
          host.requests.push({ method, params });
          requested.resolve(undefined);
          await release.promise;
          if (outcome === "failed") throw new Error("Synthetic removal failure");
          queue = { items: [], pausedReason: null };
          host.changed(row.id, "codexhost/thread/queue/updated");
          return { deleted: outcome === "deleted" || outcome === "restarted" } as T;
        }
        if (method === "turn/start") {
          host.requests.push({ method, params });
          assert.equal(params.delivery, "queue");
          assert.deepEqual(params.input, [
            { type: "text", text: "Edited queued message", text_elements: [] },
          ]);
          queue = {
            pausedReason: null,
            items: [
              {
                id: "new-item",
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
      let child: ChildProcess | undefined;
      const launch = (port?: string) =>
        startServer(
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
            ...(port ? ["--port", port] : []),
          ],
          {
            onSpawn: (process) => {
              child = process;
            },
          },
        );
      const url = await launch();
      const browser = await chromium.launch();
      t.after(() => browser.close());
      const pages = await Promise.all([browser.newPage(), browser.newPage()]);
      const errors: string[] = [];
      for (const page of pages) {
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(url);
        const folder = page.getByRole("treeitem").filter({ hasText: /^queue-project$/u });
        await folder.waitFor();
        if ((await folder.getAttribute("aria-expanded")) === "false") await folder.click();
        await page.getByRole("treeitem").filter({ hasText: "Queue edit verification" }).click();
        await page.getByText("Original queued message", { exact: true }).waitFor();
      }
      const [page, observer] = pages;
      assert.ok(page && observer);
      if (outcome === "restarted") {
        assert.ok(child);
        const exited = new Promise<void>((resolve) => child?.once("exit", () => resolve()));
        child.kill("SIGTERM");
        await exited;
        await new Promise((resolve) => setTimeout(resolve, 700));
        await launch(new URL(url).port);
        // No page reload: the new control stream must receive subsequent queue changes.
        await page.getByText("Original queued message", { exact: true }).waitFor();
      }
      const composer = page.locator("[data-composer-input]");
      await composer.fill("Existing draft");
      await page.getByRole("button", { name: "Edit queued message", exact: true }).click();
      await requested.promise;
      assert.equal(
        await composer.innerText(),
        "Existing draft",
        "No restore before deletion is confirmed",
      );
      await composer.fill("Draft typed during deletion");
      release.resolve(undefined);
      if (outcome === "missing" || outcome === "failed") {
        await page
          .getByText("Edit failed: this message may have already started sending.", { exact: true })
          .waitFor();
        assert.equal(await composer.innerText(), "Draft typed during deletion");
        assert.equal(host.requests.filter(({ method }) => method === "turn/start").length, 0);
        assert.deepEqual(errors, []);
        return;
      }
      for (const viewer of pages)
        await viewer
          .locator("[data-queue-dock]")
          .getByText("Original queued message", { exact: true })
          .waitFor({ state: "hidden" });
      await page.waitForFunction(() =>
        document
          .querySelector('[contenteditable="true"]')
          ?.textContent?.includes("Original queued message"),
      );
      assert.equal(
        (await composer.innerText()).replace(/\n+/gu, "\n"),
        "Draft typed during deletion\nOriginal queued message",
      );
      assert.equal(
        await observer.locator("[data-composer-input]").innerText(),
        "",
        "Draft is private to the editing browser",
      );
      assert.equal(
        host.requests.filter(
          ({ method }) => method === "turn/start" || method === "thread/queue/update",
        ).length,
        0,
      );
      if (process.env.CODEXHOST_TEST_SCREENSHOTS) {
        mkdirSync(process.env.CODEXHOST_TEST_SCREENSHOTS, { recursive: true });
        await page.screenshot({
          path: join(process.env.CODEXHOST_TEST_SCREENSHOTS, "queue-edit-restored.png"),
        });
        await observer.screenshot({
          path: join(process.env.CODEXHOST_TEST_SCREENSHOTS, "queue-edit-observer-removed.png"),
        });
      }
      await composer.fill("Edited queued message");
      await page.getByRole("button", { name: "Queue message", exact: true }).click();
      for (const viewer of pages)
        await viewer
          .locator("[data-queue-dock]")
          .getByText("Edited queued message", { exact: true })
          .waitFor();
      assert.equal(queue.items[0]?.id, "new-item");
      assert.equal(
        host.requests.filter(({ method }) => method === "thread/queue/delete").length,
        1,
      );
      assert.equal(host.requests.filter(({ method }) => method === "turn/start").length, 1);
      if (process.env.CODEXHOST_TEST_SCREENSHOTS)
        await observer.screenshot({
          path: join(process.env.CODEXHOST_TEST_SCREENSHOTS, "queue-edit-observer-requeued.png"),
        });
      assert.deepEqual(errors, []);
    },
  );
