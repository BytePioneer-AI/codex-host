/** Sent-message presentation only; history and clipboard must keep the original links. */
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { chromium } from "playwright";
import { threadReferenceInsert } from "@deepseek-ai/dsh-client-ui-conversation/thread-reference";
import { FakeChHost, startFakeChDebugger } from "../support/ch-host.ts";
import { startServer } from "../support/server.ts";

it(
  "sent user bubbles fold explicit Thread links to safe blue labels and copy losslessly",
  { timeout: 60_000 },
  async (t) => {
    const host = new FakeChHost();
    const destination = host.add("destination", "/computer/project", "Sent references");
    host.add("target-a", "/computer/project", "归档是 DSH 原生的吗");
    host.add("target-b", "/computer/project", "归档是 DSH 原生的吗");
    const first = "[@归档是 DSH 原生的吗](thread://target-a?hostId=local)";
    const second = "[@归档是 DSH 原生的吗](thread://target-b?hostId=local)";
    const specialTitle = "标题](evil)\\ <b> *测试* _x_ `代码`";
    const special = threadReferenceInsert({
      threadId: "target-special",
      hostId: "local",
      title: specialTitle,
    }).clipboardText;
    const remote = "[@远程参考](thread://other?hostId=remote-explicit)";
    const plain =
      "target-id codex://threads/raw thread://raw?hostId=local [普通链接](https://example.com) [@缺来源](thread://raw) [@不支持](javascript:alert)";
    const text = `${first} 你能看到这个消息吗\n${second}\n${special}\n${remote}\n@[旧会话](dsh-session:abc)\n${plain}`;
    const user = destination.turns[0]?.items.find((item) => item.type === "userMessage");
    assert.ok(user);
    user.content = [{ type: "text", text }];
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
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
      permissions: ["clipboard-read", "clipboard-write"],
    });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(url);
    const folder = page.locator('[data-row-key^="workspace:"]').filter({ hasText: /^project$/ });
    await folder.waitFor();
    if ((await folder.getAttribute("aria-expanded")) === "false") await folder.click();
    await page.locator('[data-row-key="session:destination"]').click();
    const body = page.locator("[data-conversation-scroll]");
    const chips = body.locator('[data-ref-chip="session"]');
    await chips.first().waitFor();
    assert.equal(await chips.count(), 5);
    assert.deepEqual(await chips.allTextContents(), [
      "归档是 DSH 原生的吗",
      "归档是 DSH 原生的吗",
      specialTitle,
      "远程参考",
      "旧会话",
    ]);
    assert.equal(await chips.nth(0).getAttribute("title"), first);
    assert.equal(await chips.nth(1).getAttribute("title"), second);
    assert.equal(await chips.nth(2).getAttribute("title"), special);
    assert.equal(await chips.nth(3).getAttribute("title"), remote);
    assert.equal(await chips.nth(0).locator("svg").count(), 1);
    assert.equal(
      await chips.nth(0).evaluate((element) => getComputedStyle(element).color),
      "rgb(65, 118, 230)",
    );
    assert.equal(await chips.locator("a,button,b,script").count(), 0);
    const visible = await body.innerText();
    assert.ok(visible.includes("你能看到这个消息吗"));
    assert.ok(visible.includes(plain));
    assert.equal(visible.includes(first), false);
    await page.getByRole("button", { name: "Copy", exact: true }).first().click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), text);
    if (process.env.CODEXHOST_TEST_SCREENSHOTS) {
      mkdirSync(process.env.CODEXHOST_TEST_SCREENSHOTS, { recursive: true });
      await page.screenshot({
        path: join(process.env.CODEXHOST_TEST_SCREENSHOTS, "thread-reference-sent-message.png"),
        animations: "disabled",
      });
    }
    await page.reload();
    await chips.first().waitFor();
    assert.equal(await chips.count(), 5, "existing history needs no rewrite or migration");
    assert.equal(await chips.nth(0).getAttribute("title"), first);
    assert.equal(
      host.requests.some(
        (request) =>
          request.method === "thread/turns/list" &&
          ["target-a", "target-b"].includes(String(request.params.threadId)),
      ),
      false,
    );
    assert.equal(
      host.requests.some((request) => request.method === "turn/start"),
      false,
    );
    assert.deepEqual(user.content, [{ type: "text", text }]);
    assert.deepEqual(errors, []);
  },
);
