import { CI_JOBS } from "../src/policy.mjs";

export const head = "a".repeat(40);
export const oldHead = "b".repeat(40);
export const now = Date.parse("2026-09-10T12:00:00Z");
export const repo = { owner: "example", repo: "codex-host" };
export const human = { login: "contributor", type: "User" };
export const bot = { login: "github-actions[bot]", type: "Bot" };
export const body = `## Summary\nFix recovery.\n## Related issues\nN/A\n## Test plan\nnpm test: passed; Desktop not tested.\n## Validated commit\n${head}`;

export function item(overrides = {}) {
  return {
    number: 7,
    title: "fix(thread): recover history",
    body,
    state: "open",
    locked: false,
    labels: [],
    user: human,
    created_at: "2026-09-01T12:00:00Z",
    updated_at: "2026-09-09T12:00:00Z",
    html_url: "https://github.com/example/codex-host/pull/7",
    ...overrides,
  };
}

export function pr(overrides = {}) {
  return item({
    head: { sha: head, repo: { id: 2 } },
    base: { sha: oldHead, ref: "main" },
    changed_files: 0,
    ...overrides,
  });
}

export function ci(overrides = {}) {
  return {
    run: {
      id: 42,
      workflow_id: 1,
      run_attempt: 1,
      event: "push",
      head_sha: head,
      head_branch: "main",
      head_repository: { full_name: "example/codex-host", id: 1 },
      status: "completed",
      conclusion: "success",
      created_at: "2026-09-09T10:00:00Z",
      html_url: "https://github.com/example/codex-host/actions/runs/42",
      ...overrides,
    },
    jobs: CI_JOBS.map((name) => ({ name, status: "completed", conclusion: "success" })),
  };
}

export function data(overrides = {}) {
  return { files: [], commits: [], reviews: [], ci: ci(), errors: [], ...overrides };
}

export function comment(overrides = {}) {
  return {
    id: 1,
    body: "A reply",
    user: human,
    created_at: "2026-09-02T12:00:00Z",
    updated_at: "2026-09-02T12:00:00Z",
    html_url: "https://github.com/example/codex-host/issues/7#issuecomment-1",
    ...overrides,
  };
}
