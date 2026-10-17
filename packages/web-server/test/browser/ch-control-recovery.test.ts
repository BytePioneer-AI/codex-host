/** Queue and usage must recover together without replacing the browser page. */
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";
import type { ClientThreadSnapshot, ThreadUsageSnapshot } from "@codexhost/shared-contracts";
import { chromium } from "playwright";
import { FakeChChannel, startFakeChChannel } from "../support/ch-channel.ts";
import { startFakeChDebugger } from "../support/ch-host.ts";
import { startServer } from "../support/server.ts";

it(
  "recovers GUI queue and usage changes across repeated Web restarts",
  { timeout: 40_000 },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "ch-control-recovery-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const host = new FakeChChannel();
    const row = host.add("control-thread", "/computer/control-project", "Control recovery");
    let queue: ClientThreadSnapshot["queue"] = {
      pausedReason: null,
      items: [
        {
          id: "original-queue",
          clientUserMessageId: "original-input",
          input: [{ type: "text", text: "Queued before disconnect" }],
          presentationInput: null,
        },
      ],
    };
    let usage: ThreadUsageSnapshot = { cacheHitRatePercent: 94.3, totalCostUsd: 0.033 };
    const snapshot = host.snapshot.bind(host);
    host.snapshot = async (id) => ({ ...(await snapshot(id)), queue: structuredClone(queue) });
    const request = host.request.bind(host);
    host.request = async <T>(method: string, params: Record<string, unknown>): Promise<T> =>
      method === "codexhost/thread/usage/inspect"
        ? ({ threadId: params.threadId, usage: structuredClone(usage) } as T)
        : request<T>(method, params);
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
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error" && message.text().includes("control stream failed"))
        errors.push(message.text());
    });
    await page.goto(url);
    const folder = page.getByRole("treeitem").filter({ hasText: /^control-project$/u });
    await folder.waitFor();
    if ((await folder.getAttribute("aria-expanded")) === "false") await folder.click();
    await page.getByRole("treeitem").filter({ hasText: "Control recovery" }).click();
    await page.getByText("Queued before disconnect", { exact: true }).waitFor();
    const meter = page.locator('[data-composer-stat="codexhost-usage"] button');
    await meter.filter({ hasText: "CH 94.3%" }).waitFor();
    const composer = page.locator("[data-composer-input]");
    await composer.fill("Keep this unsent draft");
    const screenshots = process.env.CODEXHOST_TEST_SCREENSHOTS;
    if (screenshots) {
      mkdirSync(screenshots, { recursive: true });
      await page.screenshot({ path: join(screenshots, "control-before.png") });
    }

    for (let cycle = 0; cycle < 2; cycle++) {
      assert.ok(child);
      const exited = new Promise<void>((resolve) => child?.once("exit", () => resolve()));
      child.kill("SIGTERM");
      await exited;
      // Outlast the immediate socket retry: the old implementation's control
      // consumer could terminate before the connection announced its generation.
      await new Promise((resolve) => setTimeout(resolve, 1000));
      queue = { items: [], pausedReason: null };
      usage = { cacheHitRatePercent: 91.8, totalCostUsd: 0.037 + cycle * 0.01 };
      await launch(new URL(url).port);
      await page.locator("[data-queue-dock]").waitFor({ state: "hidden", timeout: 5000 });
      await meter.filter({ hasText: "CH 91.8%" }).waitFor({ timeout: 5000 });
      assert.match(await meter.innerText(), cycle === 0 ? /\$0\.037/u : /\$0\.047/u);

      // No new Turn, transcript event or updatedAt: only the owner facts change.
      // This models edits from the GUI after the browser connection has recovered.
      const text = `Queued from GUI after reconnect ${cycle}`;
      queue = {
        pausedReason: null,
        items: [
          {
            id: `new-queue-${cycle}`,
            clientUserMessageId: `new-input-${cycle}`,
            input: [{ type: "text", text }],
            presentationInput: null,
          },
        ],
      };
      usage = { cacheHitRatePercent: 88.2, totalCostUsd: 0.051 + cycle * 0.01 };
      host.changed(row.id, "codexhost/thread/queue/updated");
      host.changed(row.id, "thread/tokenUsage/updated");
      await page.getByText(text, { exact: true }).waitFor({ timeout: 5000 });
      await meter.filter({ hasText: "CH 88.2%" }).waitFor({ timeout: 5000 });
      assert.match(await meter.innerText(), cycle === 0 ? /\$0\.051/u : /\$0\.061/u);
      assert.equal(await composer.innerText(), "Keep this unsent draft");
      if (screenshots)
        await page.screenshot({ path: join(screenshots, `control-recovered-${cycle}.png`) });
    }
    queue = { items: [], pausedReason: null };
    host.changed(row.id, "codexhost/thread/queue/updated");
    await page.locator("[data-queue-dock]").waitFor({ state: "hidden", timeout: 5000 });
    assert.equal(
      host.requests.some(({ method }) => method === "turn/start"),
      false,
    );
    assert.deepEqual(errors, []);
  },
);
