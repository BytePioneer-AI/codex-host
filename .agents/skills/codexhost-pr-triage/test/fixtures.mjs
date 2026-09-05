// Synthetic inputs for renderer tests only. Never used as report defaults.
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
      title: `测试 PR ${index + 1}`,
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
