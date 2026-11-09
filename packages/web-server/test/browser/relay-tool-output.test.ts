import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { createServer } from "node:http";
import { connect, type Socket } from "node:net";
import { once } from "node:events";
import { chromium, expect } from "@playwright/test";
import { toolOutputRelay } from "../support/tool-output-relay.ts";

it(
  "expands relay previews in place, retries, copies full text and caches by version on a phone",
  { timeout: 60_000 },
  async (t) => {
    const f = await toolOutputRelay(t);
    const sockets = new Set<Socket>();
    const proxy = createServer();
    proxy.on("connect", (_request, client, head) => {
      const upstream = connect(f.relay.port, "127.0.0.1", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        upstream.write(head);
        client.pipe(upstream).pipe(client);
      });
      sockets.add(upstream);
      upstream.once("close", () => {
        sockets.delete(upstream);
        client.destroy();
      });
      client.once("close", () => upstream.destroy());
      upstream.on("error", () => client.destroy());
      client.on("error", () => upstream.destroy());
    });
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    t.after(() => {
      for (const socket of sockets) socket.destroy();
      proxy.close();
    });
    const address = proxy.address() as { port: number };
    const browser = await chromium.launch({
      proxy: { server: `http://127.0.0.1:${address.port}` },
    });
    t.after(() => browser.close());
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      locale: "zh-CN",
      ignoreHTTPSErrors: true,
      reducedMotion: "reduce",
    });
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: f.origin });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let requests = 0;
    let fail = true;
    let stale = false;
    const gate = Promise.withResolvers<undefined>();
    t.after(() => gate.resolve(undefined));
    await page.route("**/api/session/toolOutput", async (route) => {
      requests++;
      if (stale) {
        await route.fulfill({
          json: {
            type: "server-response",
            rpcId: route.request().postDataJSON().rpcId,
            result: {
              ok: false,
              error: { code: "session/tool-output-stale", message: "Refresh", details: {} },
            },
          },
        });
        return;
      }
      if (fail) {
        fail = false;
        await route.fulfill({ status: 503, body: "unavailable" });
        return;
      }
      await gate.promise;
      await route.continue();
    });
    await page.goto(`${f.origin}/?session=${f.row.id}#token=${f.secret}`);
    await expect(page.getByText("Diagnostics ready", { exact: true })).toBeVisible();
    const showFull = page.getByRole("button", { name: /^显示完整输出（共 \d+ KB）$/u });
    const reveal = async () => {
      const process = page.locator("button[data-turn-process]").first();
      if (await process.count()) {
        if ((await process.getAttribute("aria-expanded")) !== "true") await process.click();
      }
      const command = page.getByRole("button", { name: "执行了命令", exact: true });
      if ((await command.count()) && (await command.getAttribute("aria-expanded")) !== "true")
        await command.click();
      const tool = page.locator('[data-sample="bash"]');
      if ((await tool.getAttribute("aria-expanded")) !== "true") await tool.click();
      await expect(showFull).toBeVisible();
      await expect(page.locator('[data-tool-output-preview] [data-sample="bash"]')).toHaveCount(1);
      await expect(page.locator("[data-tool-output-preview] pre")).toHaveCount(0);
      await expect(
        page
          .locator("[data-tool-output-preview]")
          .getByRole("button", { name: "复制", exact: true }),
      ).toHaveCount(1);
    };
    await reveal();
    const preview = page.locator("[data-tool-output-preview]");
    assert.equal(requests, 0);
    await expect(preview).not.toContainText("Diagnostic line 500:");
    const screenshots = process.env.CODEXHOST_TEST_SCREENSHOTS;
    if (screenshots) {
      mkdirSync(screenshots, { recursive: true });
      await page.screenshot({ path: join(screenshots, "history-sync-tool-output-mobile.png") });
    }
    await expect(showFull).toHaveText("显示完整输出（共 98 KB）");
    await showFull.click();
    await expect(preview.getByRole("alert")).toHaveText("加载失败，请重试。");
    await page.getByRole("button", { name: "重试加载完整输出", exact: true }).click();
    await expect(preview.getByRole("status")).toHaveText("正在加载完整输出…");
    const anchor = page.locator("[data-chat-call-id]").first();
    const before = await anchor.evaluate((element) => element.getBoundingClientRect().top);
    gate.resolve(undefined);
    await expect(preview).toContainText("Diagnostic line 500:");
    await expect(preview.getByRole("status")).toHaveCount(0);
    assert.equal(requests, 2);
    const after = await anchor.evaluate((element) => element.getBoundingClientRect().top);
    assert.ok(Math.abs(after - before) < 40, `reading anchor moved ${after - before}px`);
    await expect(preview.getByRole("button", { name: "复制", exact: true })).toHaveCount(1);
    await preview.getByRole("button", { name: "复制", exact: true }).click();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    assert.ok(copied.length >= 100_000);
    assert.match(copied, /characters truncated/);
    assert.equal(requests, 2);

    // A fresh page tests copy-before-expand against the real authenticated endpoint.
    await page.reload();
    await expect(page.getByText("Diagnostics ready", { exact: true })).toBeVisible();
    await reveal();
    await preview.getByRole("button", { name: "复制", exact: true }).click();
    await expect(preview.getByRole("button", { name: "复制成功", exact: true })).toBeVisible();
    assert.equal(requests, 3);
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), copied);
    await showFull.click();
    await expect(preview).toContainText("Diagnostic line 500:");
    assert.equal(requests, 3);

    await page.reload();
    await expect(page.getByText("Diagnostics ready", { exact: true })).toBeVisible();
    await reveal();
    stale = true;
    await showFull.click();
    await expect(preview.getByRole("alert")).toHaveText("工具输出已变化，请刷新会话。");
    await preview.getByRole("button", { name: "复制", exact: true }).click();
    await expect(preview.getByRole("alert")).toHaveText("工具输出已变化，请刷新会话。");
    assert.equal(
      await page.evaluate(() => navigator.clipboard.readText()),
      copied,
      "failed copy must not replace the clipboard with a preview",
    );
    assert.deepEqual(errors, []);
  },
);
