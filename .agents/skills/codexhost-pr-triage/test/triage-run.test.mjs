import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { prepareRun } from "../lib/prepare-run.mjs";
import { verifyBatch } from "../lib/verify-batch.mjs";
import { updateProjectReport } from "../lib/update-report.mjs";
import { assessSelection, fakeGithub, githubRecord } from "./fixtures.mjs";

async function project(t) {
  const root = await mkdtemp(join(tmpdir(), "triage-run-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", root]);
  await writeFile(join(root, ".gitignore"), "/pr-triage/\n");
  return realpath(root);
}
const json = async (path) => JSON.parse(await readFile(path, "utf8"));

async function packet(t, records = [githubRecord(1, "pr"), githubRecord(6)]) {
  const root = await project(t);
  const github = fakeGithub(records);
  const prepared = await prepareRun({ project: root }, github);
  const selection = await json(prepared.selection);
  return { root, github, records, prepared, selection, incoming: assessSelection(selection) };
}

test("manual collection, assessment, verified publication and incremental rerun use one progress source", async (t) => {
  const root = await project(t);
  const github = fakeGithub([githubRecord(1, "pr"), githubRecord(6), githubRecord(7)]);
  const first = await prepareRun({ project: root, limit: 2 }, github);
  assert.equal(first.selected, 2);
  assert.equal(first.deferred, 1);
  await assert.rejects(lstat(join(root, "pr-triage/report.json")), { code: "ENOENT" });
  const selection = await json(first.selection);
  const result = await verifyBatch(assessSelection(selection), selection, github);
  assert.equal(result.complete, true);
  const published = await updateProjectReport(result, root);
  assert.equal(published.current.processed, 2);
  const second = await prepareRun({ project: root }, github);
  assert.equal(second.selected, 1);
  assert.equal(second.unchanged, 2);
  assert.equal((await json(second.selection)).selected[0].number, 7);
  const forced = await prepareRun({ project: root, targets: ["1"] }, github);
  assert.equal(forced.selected, 1);
  const issueOnly = await prepareRun({ project: root, type: "issue", force: true }, github);
  assert.equal(issueOnly.selected, 2);
  assert.ok(!(await readdir(join(root, "pr-triage"))).includes("state.json"));
});

test("an interrupted or failed analysis is retried; a successful product discussion is processed", async (t) => {
  const p = await packet(t);
  // Preparing twice has no checkpoint side effect.
  assert.equal((await prepareRun({ project: p.root }, p.github)).selected, 2);
  p.incoming.prs[0].verdict = "DISCUSS";
  p.incoming.prs[0].questions = ["维护者：是否需要这个产品行为？"];
  p.incoming.issues[0].source = null;
  p.incoming.complete = false;
  p.incoming.errors = ["Issue 关键材料尚未读完"];
  const result = await verifyBatch(p.incoming, p.selection, p.github);
  assert.ok(result.prs[0].source);
  assert.equal(result.issues[0].source, null);
  await updateProjectReport(result, p.root);
  const next = await prepareRun({ project: p.root }, p.github);
  assert.equal(next.selected, 1);
  assert.equal((await json(next.selection)).selected[0].kind, "issue");
  const repairedSelection = await json(next.selection);
  const repaired = await verifyBatch(
    assessSelection(repairedSelection),
    repairedSelection,
    p.github,
  );
  await updateProjectReport(repaired, p.root);
  assert.equal((await prepareRun({ project: p.root }, p.github)).selected, 0);
});

test("publication rechecks individual sources; drift and API failures never advance those checkpoints", async (t) => {
  const p = await packet(t);
  p.records[0].pull.head.sha = "c".repeat(40);
  const result = await verifyBatch(p.incoming, p.selection, p.github);
  assert.equal(result.prs[0].source, null);
  assert.ok(result.issues[0].source);
  assert.match(result.errors.join(" "), /发生变化/u);
  assert.equal(p.incoming.prs[0].source.fingerprint, p.selection.selected[0].source.fingerprint);
  await updateProjectReport(result, p.root);
  assert.equal((await prepareRun({ project: p.root }, p.github)).selected, 1);
  const next = await prepareRun({ project: p.root }, p.github);
  const selected = await json(next.selection);
  const failed = await verifyBatch(assessSelection(selected), selected, {
    get: async () => {
      throw new Error("限流");
    },
  });
  assert.equal(failed.prs[0].source, null);
  assert.match(failed.errors.join(" "), /限流/u);
});

test("missing batch results, forged fingerprints and mismatched heads cannot declare completion", async (t) => {
  const p = await packet(t);
  const missing = structuredClone(p.incoming);
  missing.issues = [];
  assert.equal((await verifyBatch(missing, p.selection, p.github)).complete, false);
  const forged = structuredClone(p.incoming);
  forged.prs[0].source.fingerprint = "f".repeat(64);
  await assert.rejects(verifyBatch(forged, p.selection, p.github), /原样/u);
  const differentHead = structuredClone(p.incoming);
  differentHead.prs[0].headSha = "f".repeat(40);
  await assert.rejects(verifyBatch(differentHead, p.selection, p.github), /HEAD\/BASE/u);
  const outside = structuredClone(p.incoming);
  outside.issues[0].number = 99;
  outside.issues[0].url = "https://github.com/example/triage-fixture/issues/99";
  await assert.rejects(verifyBatch(outside, p.selection, p.github), /选取范围/u);
});

test("draft and closed snapshots are verified skips; ready/reopened records enter again", async (t) => {
  const draft = githubRecord(1, "pr");
  draft.pull.draft = true;
  const p = await packet(t, [draft]);
  assert.equal(p.prepared.selected, 0);
  assert.equal(p.prepared.skipped, 1);
  await updateProjectReport(await verifyBatch(p.incoming, p.selection, p.github), p.root);
  assert.equal((await prepareRun({ project: p.root }, p.github)).unchanged, 1);
  draft.pull.draft = false;
  const ready = await prepareRun({ project: p.root }, p.github);
  assert.equal(ready.selected, 1);
  const selection = await json(ready.selection);
  await updateProjectReport(
    await verifyBatch(assessSelection(selection), selection, p.github),
    p.root,
  );
  draft.issue.state = "closed";
  draft.pull.merged_at = "2026-01-03T00:00:00Z";
  const closed = await prepareRun({ project: p.root }, p.github);
  assert.equal(closed.skipped, 1);
  const closeSelection = await json(closed.selection);
  const result = await verifyBatch(assessSelection(closeSelection), closeSelection, p.github);
  assert.equal(result.skipped[0].reason, "已合并");
  const output = await updateProjectReport(result, p.root);
  assert.equal((await json(output.data)).prs.length, 0);
});

test("prepare refuses corrupt/HTML-only storage, locks and unsafe run directories without resetting history", async (t) => {
  const p = await packet(t);
  const directory = join(p.root, "pr-triage");
  await writeFile(join(directory, "report.json"), "broken");
  await assert.rejects(prepareRun({ project: p.root }, p.github), /JSON|Unexpected/u);
  assert.equal(await readFile(join(directory, "report.json"), "utf8"), "broken");
  await rm(join(directory, "report.json"));
  await writeFile(join(directory, "index.html"), "history");
  await assert.rejects(prepareRun({ project: p.root }, p.github), /仅有旧 HTML/u);
  await rm(join(directory, "index.html"));
  await mkdir(join(directory, ".update-lock"));
  await assert.rejects(prepareRun({ project: p.root }, p.github), /更新锁/u);
  await rm(join(directory, ".update-lock"), { recursive: true });
  if (process.platform !== "win32") {
    await rm(join(directory, "runs"), { recursive: true });
    const other = await project(t);
    await symlink(other, join(directory, "runs"));
    await assert.rejects(prepareRun({ project: p.root }, p.github), /非本地 runs/u);
  }
});

test("CLI entry points document manual usage and reject GitHub mutation flags / unchecked progress", async (t) => {
  for (const name of ["prepare-run", "update-report"]) {
    const cli = fileURLToPath(new URL(`../scripts/${name}.mjs`, import.meta.url));
    assert.equal(spawnSync(process.execPath, [cli, "--help"]).status, 0);
    assert.equal(spawnSync(process.execPath, [cli, "--approve"]).status, 1);
  }
  const p = await packet(t);
  const input = join(p.root, "unchecked.json");
  await writeFile(input, JSON.stringify(p.incoming));
  const cli = fileURLToPath(new URL("../scripts/update-report.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [cli, input, p.root], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--selection/u);
  await assert.rejects(lstat(join(p.root, "pr-triage/report.json")), { code: "ENOENT" });
});
