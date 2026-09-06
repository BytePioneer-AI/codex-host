import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { mergeReports, updateProjectReport } from "../lib/update-report.mjs";
import { createReport } from "./fixtures.mjs";

function batch() {
  const report = createReport();
  report.prs = report.prs.slice(0, 1);
  report.skipped = [];
  report.generatedAt = "2026-01-03T03:04:05Z";
  return report;
}

async function project(t, ignored = true) {
  const root = await mkdtemp(join(tmpdir(), "triage-update-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", root]);
  if (ignored) await writeFile(join(root, ".gitignore"), "/pr-triage/\n");
  return realpath(root);
}

test("replaces selected identities, preserves other snapshots, and does not mutate input", () => {
  const old = createReport();
  const original = structuredClone(old);
  const incoming = batch();
  incoming.prs[0].reason = "新的评估";
  const result = mergeReports(old, incoming);
  assert.equal(result.prs.length, 4);
  assert.equal(result.prs[0].reason, "新的评估");
  assert.deepEqual(result.prs[1].integration, old.prs[1].integration);
  assert.deepEqual(old, original);
  assert.deepEqual(mergeReports(result, incoming), result);
});

test("keys include repository, ignore case, and allow transitions to and from skipped", () => {
  const old = createReport();
  const incoming = batch();
  incoming.repositories = ["Example/TRIAGE-Fixture", "other/repo"];
  incoming.prs[0].repository = incoming.repositories[0];
  const foreign = {
    ...incoming.prs[0],
    repository: "other/repo",
    url: "https://github.com/other/repo/pull/1",
  };
  incoming.prs.push(foreign);
  const skipped = old.prs[1];
  incoming.skipped = [
    {
      repository: skipped.repository,
      number: skipped.number,
      title: skipped.title,
      url: skipped.url,
      reason: "已合并",
    },
  ];
  let result = mergeReports(old, incoming);
  assert.equal(result.prs.length, 4);
  assert.equal(result.skipped.length, 2);
  const revived = batch();
  revived.prs[0].number = 2;
  revived.prs[0].url = "https://github.com/example/triage-fixture/pull/2";
  result = mergeReports(result, revived);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.prs.length, 5);
});

test("preserves partial collection errors when newer records are merged", () => {
  const old = mergeReports(null, createReport());
  old.complete = false;
  old.errors = ["历史分页缺失，剩余数量未知"];
  assert.equal(mergeReports(old, batch()).complete, false);
});

test("publishes to ignored Git root, backs up exact old files, and keeps unrelated records", async (t) => {
  const root = await project(t);
  await mkdir(join(root, "nested"));
  const first = await updateProjectReport(createReport(), join(root, "nested"));
  assert.equal(first.output, join(root, "pr-triage/index.html"));
  const oldJson = await readFile(first.data, "utf8");
  const oldHtml = await readFile(first.output, "utf8");
  const next = await updateProjectReport(batch(), root);
  assert.equal(next.current.evaluated, 1);
  assert.equal(next.cumulative.evaluated, 4);
  assert.equal(await readFile(join(next.backup, "report.json"), "utf8"), oldJson);
  assert.equal(await readFile(join(next.backup, "index.html"), "utf8"), oldHtml);
  const report = JSON.parse(await readFile(next.data, "utf8"));
  const html = await readFile(next.output, "utf8");
  const embedded = JSON.parse(
    html.match(/<script id="report-data" type="application\/json">(.*?)<\/script>/s)[1],
  );
  assert.deepEqual(embedded, report);
  assert.ok(!(await readdir(join(root, "pr-triage"))).includes(".update-lock"));
});

test("refuses unignored output, corrupt JSON, HTML-only reports, and another writer's lock", async (t) => {
  const unignored = await project(t, false);
  await assert.rejects(updateProjectReport(batch(), unignored), /Git 忽略/);
  const root = await project(t);
  const dir = join(root, "pr-triage");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "report.json"), "broken");
  await assert.rejects(updateProjectReport(batch(), root), /JSON|Unexpected/);
  assert.equal(await readFile(join(dir, "report.json"), "utf8"), "broken");
  await rm(join(dir, "report.json"));
  await writeFile(join(dir, "index.html"), "old html");
  await assert.rejects(updateProjectReport(batch(), root), /仅有旧 HTML/);
  await mkdir(join(dir, ".update-lock"));
  await assert.rejects(updateProjectReport(batch(), root), /EEXIST/);
  assert.ok((await readdir(dir)).includes(".update-lock"));
});

test(
  "rejects symlink output without writing outside project",
  { skip: process.platform === "win32" },
  async (t) => {
    const root = await project(t);
    const outside = await project(t);
    await symlink(outside, join(root, "pr-triage"));
    await assert.rejects(updateProjectReport(batch(), root), /非本地目录/);
    assert.ok(!(await readdir(outside)).includes("report.json"));
  },
);
