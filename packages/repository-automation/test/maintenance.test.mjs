import { describe, expect, it, vi } from "vitest";
import { maintainItem, runMaintenance } from "../index.mjs";
import { COMMENT_MARKER } from "../src/policy.mjs";
import { bot, ci, comment, head, oldHead, pr, repo } from "./fixtures.mjs";

function fixture() {
  let current = pr();
  let state = ci();
  let comments = [];
  const events = [];
  const issues = {
    get: vi.fn(async () => ({ data: { ...current, pull_request: {} } })),
    listComments: vi.fn(async () => ({ data: comments })),
    listEvents: vi.fn(async () => ({ data: events })),
    getLabel: vi.fn(async () => ({ data: {} })),
    createLabel: vi.fn(),
    addLabels: vi.fn(async ({ labels }) => {
      current = { ...current, labels: [...current.labels, ...labels.map((name) => ({ name }))] };
      events.push(...labels.map((name) => ({ event: "labeled", label: { name }, actor: bot })));
    }),
    removeLabel: vi.fn(),
    createComment: vi.fn(async ({ body }) => comments.push(comment({ id: 10, body, user: bot }))),
    updateComment: vi.fn(async ({ comment_id, body }) => {
      comments.find((c) => c.id === comment_id).body = body;
    }),
  };
  const actions = {
    getWorkflow: vi.fn(async () => ({ data: { id: 1, path: ".github/workflows/ci.yml" } })),
    listWorkflowRuns: vi.fn(async () => ({ data: [state.run] })),
    listJobsForWorkflowRun: vi.fn(async () => ({ data: state.jobs })),
    downloadJobLogsForWorkflowRun: vi.fn(async () => ({
      status: 200,
      data: "src/foo.ts(42,5): error TS2322: Type 'string' is not assignable to type 'number'.",
    })),
  };
  const github = {
    paginate: vi.fn(async (method, args) => (await method(args)).data),
    rest: {
      issues,
      actions,
      pulls: {
        get: vi.fn(async () => ({ data: current })),
        list: vi.fn(async () => ({ data: [current] })),
      },
    },
  };
  return {
    github,
    issues,
    actions,
    getComments: () => comments,
    setComments: (value) => {
      comments = value;
    },
    setPr: (value) => {
      current = value;
    },
    setCi: (value) => {
      state = value;
    },
    run: (options) => maintainItem({ github, repo, number: 7, ...options }),
  };
}

describe("PR labels and a single terminal CI result only", () => {
  it("posts success once, keeps labels, and is idempotent", async () => {
    const f = fixture();
    await f.run();
    expect(f.issues.addLabels).toHaveBeenCalledWith(expect.objectContaining({ labels: ["bug"] }));
    expect(f.getComments()[0].body).toContain("CI 全部通过。");
    expect((await f.run()).status).toBe("未变化");
    expect(f.issues.createComment).toHaveBeenCalledTimes(1);
    expect(f.issues.updateComment).not.toHaveBeenCalled();
    expect(f.actions.downloadJobLogsForWorkflowRun).not.toHaveBeenCalled();
  });
  it("classifies a title but does not comment while jobs are still running", async () => {
    const f = fixture();
    f.setCi(ci({ status: "in_progress", conclusion: null }));
    await f.run();
    expect(f.issues.addLabels).toHaveBeenCalled();
    expect(f.issues.createComment).not.toHaveBeenCalled();
  });
  it("updates the same comment on failure and recovery, quoting literal logs", async () => {
    const f = fixture();
    await f.run();
    const failure = ci({ conclusion: "failure", run_attempt: 2 });
    failure.jobs[2] = { ...failure.jobs[2], id: 3, conclusion: "failure" };
    f.setCi(failure);
    await f.run();
    expect(f.getComments()[0].body).toContain("❌ Windows CI 失败");
    expect(f.getComments()[0].body).toContain("src/foo.ts(42,5): error TS2322");
    f.setCi(ci({ run_attempt: 3 }));
    await f.run();
    expect(f.getComments()[0].body).toContain("CI 全部通过。");
    expect(f.getComments()[0].body).not.toContain("TS2322");
    expect(f.issues.createComment).toHaveBeenCalledTimes(1);
    expect(f.issues.updateComment).toHaveBeenCalledTimes(2);
  });
  it("does not adopt a contributor-forged marker, but replaces its own old verbose summary", async () => {
    const f = fixture();
    f.setComments([comment({ body: COMMENT_MARKER })]);
    await f.run();
    expect(f.issues.createComment).toHaveBeenCalled();
    expect(f.issues.updateComment).not.toHaveBeenCalled();
    f.setComments([comment({ body: `${COMMENT_MARKER}\n## 信息完整性`, user: bot })]);
    await f.run();
    expect(f.getComments()[0].body).not.toContain("信息完整性");
  });
  it("skips every Issue, regardless of old labels, headings or discussion", async () => {
    const f = fixture();
    f.issues.get.mockResolvedValue({
      data: {
        title: "[Feature] Side Chat",
        body: "## Reproduction\nOpen",
        labels: [{ name: "bug" }],
      },
    });
    expect((await f.run()).status).toContain("不是 PR");
    expect(f.github.paginate).not.toHaveBeenCalled();
    expect(f.issues.createComment).not.toHaveBeenCalled();
    expect(f.issues.addLabels).not.toHaveBeenCalled();
  });
  it.each([{ state: "closed" }, { locked: true }, { labels: [{ name: "automation:ignore" }] }])(
    "skips closed/locked/ignored PRs: %j",
    async (overrides) => {
      const f = fixture();
      f.setPr(pr(overrides));
      expect((await f.run()).status).toContain("跳过");
      expect(f.github.paginate).not.toHaveBeenCalled();
    },
  );
  it.each(["listComments", "listEvents"])("fails closed when %s is unavailable", async (method) => {
    const f = fixture();
    f.issues[method].mockRejectedValue(new Error("unavailable"));
    await expect(f.run()).rejects.toThrow("unavailable");
    expect(f.issues.createComment).not.toHaveBeenCalled();
    expect(f.issues.addLabels).not.toHaveBeenCalled();
  });
  it("never fabricates a result when the CI API fails", async () => {
    const f = fixture();
    f.actions.getWorkflow.mockRejectedValue(new Error("unavailable"));
    expect((await f.run()).status).toContain("CI 读取失败");
    expect(f.issues.createComment).not.toHaveBeenCalled();
  });
  it("rejects a changed head, title, body or closed PR before writing", async () => {
    for (const overrides of [
      { head: { sha: oldHead } },
      { title: "feat: changed" },
      { body: "changed" },
      { state: "closed" },
    ]) {
      const f = fixture();
      f.github.rest.pulls.get
        .mockResolvedValueOnce({ data: pr() })
        .mockResolvedValue({ data: pr(overrides) });
      expect((await f.run()).status).toContain("过期快照");
      expect(f.issues.addLabels).not.toHaveBeenCalled();
      expect(f.issues.createComment).not.toHaveBeenCalled();
    }
  });
  it("rejects an older run or attempt when CI changes during collection", async () => {
    for (const update of [
      { id: 43 },
      { run_attempt: 2 },
      { status: "in_progress", conclusion: null },
    ]) {
      const f = fixture();
      f.actions.listWorkflowRuns
        .mockResolvedValueOnce({ data: [ci().run] })
        .mockResolvedValue({ data: [ci(update).run] });
      expect((await f.run()).status).toContain("CI 已变化");
      expect(f.issues.createComment).not.toHaveBeenCalled();
    }
  });
  it("a manual dry run neither creates labels nor writes comments and includes the preview", async () => {
    const f = fixture();
    const core = { info: vi.fn(), summary: { addRaw: vi.fn().mockReturnThis(), write: vi.fn() } };
    await runMaintenance({
      github: f.github,
      context: {
        repo,
        eventName: "workflow_dispatch",
        ref: "refs/heads/main",
        payload: { repository: { default_branch: "main" } },
      },
      core,
      number: "7",
      dryRun: true,
    });
    for (const method of ["getLabel", "createLabel", "addLabels", "createComment", "updateComment"])
      expect(f.issues[method]).not.toHaveBeenCalled();
    expect(core.summary.addRaw).toHaveBeenCalledWith(
      expect.stringContaining("Proposed comment (not posted)"),
    );
    expect(core.summary.addRaw).toHaveBeenCalledWith(expect.stringContaining(head));
  });
});
