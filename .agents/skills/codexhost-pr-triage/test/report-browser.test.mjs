import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { chromium } from "@playwright/test";
import { renderReport } from "../lib/report.mjs";
import { createReport, createV2Report } from "./fixtures.mjs";

const assets = Object.fromEntries(
  await Promise.all(
    [
      ["template", "report-template.html"],
      ["styles", "report.css"],
      ["script", "report.js"],
    ].map(async ([key, name]) => [
      key,
      await readFile(new URL(`../assets/${name}`, import.meta.url), "utf8"),
    ]),
  ),
);

test("offline board renders actual input, safe details, cross-repo identities and working controls", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "triage-browser-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1100 },
    offline: true,
  });
  const page = await context.newPage();
  const errors = [];
  const network = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (/^https?:/u.test(request.url())) network.push(request.url());
  });
  const report = createReport();
  const hostile =
    '</script><script>window.pwned=true</script><img src=x onerror="window.pwned=true">';
  report.prs[0].title = hostile;
  report.prs[0].evidence[0].label = hostile;
  const other = structuredClone(report.prs[0]);
  other.repository = "example/other-fixture";
  other.title = "另一个仓库的同号 PR";
  other.url = "https://github.com/example/other-fixture/pull/1";
  report.repositories.push(other.repository);
  report.prs.push(other);
  const output = join(directory, "index.html");
  await writeFile(output, renderReport(report, assets));
  await page.goto(pathToFileURL(output).href);
  assert.equal(await page.locator("#load-notice").isVisible(), false);
  assert.equal(await page.locator(".column").count(), 4);
  assert.equal(await page.locator("#board .card").count(), 5);
  assert.match(await page.locator(".column.accept").innerText(), /CI 失败/u);
  assert.match(await page.locator(".column.accept").innerText(), /有冲突/u);
  assert.equal(await page.locator(".card h3").filter({ hasText: hostile }).count(), 1);
  const firstCard = await page.locator("#board .card").filter({ hasText: hostile }).innerText();
  assert.match(firstCard, /test: fixture PR 1/u);
  assert.match(firstCard, /作用 · 测试用户可见作用/u);
  assert.match(firstCard, /价值 · 测试价值说明/u);
  assert.match(firstCard, /判断 · 仅用于验证数据渲染/u);
  assert.equal(await page.evaluate(() => globalThis.pwned), undefined);
  assert.equal(await page.locator("img").count(), 0);
  assert.equal(await page.locator("#generated-time").getAttribute("datetime"), report.generatedAt);
  assert.match(await page.locator("#summary").innerText(), /已评估 5 个 PR/u);

  await page
    .getByRole("button", { name: "查看 example/other-fixture#1 评估详情", exact: true })
    .first()
    .click();
  assert.equal(await page.locator("#detail-title").innerText(), other.title);
  assert.match(await page.locator("#detail-body").innerText(), /原始标题 · test: fixture PR 1/u);
  assert.match(await page.locator("#detail-body").innerText(), /作用\s+测试用户可见作用/u);
  assert.match(await page.locator("#detail-body").innerText(), /判断理由\s+仅用于验证数据渲染/u);
  assert.equal(
    await page.getByRole("link", { name: "打开 PR ↗", exact: true }).getAttribute("href"),
    other.url,
  );
  assert.match(await page.locator("#detail-body").innerText(), /集成参考 · 不是硬阻断/u);
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("dialog").isVisible(), false);

  await page
    .getByRole("button", { name: "查看 example/triage-fixture#2 评估详情", exact: true })
    .first()
    .click();
  assert.match(await page.locator("#detail-body").innerText(), /删除重复配置/u);
  assert.equal(
    await page.locator(".evidence-file a").getAttribute("href"),
    report.prs[1].evidence[0].url,
  );
  await page.locator("#close-detail").click();
  await page.locator("#search").fill("other-fixture");
  assert.equal(await page.locator("#board .card").count(), 1);
  await page.locator("#search").fill("no-such-title");
  assert.equal(await page.locator("#board .card").count(), 0);
  await page.locator("#search").fill("");
  await page.locator("#show-ci").uncheck();
  assert.equal(await page.locator("#board .integration").count(), 0);
  assert.equal(await page.locator("#board .card").count(), 5);
  await page.locator("#show-ci").check();
  await page.locator("#table-tab").click();
  assert.equal(await page.locator("#table-view").isVisible(), true);
  assert.equal(await page.locator("tbody tr").count(), 5);
  await page.locator("#sort").selectOption("asc");
  assert.match(await page.locator("tbody tr").first().innerText(), /#1/u);
  await page.locator("#sort").selectOption("desc");
  assert.match(await page.locator("tbody tr").first().innerText(), /#4/u);
  const downloadEvent = page.waitForEvent("download");
  await page.locator("#export").click();
  const download = await downloadEvent;
  assert.deepEqual(JSON.parse(await readFile(await download.path(), "utf8")), report);
  await page.locator("#skipped-summary").click();
  assert.match(await page.locator("#skipped-list").innerText(), /测试草稿/u);
  await page.locator("#board-tab").click();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth,
    ),
    true,
  );

  // Partial results and missing evidence must remain visible rather than inventing a verdict.
  report.complete = false;
  report.errors = ["example/triage-fixture#10 尚未取得元数据；列表请求中断。"];
  report.prs = [report.prs[2]];
  Object.assign(report.prs[0], { baseSha: null, headSha: null, stats: null, evidence: [] });
  await writeFile(output, renderReport(report, assets));
  await page.reload();
  assert.match(await page.locator("#completeness").innerText(), /部分结果/u);
  assert.match(await page.locator("#collection-note").innerText(), /#10/u);
  assert.match(await page.locator("#board").innerText(), /HEAD 未知/u);
  await page
    .getByRole("button", { name: "查看 example/triage-fixture#3 评估详情", exact: true })
    .first()
    .click();
  assert.match(await page.locator("#detail-body").innerText(), /证据尚未取得/u);
  await page.keyboard.press("Escape");
  report.prs = [];
  report.skipped = [];
  await writeFile(output, renderReport(report, assets));
  await page.reload();
  assert.equal(await page.locator(".column").count(), 4);
  assert.equal(await page.locator(".card").count(), 0);
  assert.match(await page.locator("#summary").innerText(), /已评估 0 个 PR/u);
  assert.deepEqual(errors, []);
  assert.deepEqual(network, []);
});

test("offline v2 Issue view shows pending sources, safe unpublished drafts, search and export", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "triage-issue-browser-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ offline: true, viewport: { width: 1280, height: 900 } });
  const errors = [];
  const network = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (/^https?:/u.test(request.url())) network.push(request.url());
  });
  const report = createV2Report();
  const issue = report.issues[0];
  issue.replyDraft = "</script><script>globalThis.pwned=true</script>\n请补充脱敏信息。";
  issue.related = [{ url: report.prs[0].url, reason: "仅为关联候选，不确认重复。" }];
  issue.source = null;
  report.complete = false;
  report.errors = ["测试来源未完成核验"];
  const output = join(directory, "index.html");
  await writeFile(output, renderReport(report, assets));
  await page.goto(pathToFileURL(output).href);
  assert.equal(await page.locator("#issues-section").isVisible(), true);
  assert.equal(await page.locator("#issue-list .card").count(), 1);
  assert.match(await page.locator("#issue-list").innerText(), /未完成/u);
  assert.match(await page.locator("#board").innerText(), /已处理来源快照/u);
  await page.locator("#issue-list button").click();
  assert.equal(await page.locator("#detail-title").innerText(), issue.title);
  assert.match(await page.locator("#detail-body").innerText(), /回复草稿 · 尚未发布/u);
  assert.match(await page.locator("#detail-body").innerText(), /不是重复关单决定/u);
  assert.ok((await page.locator("#detail-body").innerText()).includes(issue.replyDraft));
  assert.equal(await page.evaluate(() => globalThis.pwned), undefined);
  assert.equal(
    await page.getByRole("link", { name: "打开 Issue ↗" }).getAttribute("href"),
    issue.url,
  );
  await page.keyboard.press("Escape");
  await page.locator("#search").fill("测试问题");
  assert.equal(await page.locator("#board .card").count(), 0);
  assert.equal(await page.locator("#issue-list .card").count(), 1);
  await page.locator("#search").fill("不存在的内容");
  assert.equal(await page.locator("#issue-list .card").count(), 0);
  await page.locator("#search").fill("");
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const downloading = page.waitForEvent("download");
  await page.locator("#export").click();
  const download = await downloading;
  assert.deepEqual(JSON.parse(await readFile(await download.path(), "utf8")), report);
  assert.deepEqual(errors, []);
  assert.deepEqual(network, []);
});
