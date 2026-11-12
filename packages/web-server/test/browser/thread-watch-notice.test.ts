/** Watch notices are display-only cards without message actions; navigation keeps its native semantics. */
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { chromium } from "playwright";
import { formatThreadWatchNotice, THREAD_WATCH_NOTICE_HEADER } from "@codexhost/shared-contracts";
import { FakeChHost, startFakeChDebugger } from "../support/ch-host.ts";
import { startServer } from "../support/server.ts";

for (const width of [1280, 390])
  it(
    `watch notices render lossless, directory-aware cards at ${width}px`,
    { timeout: 90_000 },
    async (t) => {
      const host = new FakeChHost();
      const source = host.add("watch-source", "/computer/project", "Watch notices");
      const currentTitle = "审查最近 PR · 委派五项 Harness 任务与非常长的会话标题以验证窄屏布局";
      const target = host.add("watch-target", "/computer/project", currentTitle);
      const answer = target.turns[0]?.items.at(-1);
      assert.ok(answer);
      answer.text = "Exact watched target answer";
      const note = "Not stopped after 29 min; run 'codexhost thread watch' again to keep waiting.";
      const text = formatThreadWatchNotice([
        {
          threadId: "watch-target",
          label: "Old title",
          outcome: "interrupted",
        },
        { threadId: "late-target", label: "尚未载入的会话", outcome: "timedOut", note },
        { threadId: "missing", label: "不存在的会话", outcome: "notFound" },
        { threadId: "done", label: "完成的会话", outcome: "completed" },
        { threadId: "failed", label: "失败的会话", outcome: "failed" },
        { threadId: "unknown", label: "未知的会话", outcome: "unreadable" },
      ]);
      const user = source.turns[0]?.items.find((item) => item.type === "userMessage");
      assert.ok(user);
      user.content = [{ type: "text", text }];
      const malformed = host.add("malformed", "/computer/project", "Malformed notice");
      const malformedText = `${text}\nThis is ordinary extra text.`;
      const malformedUser = malformed.turns[0]?.items.find((item) => item.type === "userMessage");
      assert.ok(malformedUser);
      malformedUser.content = [{ type: "text", text: malformedText }];
      const legacy = host.add("legacy", "/computer/project", "Legacy notice");
      const legacyText = "These Threads stopped: codex://threads/watch-target Turn old-turn-uuid";
      const legacyUser = legacy.turns[0]?.items.find((item) => item.type === "userMessage");
      assert.ok(legacyUser);
      legacyUser.content = [{ type: "text", text: legacyText }];
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
        locale: "en-US",
        colorScheme: "light",
        viewport: { width, height: 1000 },
        permissions: ["clipboard-read", "clipboard-write"],
      });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`${url}?session=watch-source`);
      const body = page.locator("[data-conversation-scroll]");
      const card = body.locator("[data-thread-watch-notice]");
      const known = card.locator('[data-thread-watch-entry="watch-target"]');
      const late = card.locator('[data-thread-watch-entry="late-target"]');
      await known.getByText(currentTitle, { exact: true }).waitFor();
      assert.equal(await card.count(), 1);
      assert.equal(await card.locator("li").count(), 6);
      assert.equal(await body.locator('[class*="_bubble"]').count(), 0);
      assert.equal((await card.innerText()).includes(THREAD_WATCH_NOTICE_HEADER), false);
      assert.equal((await card.innerText()).includes("Old title"), false);
      await known.locator('[data-harness-id="fake"] img').waitFor();
      const destination = await known
        .getByRole("link", { name: "Open session", exact: true })
        .getAttribute("href");
      assert.ok(destination);
      assert.equal(new URL(destination).searchParams.get("session"), "watch-target");
      await late.getByText("尚未载入的会话", { exact: true }).waitFor();
      assert.equal(await late.getByRole("link").count(), 0);
      assert.equal(await late.locator("svg").count(), 1, "generic Session glyph");
      assert.equal(await card.locator(":scope > svg").count(), 1, "one bell per card");
      await late.getByText(note, { exact: true }).waitFor();
      for (const label of [
        "Interrupted",
        "Watch expired",
        "Session not found",
        "Completed",
        "Failed",
        "State unknown",
      ])
        await card.getByText(label, { exact: true }).waitFor();
      assert.deepEqual(user.content, [{ type: "text", text }]);
      const targetReads = () =>
        host.requests.filter(
          ({ method, params }) =>
            ["thread/read", "thread/turns/list"].includes(method) &&
            ["watch-target", "late-target"].includes(String(params.threadId)),
        );
      assert.equal(targetReads().length, 0, "rendering never reads target history");
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      assert.ok(await card.evaluate((element) => element.scrollWidth <= element.clientWidth));
      if (process.env.CODEXHOST_TEST_SCREENSHOTS) {
        mkdirSync(process.env.CODEXHOST_TEST_SCREENSHOTS, { recursive: true });
        await page.screenshot({
          path: join(process.env.CODEXHOST_TEST_SCREENSHOTS, `thread-watch-notice-${width}.png`),
          animations: "disabled",
        });
      }
      // The card has no message actions; only the assistant answer keeps its Copy button.
      assert.equal(await page.getByRole("button", { name: "Copy", exact: true }).count(), 1);
      // Directory updates alone make an unresolved entry openable, without reading it.
      host.add("late-target", "/computer/project", "New directory title");
      await late.getByText("New directory title", { exact: true }).waitFor({ timeout: 15_000 });
      await late.getByRole("link", { name: "Open session", exact: true }).waitFor();
      assert.equal(targetReads().length, 0);
      await known.getByRole("link", { name: "Open session", exact: true }).click();
      await page.getByText("Exact watched target answer", { exact: true }).waitFor();
      assert.ok(targetReads().length > 0, "activation uses the existing lazy history loader");
      assert.equal(
        targetReads().some(({ params }) => params.threadId === "late-target"),
        false,
      );
      assert.equal(page.context().pages().length, 1);
      // Invalid and legacy notices keep their ordinary bubble and raw clipboard text.
      for (const [id, raw] of [
        ["malformed", malformedText],
        ["legacy", legacyText],
      ]) {
        await page.goto(`${url}?session=${id}`);
        const bubble = body.locator('[class*="_bubble"]');
        await bubble.waitFor();
        assert.equal(await bubble.innerText(), raw);
        assert.equal(await card.count(), 0);
        await page.getByRole("button", { name: "Copy", exact: true }).first().click();
        assert.equal(await page.evaluate(() => navigator.clipboard.readText()), raw);
      }
      assert.equal(
        host.requests.some(({ method }) => method === "turn/start"),
        false,
      );
      assert.deepEqual(errors, []);
    },
  );
