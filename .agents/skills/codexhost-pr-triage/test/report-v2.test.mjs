import assert from "node:assert/strict";
import test from "node:test";
import { validateReport } from "../lib/report.mjs";
import { mergeReports, summarize } from "../lib/update-report.mjs";
import { createIssue, createReport, createV2Report } from "./fixtures.mjs";

test("v2 has distinct Issue fields, progress and follow-up without reusing PR verdicts", () => {
  const report = createV2Report();
  assert.doesNotThrow(() => validateReport(report, { requireCardSummary: true }));
  assert.equal(summarize(report).issues, 1);
  assert.equal(summarize(report).processed, 5);
  for (const field of ["category", "priority", "nextActor", "replyDraft", "source"]) {
    const invalid = structuredClone(report);
    delete invalid.issues[0][field];
    assert.throws(() => validateReport(invalid));
  }
  for (const change of [
    (r) => {
      r.issues[0].verdict = "ACCEPT";
    },
    (r) => {
      r.issues[0].category = "Model";
    },
    (r) => {
      r.issues[0].priority = "P100";
    },
    (r) => {
      r.issues[0].url = "https://github.com/example/triage-fixture/pull/6";
    },
    (r) => {
      r.issues[0].related = [{ url: "javascript:alert(1)", reason: "不可信" }];
    },
    (r) => {
      r.issues[0].source.fingerprint = "fake";
    },
    (r) => {
      r.issues[0].source.collectedAt = "yesterday";
    },
    (r) => {
      r.issues[0].evidence = [];
    },
    (r) => {
      r.issues[0].source = null;
    },
    (r) => {
      r.prs[0].verdict = "DISCUSS";
      r.prs[0].baseSha = null;
    },
  ]) {
    const invalid = structuredClone(report);
    change(invalid);
    assert.throws(() => validateReport(invalid));
  }
});

test("v1 history migrates without invented checkpoints and survives Issue updates and legacy inputs", () => {
  const old = createReport();
  const incoming = createV2Report();
  incoming.prs = [];
  incoming.skipped = [];
  let merged = mergeReports(old, incoming);
  assert.equal(merged.schemaVersion, 2);
  assert.deepEqual(merged.prs, old.prs);
  assert.equal(merged.prs[0].source, undefined);
  assert.equal(merged.issues.length, 1);
  merged = mergeReports(merged, createReport());
  assert.equal(merged.schemaVersion, 2);
  assert.equal(merged.issues.length, 1);
});

test("Issue update/skip/reopen is identity-scoped, and absence never deletes a report", () => {
  const old = createV2Report();
  const incoming = createV2Report();
  incoming.prs = [];
  incoming.issues = [];
  const issue = old.issues[0];
  incoming.skipped = [
    {
      repository: issue.repository,
      number: issue.number,
      title: issue.title,
      url: issue.url,
      kind: "issue",
      source: issue.source,
      reason: "已关闭",
    },
  ];
  const skipped = mergeReports(old, incoming);
  assert.equal(skipped.issues.length, 0);
  assert.equal(skipped.prs.length, 4);
  incoming.skipped = [];
  incoming.issues = [createIssue()];
  const reopened = mergeReports(skipped, incoming);
  assert.equal(reopened.issues.length, 1);
  assert.equal(
    reopened.skipped.some((item) => item.number === 6),
    false,
  );
  const duplicate = createV2Report();
  duplicate.issues[0].number = 1;
  duplicate.issues[0].url = "https://github.com/example/triage-fixture/issues/1";
  assert.throws(() => validateReport(duplicate), /重复/u);
});

test("older batches cannot roll back a verified per-item source", () => {
  const old = createV2Report();
  old.issues[0].source.collectedAt = "2026-01-04T00:00:00Z";
  assert.throws(() => mergeReports(old, createV2Report()), /快照早于/u);
});
