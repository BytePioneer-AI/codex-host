import { snapshotItem } from "../lib/incremental.mjs";

// Synthetic inputs for tests only. Never used as report defaults.
export function createReport() {
  const repository = "example/triage-fixture";
  const generatedAt = "2026-01-02T03:04:05Z";
  return {
    schemaVersion: 1,
    generatedAt,
    repositories: [repository],
    scope: "自动测试用虚构数据，不是真实 PR 评估",
    complete: true,
    errors: [],
    prs: ["ACCEPT", "SIMPLIFY", "DISCUSS", "DECLINE"].map((verdict, index) => ({
      repository,
      number: index + 1,
      title: `测试功能 ${index + 1}`,
      originalTitle: `test: fixture PR ${index + 1}`,
      effect: "测试用户可见作用。",
      url: `https://github.com/${repository}/pull/${index + 1}`,
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      verdict,
      reason: "仅用于验证数据渲染。",
      value: "测试价值说明。",
      scope: "测试实现范围。",
      cost: "测试维护代价。",
      action: "测试下一步动作。",
      stats: { files: 3, additions: 10, deletions: 2 },
      integration: {
        ci: "fail",
        conflict: "conflicting",
        collectedAt: generatedAt,
        note: "模拟失败与冲突，不改变建议。",
      },
      evidence: [
        {
          label: "src/example.ts",
          url: `https://github.com/${repository}/blob/${"b".repeat(40)}/src/example.ts#L1`,
          revision: "b".repeat(40),
          detail: "虚构文件证据，仅供测试。",
        },
      ],
      questions: verdict === "DISCUSS" ? ["维护者：请补充测试场景。"] : [],
      simplifications: verdict === "SIMPLIFY" ? ["测试精简建议：删除重复配置。"] : [],
    })),
    skipped: [
      {
        repository,
        number: 5,
        title: "测试草稿",
        url: `https://github.com/${repository}/pull/5`,
        reason: "草稿",
      },
    ],
  };
}

export function githubRecord(number = 6, kind = "issue", repository = "example/triage-fixture") {
  return {
    repository,
    issue: {
      number,
      title: `test: fixture ${kind === "pr" ? "PR" : "Issue"} ${number}`,
      body: "测试报告正文，不是真实问题。",
      state: "open",
      updated_at: "2026-01-02T03:04:05Z",
      labels: [],
      ...(kind === "pr" ? { pull_request: {} } : {}),
    },
    pull:
      kind === "pr"
        ? {
            number,
            draft: false,
            merged_at: null,
            base: { ref: "main", sha: "a".repeat(40) },
            head: { sha: "b".repeat(40) },
          }
        : null,
    comments: [],
    reviews: [],
    reviewComments: [],
  };
}

export function createIssue(item = snapshotItem(githubRecord(), "2026-01-02T03:04:05Z")) {
  return {
    repository: item.repository,
    number: item.number,
    title: "测试问题",
    originalTitle: item.title,
    url: item.url,
    summary: "测试症状，尚未实机验证。",
    category: "bug",
    priority: "normal",
    reason: "正文已描述现象，需要维护者核验。",
    action: "核验复现步骤。",
    nextActor: "维护者",
    replyDraft: "感谢报告。我们将核验复现步骤。",
    missingInfo: [],
    related: [],
    evidence: [
      {
        label: "Issue 正文",
        url: item.url,
        revision: item.updatedAt,
        detail: "测试报告中的用户描述。",
      },
    ],
    source: item.source,
  };
}

export function createV2Report() {
  const report = createReport();
  report.schemaVersion = 2;
  report.issues = [createIssue()];
  for (const pr of report.prs)
    Object.assign(pr, {
      source: snapshotItem(githubRecord(pr.number, "pr"), report.generatedAt).source,
      nextActor: "维护者",
      replyDraft: "测试回复草稿，尚未发布。",
    });
  report.skipped[0].kind = "pr";
  return report;
}

export function assessSelection(selection) {
  const report = {
    schemaVersion: 2,
    generatedAt: selection.generatedAt,
    repositories: selection.repositories,
    scope: selection.scope,
    complete: selection.errors.length === 0,
    errors: [...selection.errors],
    prs: [],
    issues: [],
    skipped: [],
  };
  for (const item of selection.selected) {
    if (item.kind === "issue") report.issues.push(createIssue(item));
    else
      report.prs.push({
        ...createReport().prs[0],
        repository: item.repository,
        number: item.number,
        url: item.url,
        originalTitle: item.title,
        baseSha: item.baseSha,
        headSha: item.headSha,
        source: item.source,
        nextActor: "维护者",
        replyDraft: "测试回复草稿。",
      });
  }
  for (const item of selection.skipped)
    report.skipped.push({
      repository: item.repository,
      number: item.number,
      kind: item.kind,
      title: item.title,
      url: item.url,
      reason: item.draft ? "草稿" : "已关闭",
      source: item.source,
    });
  return report;
}

export function fakeGithub(records) {
  const calls = [];
  return {
    calls,
    async authenticate() {},
    async repository() {
      return "example/triage-fixture";
    },
    async get(path) {
      calls.push(path);
      const url = new URL(`https://api.github.com/${path}`);
      const match = url.pathname.match(
        /^\/repos\/([^/]+\/[^/]+)\/(issues|pulls)(?:\/(\d+)(?:\/(comments|reviews))?)?$/u,
      );
      assertFixture(match, path);
      const [, repository, resource, number, subresource] = match;
      const candidates = records.filter(
        (item) => item.repository.toLowerCase() === repository.toLowerCase(),
      );
      const page = Number(url.searchParams.get("page") ?? "1");
      const slice = (entries) => structuredClone(entries.slice((page - 1) * 100, page * 100));
      if (!number)
        return slice(
          candidates.filter((item) => item.issue.state === "open").map((item) => item.issue),
        );
      const record = candidates.find((item) => item.issue.number === Number(number));
      assertFixture(record, path);
      if (subresource === "reviews") return slice(record.reviews);
      if (subresource === "comments")
        return slice(resource === "issues" ? record.comments : record.reviewComments);
      return structuredClone(resource === "issues" ? record.issue : record.pull);
    },
  };
}

function assertFixture(value, path) {
  if (!value) throw new Error(`测试没有此 GitHub 数据：${path}`);
}
