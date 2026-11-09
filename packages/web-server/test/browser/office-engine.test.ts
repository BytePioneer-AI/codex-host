import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { chromium } from "playwright";
import { FakeChHost, startFakeChDebugger } from "../support/ch-host.ts";
import { startServer } from "../support/server.ts";

it(
  "retries a downloading Office preview, stops when leaving, and displays the completed PDF",
  { timeout: 90_000 },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), "office-preview-test-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    copyFileSync(
      join(import.meta.dirname, "../fixtures/office/sample.docx"),
      join(workspace, "sample.docx"),
    );
    const host = new FakeChHost();
    const thread = host.add("office-thread", workspace, "Office preview");
    thread.turns = [
      {
        id: "turn",
        status: "completed",
        items: [
          { id: "u", type: "userMessage", content: [{ type: "text", text: "Open Office" }] },
          { id: "a", type: "agentMessage", text: "[sample.docx](sample.docx)" },
        ],
      },
    ];
    const debug = await startFakeChDebugger(host);
    t.after(() => debug.close());
    const url = new URL(
      await startServer(
        t,
        resolve(import.meta.dirname, "../.."),
        ["--import", "tsx", "src/main.ts"],
        ["--ch-cdp", debug.endpoint, "--adapters", "test/fake-harness", "--port", "4470"],
        {
          environment: {
            HOME: root,
            CODEXHOST_DATA_DIR: join(root, "host"),
            CODEX_HOME: join(root, "codex"),
            CODEXHOST_CONSOLE_PORT: "4471",
            SSH_CONNECTION: "smoke",
          },
        },
      ),
    );
    url.searchParams.set("session", "office-thread");
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    let downloading = true;
    let failed = false;
    let requests = 0;
    const addresses: unknown[] = [];
    const retryResponse = Promise.withResolvers<undefined>();
    t.after(() => retryResponse.resolve(undefined));
    await page.route("**/api/officeToPdf/render", async (route) => {
      requests++;
      const body = route.request().postDataJSON();
      addresses.push(body.payload.args);
      if (requests === 2) await retryResponse.promise;
      if (!downloading) return route.continue();
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          type: "server-response",
          rpcId: body.rpcId,
          result: {
            ok: false,
            error: {
              code: "document-render/failed",
              message: "Office conversion failed.",
              details: { reason: failed ? "unavailable" : "downloading" },
            },
          },
        }),
      });
    });
    const open = async () => {
      await page.goto(url.href);
      await page.getByRole("button", { name: "sample.docx", exact: true }).click();
    };
    await open();
    await page.getByText(/正在下载 Office|Downloading the Office/u).waitFor();
    await page.waitForTimeout(3500);
    assert.ok(requests >= 2, "the same preview should retry every few seconds");
    assert.deepEqual(addresses[1], addresses[0]);
    assert.equal(await page.getByText(/文档渲染中|Rendering document/u).count(), 0);
    assert.equal(await page.getByText(/正在下载 Office|Downloading the Office/u).isVisible(), true);
    const retried = page.waitForResponse("**/api/officeToPdf/render");
    retryResponse.resolve(undefined);
    await retried;
    await page.goto("about:blank");
    const leftAt = requests;
    await page.waitForTimeout(3500);
    assert.equal(requests, leftAt, "leaving the page stops retries");
    await open();
    await page.getByText(/正在下载 Office|Downloading the Office/u).waitFor();
    downloading = false;
    await page.locator("[data-pdf-preview] [data-pdf-page]").waitFor({ timeout: 30_000 });
    const completedAt = requests;
    await page.waitForTimeout(3500);
    assert.equal(requests, completedAt, "a successful preview stops retries");
    downloading = true;
    await open();
    await page.getByText(/正在下载 Office|Downloading the Office/u).waitFor();
    failed = true;
    await page
      .getByText(/请检查运行 Web 的电脑的网络|Check the network on the computer running Web/u)
      .waitFor();
    const failedAt = requests;
    await page.waitForTimeout(3500);
    assert.equal(requests, failedAt, "a failed download stops automatic retries");
  },
);
