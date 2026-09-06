import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { CI_STATES, CONFLICT_STATES, renderReport, validateReport } from "../lib/report.mjs";
import { createReport } from "./fixtures.mjs";

const assets = Object.fromEntries(
  await Promise.all(
    [
      ["template", "report-template.html"],
      ["styles", "report.css"],
      ["script", "report.js"],
    ].map(async ([key, filename]) => [
      key,
      await readFile(new URL(`../assets/${filename}`, import.meta.url), "utf8"),
    ]),
  ),
);
const cli = fileURLToPath(new URL("../scripts/render-report.mjs", import.meta.url));

function embeddedReport(html) {
  return JSON.parse(
    html.match(/<script id="report-data" type="application\/json">([\s\S]*?)<\/script>/u)[1],
  );
}

test("all CI/conflict states preserve all four verdicts and leave input unchanged", () => {
  for (const ci of CI_STATES) {
    for (const conflict of CONFLICT_STATES) {
      const report = createReport();
      for (const pr of report.prs) Object.assign(pr.integration, { ci, conflict });
      const original = structuredClone(report);
      assert.deepEqual(embeddedReport(renderReport(report, assets)), original);
      assert.deepEqual(report, original);
    }
  }
});

test("empty, skipped-only and incomplete reports are supported without fabricated data", () => {
  const report = createReport();
  report.prs = [];
  assert.deepEqual(embeddedReport(renderReport(report, assets)), report);
  report.skipped = [];
  report.complete = false;
  report.errors = ["分页中断，未知剩余数量。"];
  assert.deepEqual(embeddedReport(renderReport(report, assets)), report);
  report.complete = true;
  assert.throws(() => validateReport(report), /report.errors/u);
});

test("missing evidence or SHA is representable only as DISCUSS with concrete questions", () => {
  const report = createReport();
  report.prs = [report.prs[2]];
  Object.assign(report.prs[0], { baseSha: null, headSha: null, stats: null, evidence: [] });
  assert.doesNotThrow(() => validateReport(report));
  report.prs[0].questions = [];
  assert.throws(() => validateReport(report), /questions/u);
  report.prs[0].verdict = "ACCEPT";
  assert.throws(() => validateReport(report), /baseSha/u);
});

test("invalid contract fields fail with field paths", () => {
  const cases = [
    [
      (r) => {
        r.schemaVersion = 2;
      },
      /schemaVersion/u,
    ],
    [
      (r) => {
        r.prs[0].verdict = "FAST-MERGE";
      },
      /verdict/u,
    ],
    [
      (r) => {
        r.prs[1].simplifications = [];
      },
      /simplifications/u,
    ],
    [
      (r) => {
        r.prs[0].evidence = [];
      },
      /evidence/u,
    ],
    [
      (r) => {
        r.prs[0].evidence = Array(6).fill(r.prs[0].evidence[0]);
      },
      /evidence/u,
    ],
    [
      (r) => {
        r.prs[0].stats.additions = -1;
      },
      /additions/u,
    ],
    [
      (r) => {
        r.prs[0].headSha = "unknown";
      },
      /headSha/u,
    ],
    [
      (r) => {
        r.prs[0].reason = "two\nlines";
      },
      /reason/u,
    ],
    [
      (r) => {
        r.prs[0].cost = " ";
      },
      /cost/u,
    ],
    [
      (r) => {
        r.generatedAt = "yesterday";
      },
      /generatedAt/u,
    ],
    [
      (r) => {
        r.prs[0].integration.ci = "greenish";
      },
      /integration.ci/u,
    ],
    [
      (r) => {
        r.prs[0].integration.conflict = "none";
      },
      /integration.conflict/u,
    ],
    [
      (r) => {
        r.complete = false;
      },
      /errors/u,
    ],
    [
      (r) => {
        r.demo = true;
      },
      /demo/u,
    ],
    [
      (r) => {
        delete r.prs[0].scope;
      },
      /scope/u,
    ],
  ];
  for (const [mutate, expected] of cases) {
    const report = createReport();
    mutate(report);
    assert.throws(() => validateReport(report), expected);
  }
});

test("PR identities are repository-scoped and unique across evaluated/skipped lists", () => {
  const report = createReport();
  const other = structuredClone(report.prs[0]);
  other.repository = "example/another-fixture";
  other.url = `https://github.com/${other.repository}/pull/${other.number}`;
  report.repositories.push(other.repository);
  report.prs.push(other);
  assert.doesNotThrow(() => validateReport(report));
  report.prs.push(structuredClone(other));
  assert.throws(() => validateReport(report), /PR 重复/u);
  report.prs.pop();
  report.skipped[0] = {
    repository: other.repository,
    number: other.number,
    title: "草稿",
    url: other.url,
    reason: "草稿",
  };
  assert.throws(() => validateReport(report), /PR 重复/u);
});

test("URL validation rejects active schemes, credentials and mismatched PR links", () => {
  for (const url of [
    "javascript:alert(1)",
    "data:text/html,test",
    "file:///etc/passwd",
    "https://user:secret@example.com/x",
  ]) {
    const report = createReport();
    report.prs[0].evidence[0].url = url;
    assert.throws(() => validateReport(report), /evidence\[0\].url/u);
  }
  for (const url of [
    "https://github.com/example/triage-fixture/pull/999",
    "https://github.com.evil.test/example/triage-fixture/pull/1",
  ]) {
    const report = createReport();
    report.prs[0].url = url;
    assert.throws(() => validateReport(report), /prs\[0\].url/u);
  }
});

test("HTML raw-text breakout and template replacement tokens remain literal data", () => {
  const report = createReport();
  report.prs[0].title =
    "</script><script>globalThis.pwned=true</script><!-- & > \u2028\u2029 $& $` $' /* REPORT_SCRIPT */ <!-- REPORT_DATA -->";
  const html = renderReport(report, assets);
  assert.deepEqual(embeddedReport(html), report);
  assert.equal(html.includes("</script><script>globalThis.pwned"), false);
  assert.equal(html.match(/<script\b/gu).length, 2);
  assert.throws(
    () =>
      renderReport(report, {
        ...assets,
        template: assets.template.replace("<!-- REPORT_DATA -->", ""),
      }),
    /占位符/u,
  );
});

test("documented JSON example matches the runtime contract", async () => {
  const documentation = await readFile(
    new URL("../references/report-format.md", import.meta.url),
    "utf8",
  );
  const example = JSON.parse(documentation.match(/```json\n([\s\S]*?)\n```/u)[1]);
  assert.doesNotThrow(() => validateReport(example));
});

test("CLI works outside the repository, emits counts, and never overwrites files", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "triage-cli-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = join(directory, "report.json");
  const output = join(directory, "index.html");
  const report = createReport();
  await writeFile(input, JSON.stringify(report));
  const result = JSON.parse(
    execFileSync(process.execPath, [cli, input, output], { cwd: directory, encoding: "utf8" }),
  );
  assert.deepEqual(result.counts, { ACCEPT: 1, SIMPLIFY: 1, DISCUSS: 1, DECLINE: 1 });
  assert.equal(result.evaluated, 4);
  assert.deepEqual(embeddedReport(await readFile(output, "utf8")), report);
  const again = spawnSync(process.execPath, [cli, input, output], { encoding: "utf8" });
  assert.equal(again.status, 1);
  assert.match(again.stderr, /EEXIST/u);
  assert.deepEqual(embeddedReport(await readFile(output, "utf8")), report);
  assert.equal(spawnSync(process.execPath, [cli, input, input]).status, 1);
  assert.deepEqual(JSON.parse(await readFile(input, "utf8")), report);
  await writeFile(input, "{not json");
  const invalidOutput = join(directory, "invalid.html");
  assert.equal(spawnSync(process.execPath, [cli, input, invalidOutput]).status, 1);
  await assert.rejects(readFile(invalidOutput), { code: "ENOENT" });
  assert.equal(spawnSync(process.execPath, [cli]).status, 1);
  assert.equal(spawnSync(process.execPath, [cli, "--help"]).status, 0);
});
