import assert from "node:assert/strict";
import test from "node:test";
import { parseTarget, selectBatch, snapshotItem } from "../lib/incremental.mjs";
import { collectCandidates, paginate, readItem } from "../lib/github.mjs";
import { createReport, createV2Report, fakeGithub, githubRecord } from "./fixtures.mjs";

const repository = "example/triage-fixture";
const snapshot = (record) => snapshotItem(record, "2026-01-02T03:04:05Z");

test("targets preserve repository and kind, reject arbitrary hosts, credentials, paths and options", () => {
  assert.deepEqual(parseTarget("123", repository), { repository, number: 123 });
  assert.deepEqual(parseTarget("https://github.com/another/repo/issues/123", repository), {
    repository: "another/repo",
    number: 123,
    kind: "issue",
  });
  for (const value of [
    "0",
    "-1",
    "--approve",
    "9007199254740992",
    "https://evil.test/a/b/pull/1",
    "https://user:pass@github.com/a/b/pull/1",
    "https://github.com/a/b/issues/1?x=y",
    "https://github.com/a/b/pull/1#discussion",
    "https://github.com/a/b/actions/1",
  ])
    assert.throws(() => parseTarget(value, repository));
  assert.throws(() => parseTarget("1", "../repo"));
});

test("fingerprints track edits, replies, reviews, head, base and reopening, but not collection time or CI", () => {
  const record = githubRecord(1, "pr");
  const first = snapshot(record);
  assert.equal(snapshotItem(record).source.fingerprint, first.source.fingerprint);
  assert.equal(
    snapshot({ ...record, pull: { ...record.pull, ci: "failure" } }).source.fingerprint,
    first.source.fingerprint,
  );
  const changes = [
    (item) => {
      item.issue.body += "更新";
    },
    (item) => {
      item.issue.title += "编辑";
    },
    (item) => {
      item.issue.state = "closed";
    },
    (item) => {
      item.pull.draft = true;
    },
    (item) => {
      item.pull.head.sha = "c".repeat(40);
    },
    (item) => {
      item.pull.base.sha = "d".repeat(40);
    },
    (item) => {
      item.pull.base.ref = "another";
    },
    (item) => {
      item.comments.push({ id: 1, body: "补充", updated_at: "2026-01-02T04:00:00Z" });
    },
    (item) => {
      item.reviews.push({
        id: 1,
        body: "反馈",
        state: "COMMENTED",
        submitted_at: "2026-01-02T04:00:00Z",
      });
    },
    (item) => {
      item.reviewComments.push({
        id: 1,
        body: "行级反馈",
        updated_at: "2026-01-02T04:00:00Z",
        path: "src/a.ts",
      });
    },
  ];
  for (const change of changes) {
    const next = structuredClone(record);
    change(next);
    assert.notEqual(snapshot(next).source.fingerprint, first.source.fingerprint);
  }
  record.comments = [{ id: 1, body: "旧内容", updated_at: "2026-01-02T04:00:00Z" }];
  const beforeEdit = snapshot(record);
  record.comments[0].body = "编辑已有评论，父条目时间未变";
  assert.notEqual(snapshot(record).source.fingerprint, beforeEdit.source.fingerprint);
  record.reviews = [{ id: 2, body: "", state: "APPROVED", submitted_at: "2026-01-02T04:00:00Z" }];
  const beforeDismissal = snapshot(record);
  record.reviews[0].state = "DISMISSED";
  assert.notEqual(snapshot(record).source.fingerprint, beforeDismissal.source.fingerprint);
});

test("fingerprints are stable under label and discussion order, and malformed core data fails closed", () => {
  const record = githubRecord();
  record.issue.labels = [{ name: "bug" }, { name: "needs-triage" }];
  record.comments = [1, 2].map((id) => ({ id, body: `${id}`, updated_at: "2026-01-02T04:00:00Z" }));
  const first = snapshot(record);
  record.issue.labels.reverse();
  record.comments.reverse();
  assert.equal(snapshot(record).source.fingerprint, first.source.fingerprint);
  record.comments[0].body = undefined;
  assert.throws(() => snapshot(record), /核心材料/u);
  const pr = githubRecord(1, "pr");
  pr.pull.head.sha = "short";
  assert.throws(() => snapshot(pr), /HEAD/u);
});

test("incremental selection skips unchanged, retries null/legacy snapshots, limits batches and supports force", () => {
  const old = createV2Report();
  const items = [
    snapshot(githubRecord(1, "pr")),
    snapshot(githubRecord()),
    snapshot(githubRecord(10)),
  ];
  const original = structuredClone(old);
  let result = selectBatch(items, old);
  assert.deepEqual(
    result.selected.map((item) => item.number),
    [10],
  );
  assert.equal(result.unchanged.length, 2);
  result = selectBatch(items, old, { force: true, limit: 1 });
  assert.equal(result.selected.length, 1);
  assert.equal(result.deferred.length, 2);
  assert.equal(selectBatch(items, old, { type: "pr", force: true }).selected.length, 1);
  assert.deepEqual(old, original);
  old.issues[0].source = null;
  old.complete = false;
  old.errors = ["Issue 尚未完成"];
  assert.deepEqual(
    selectBatch(items, old).selected.map((item) => item.number),
    [6, 10],
  );
  assert.equal(selectBatch(items, createReport()).selected.length, 3);
  assert.throws(() => selectBatch(items, old, { limit: 0 }), /limit/u);
  assert.throws(() => selectBatch(items, old, { type: "invalid" }), /type/u);
  assert.throws(() => selectBatch([...items, items[0]], old), /重复/u);
});

test("draft/closed items do not consume the analysis limit; reopened and ready items re-enter", () => {
  const draft = githubRecord(5, "pr");
  draft.pull.draft = true;
  const closed = githubRecord(6);
  closed.issue.state = "closed";
  const active = githubRecord(7);
  const result = selectBatch([draft, closed, active].map(snapshot), null, { limit: 1 });
  assert.equal(result.selected[0].number, 7);
  assert.equal(result.skipped.length, 2);
  draft.pull.draft = false;
  closed.issue.state = "open";
  assert.equal(selectBatch([draft, closed].map(snapshot), null).selected.length, 2);
});

test("identity includes repository and GitHub's shared Issue/PR number namespace", () => {
  const other = snapshot(githubRecord(1, "pr", "other/repo"));
  assert.equal(selectBatch([other], createV2Report()).selected.length, 1);
  const upper = snapshot(githubRecord(1, "pr", "Example/TRIAGE-Fixture"));
  assert.equal(selectBatch([upper], createV2Report()).unchanged.length, 1);
});

test("collection paginates past 100, never writes and retains partial list evidence", async () => {
  const records = Array.from({ length: 101 }, (_, index) => githubRecord(index + 1));
  const github = fakeGithub(records);
  const all = await collectCandidates(github, { repository });
  assert.equal(all.items.length, 101);
  assert.deepEqual(all.errors, []);
  assert.ok(github.calls.some((path) => path.includes("page=2")));
  const get = github.get;
  github.get = (path) => {
    if (path.includes("state=open") && path.includes("page=2")) throw new Error("限流");
    return get(path);
  };
  const partial = await collectCandidates(github, { repository });
  assert.equal(partial.items.length, 100);
  assert.match(partial.errors[0], /剩余数量未知/u);
  const malformed = await paginate({ get: async () => ({ items: [] }) }, "repos/a/b/issues");
  assert.match(malformed.error, /不是数组/u);
});

test("explicit URLs are not truncated to local IDs; discussion page failures remain unprocessed", async () => {
  const record = githubRecord(1, "pr", "other/repo");
  const github = fakeGithub([record]);
  const target = parseTarget("https://github.com/other/repo/pull/1", repository);
  const result = await collectCandidates(github, { repository, targets: [target, target] });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].repository, "other/repo");
  const get = github.get;
  github.get = (path) =>
    path.includes("/reviews?") ? Promise.reject(new Error("评论分页失败")) : get(path);
  await assert.rejects(readItem(github, target), /评论分页失败/u);
  const failed = await collectCandidates(github, { repository, targets: [target] });
  assert.equal(failed.items.length, 0);
  assert.match(failed.errors[0], /未完成采集/u);
});

test("repository aliases are deduplicated case-insensitively and bare target type mismatches are explicit", async () => {
  const github = fakeGithub([githubRecord(1, "pr")]);
  const result = await collectCandidates(github, {
    repository,
    targets: [parseTarget("https://github.com/Example/TRIAGE-Fixture/pull/1", repository)],
  });
  assert.equal(result.repositories.length, 1);
  assert.equal(result.items.length, 1);
  const mismatch = await collectCandidates(github, {
    repository,
    type: "issue",
    targets: [parseTarget("1", repository)],
  });
  assert.equal(mismatch.items.length, 0);
  assert.match(mismatch.errors.join(" "), /--type 不一致/u);
});

test("missing historical items are explicitly re-read before reporting closure", async () => {
  const record = githubRecord(1, "pr");
  record.issue.state = "closed";
  record.pull.merged_at = "2026-01-03T00:00:00Z";
  const old = createReport();
  old.prs = [old.prs[0]];
  old.skipped = [];
  const github = fakeGithub([record]);
  const result = await collectCandidates(github, { repository, previous: old });
  assert.equal(result.items[0].merged, true);
  assert.ok(github.calls.includes(`repos/${repository}/issues/1`));
  const missing = await collectCandidates(fakeGithub([]), { repository, previous: old });
  assert.equal(missing.items.length, 0);
  assert.match(missing.errors[0], /未完成采集/u);
});
