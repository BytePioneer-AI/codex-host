/** Assistant Thread links navigate inside Web without invoking Desktop or reading before activation. */
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { it } from "node:test";
import { chromium } from "playwright";
import { FakeChHost, startFakeChDebugger } from "../support/ch-host.ts";
import { startServer } from "../support/server.ts";

it(
  "assistant Thread links open the exact local Session and preserve safe link behavior",
  { timeout: 60_000 },
  async (t) => {
    const host = new FakeChHost();
    const source = host.add("link-source", "/computer/project", "Source Session");
    const first = host.add("target-A", "/computer/project", "Same title");
    const second = host.add("target-B", "/computer/project", "Same title");
    const answer = [
      "Source message links",
      "[DSH 实施任务](codex://threads/target-A)",
      "[另一条会话](thread://target-B?hostId=local)",
      "[远程同名 ID](thread://target-A?hostId=remote-explicit)",
      "[缺少来源](thread://target-A)",
      "[未知会话](codex://threads/missing)",
      "[新委派](codex://threads/late-target)",
      "[重复来源](thread://target-A?hostId=local&hostId=other)",
      "[恶意链接](javascript:alert)",
      "[数据链接](data:text/html,bad)",
      "[普通网页](https://example.com/path)",
      "[邮件](mailto:someone@example.com)",
    ].join("\n\n");
    const sourceAnswer = source.turns[0]?.items.at(-1);
    const firstAnswer = first.turns[0]?.items.at(-1);
    const secondAnswer = second.turns[0]?.items.at(-1);
    assert.ok(sourceAnswer && firstAnswer && secondAnswer);
    sourceAnswer.text = answer;
    firstAnswer.text = "Exact target A answer";
    secondAnswer.text = "Exact target B answer";
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
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      permissions: ["clipboard-read", "clipboard-write"],
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(url);
    const folder = page.locator('[data-row-key^="workspace:"]').filter({ hasText: /^project$/ });
    await folder.waitFor();
    if ((await folder.getAttribute("aria-expanded")) === "false") await folder.click();
    const sourceRow = page.locator('[data-row-key="session:link-source"]');
    await sourceRow.click();

    for (const reloaded of [false, true]) {
      if (reloaded) await page.reload();
      const desktopLink = page.getByRole("link", { name: "DSH 实施任务", exact: true });
      const threadLink = page.getByRole("link", { name: "另一条会话", exact: true });
      await desktopLink.waitFor();
      const desktopHref = await desktopLink.getAttribute("href");
      const threadHref = await threadLink.getAttribute("href");
      assert.ok(desktopHref && threadHref);
      assert.equal(new URL(desktopHref).origin, new URL(url).origin);
      assert.equal(new URL(desktopHref).searchParams.get("session"), "target-A");
      assert.equal(await desktopLink.getAttribute("target"), null);
      assert.equal(new URL(threadHref).searchParams.get("session"), "target-B");
      for (const name of [
        "远程同名 ID",
        "缺少来源",
        "未知会话",
        "新委派",
        "重复来源",
        "恶意链接",
        "数据链接",
      ]) {
        assert.equal(await page.getByRole("link", { name, exact: true }).count(), 0);
        await page.getByText(name, { exact: true }).waitFor();
      }
      const external = page.getByRole("link", { name: "普通网页", exact: true });
      assert.equal(await external.getAttribute("href"), "https://example.com/path");
      assert.equal(await external.getAttribute("target"), "_blank");
      assert.equal(await external.getAttribute("rel"), "noopener noreferrer");
      assert.equal(
        await page.getByRole("link", { name: "邮件", exact: true }).getAttribute("href"),
        "mailto:someone@example.com",
      );
    }
    assert.equal(
      host.requests.some(
        ({ method, params }) =>
          method === "thread/turns/list" &&
          ["target-A", "target-B"].includes(String(params.threadId)),
      ),
      false,
      "rendering a link must not read the target history",
    );
    await page.getByRole("button", { name: "Copy", exact: true }).last().click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), answer);
    host.add("late-target", "/computer/project", "Newly delegated Session");
    const lateLink = page.getByRole("link", { name: "新委派", exact: true });
    await lateLink.waitFor({ timeout: 15_000 });
    assert.equal(
      host.requests.some(
        ({ method, params }) => method === "thread/turns/list" && params.threadId === "late-target",
      ),
      false,
    );
    host.threads.delete("late-target");
    await lateLink.waitFor({ state: "detached", timeout: 15_000 });
    await page.getByText("新委派", { exact: true }).waitFor();
    await page.getByRole("link", { name: "DSH 实施任务", exact: true }).click();
    await page.getByText("Exact target A answer", { exact: true }).waitFor();
    assert.equal(context.pages().length, 1, "ordinary clicks stay in this Web page");
    await sourceRow.click();
    await page.getByRole("link", { name: "另一条会话", exact: true }).click();
    await page.getByText("Exact target B answer", { exact: true }).waitFor();
    await sourceRow.click();
    const [tab] = await Promise.all([
      context.waitForEvent("page"),
      page.getByRole("link", { name: "DSH 实施任务", exact: true }).click({ button: "middle" }),
    ]);
    await tab.getByText("Exact target A answer", { exact: true }).waitFor();
    assert.equal(new URL(tab.url()).origin, new URL(url).origin);
    assert.equal(sourceAnswer.text, answer);
    assert.equal(
      host.requests.some(({ method }) => method === "turn/start"),
      false,
    );
    assert.deepEqual(errors, []);
  },
);
