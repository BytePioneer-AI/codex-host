import { describe, expect, it, vi } from "vitest";
import { maintainItem, runMaintenance } from "../index.mjs";
import { LABELS } from "../src/policy.mjs";
import { bot, ci, comment, head, item, now, oldHead, pr, repo } from "./fixtures.mjs";

function fixture({ pull = false } = {}) {
  let current = pull
    ? pr()
    : item({
        title: "[Feature] Improve",
        body: "### Area\nDesktop / Renderer\n### Summary\nImprove navigation",
      });
  let comments = [];
  const response = (value) => ({ data: value });
  const github = {
    paginate: vi.fn(async (method, args) => (await method(args)).data),
    rest: {
      issues: {
        get: vi.fn(async () => response({ ...current, ...(pull ? { pull_request: {} } : {}) })),
        listComments: vi.fn(async () => response(comments)),
        listEvents: vi.fn(async () => response([])),
        listForRepo: vi.fn(async () => response([current])),
        listLabelsForRepo: vi.fn(async () =>
          response(Object.keys(LABELS).map((name) => ({ name }))),
        ),
        createLabel: vi.fn(),
        getLabel: vi.fn(),
        addLabels: vi.fn(async ({ labels }) => {
          current = {
            ...current,
            labels: [...current.labels, ...labels.map((name) => ({ name }))],
          };
        }),
        removeLabel: vi.fn(async ({ name }) => {
          current = { ...current, labels: current.labels.filter((label) => label.name !== name) };
        }),
        createComment: vi.fn(async ({ body }) => {
          comments.push(
            comment({ id: 100, user: bot, body, updated_at: new Date(now).toISOString() }),
          );
          current = { ...current, updated_at: new Date(now).toISOString() };
        }),
        updateComment: vi.fn(async ({ comment_id, body }) => {
          comments = comments.map((entry) =>
            entry.id === comment_id ? { ...entry, body } : entry,
          );
        }),
      },
      pulls: {
        get: vi.fn(async () => response(current)),
        listFiles: vi.fn(async () => response([])),
        listCommits: vi.fn(async () => response([])),
        listReviews: vi.fn(async () => response([])),
      },
      repos: {
        getCollaboratorPermissionLevel: vi.fn(async () => response({ permission: "read" })),
      },
      actions: {
        getWorkflow: vi.fn(async () => response({ id: 1, path: ".github/workflows/ci.yml" })),
        listWorkflowRuns: vi.fn(async () => response([ci().run])),
        listJobsForWorkflowRun: vi.fn(async () => response(ci().jobs)),
      },
    },
  };
  return {
    github,
    setCurrent: (value) => {
      current = value;
    },
    setComments: (value) => {
      comments = value;
    },
    getComments: () => comments,
    run: (options = {}) => maintainItem({ github, repo, number: 7, now, ...options }),
  };
}

describe("maintenance orchestration", () => {
  it("adds rule-derived labels and creates exactly one summary; replay is a no-op", async () => {
    const f = fixture();
    await f.run();
    expect(f.github.rest.issues.addLabels).toHaveBeenCalledWith(
      expect.objectContaining({ labels: ["enhancement", "area:desktop"] }),
    );
    expect(f.github.rest.issues.createComment).toHaveBeenCalledTimes(1);
    await f.run();
    expect(f.github.rest.issues.createComment).toHaveBeenCalledTimes(1);
    expect(f.github.rest.issues.updateComment).not.toHaveBeenCalled();
  });

  it("updates the same comment on a new head and warns about stale evidence", async () => {
    const f = fixture({ pull: true });
    await f.run();
    f.setCurrent(pr({ head: { sha: oldHead, repo: { id: 2 } } }));
    await f.run();
    expect(f.github.rest.issues.createComment).toHaveBeenCalledTimes(1);
    expect(f.github.rest.issues.updateComment).toHaveBeenCalledTimes(1);
    expect(f.getComments()[0].body).toContain("测试声明绑定旧提交");
    expect(f.getComments()[0].body).toContain("HEAD 已变化");
  });

  it("offers a fully read-only dry run including proposed labels and report", async () => {
    const f = fixture();
    const result = await f.run({ dryRun: true });
    expect(result.body).toContain("信息完整性");
    expect(result.labels.add).toContain("enhancement");
    expect(f.github.rest.issues.addLabels).not.toHaveBeenCalled();
    expect(f.github.rest.issues.createComment).not.toHaveBeenCalled();
  });

  it("keeps a manual dry run read-only and exposes the selected comment preview", async () => {
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
      now,
    });
    expect(f.github.rest.issues.listLabelsForRepo).not.toHaveBeenCalled();
    expect(f.github.rest.issues.createLabel).not.toHaveBeenCalled();
    expect(f.github.rest.issues.addLabels).not.toHaveBeenCalled();
    expect(f.github.rest.issues.createComment).not.toHaveBeenCalled();
    expect(core.summary.addRaw).toHaveBeenCalledWith(
      expect.stringContaining("Proposed comment (not posted)"),
    );
    expect(core.summary.addRaw).toHaveBeenCalledWith(expect.stringContaining("信息完整性"));
  });

  it("cannot adopt or edit a marker forged by a contributor", async () => {
    const f = fixture();
    const preview = await f.run({ dryRun: true });
    f.setComments([comment({ body: preview.body })]);
    await f.run();
    expect(f.github.rest.issues.updateComment).not.toHaveBeenCalled();
    expect(f.github.rest.issues.createComment).toHaveBeenCalledTimes(1);
  });

  it("skips closed, locked and explicitly ignored items without side effects", async () => {
    for (const overrides of [
      { state: "closed" },
      { locked: true },
      { labels: [{ name: "automation:ignore" }] },
    ]) {
      const f = fixture();
      f.setCurrent(item(overrides));
      expect((await f.run()).status).toContain("跳过");
      expect(f.github.paginate).not.toHaveBeenCalled();
      expect(f.github.rest.issues.createComment).not.toHaveBeenCalled();
    }
  });

  it("does not write a snapshot when the head or body changes during collection", async () => {
    for (const changed of [
      pr({ head: { sha: oldHead } }),
      pr({ body: "new description" }),
      pr({ state: "closed" }),
    ]) {
      const f = fixture({ pull: true });
      f.github.rest.pulls.get
        .mockResolvedValueOnce({ data: pr() })
        .mockResolvedValue({ data: changed });
      expect((await f.run()).status).toContain("过期快照");
      expect(f.github.rest.issues.createComment).not.toHaveBeenCalled();
      expect(f.github.rest.issues.addLabels).not.toHaveBeenCalled();
    }
  });

  it("fails closed when comment or label ownership history cannot be read", async () => {
    for (const method of ["listComments", "listEvents"]) {
      const f = fixture();
      f.github.rest.issues[method].mockRejectedValue(new Error("API unavailable"));
      await expect(f.run()).rejects.toThrow("API unavailable");
      expect(f.github.rest.issues.createComment).not.toHaveBeenCalled();
      expect(f.github.rest.issues.addLabels).not.toHaveBeenCalled();
    }
  });

  it("reports partial CI/review failures as unknown rather than green", async () => {
    const f = fixture({ pull: true });
    f.github.rest.actions.getWorkflow.mockRejectedValue(new Error("API unavailable"));
    f.github.rest.pulls.listReviews.mockRejectedValue(new Error("API unavailable"));
    await f.run();
    expect(f.getComments()[0].body).toContain("CI 状态读取失败");
    expect(f.getComments()[0].body).toContain("审查记录读取失败");
  });

  it("rechecks exception permissions and does not let a contributor waive findings", async () => {
    const f = fixture({ pull: true });
    f.setCurrent(pr({ changed_files: 1 }));
    f.github.rest.pulls.listFiles.mockResolvedValue({
      data: [
        {
          filename: "tests/x.test.ts",
          status: "modified",
          additions: 1,
          patch: "@@ -1,0 +1,1 @@\n+test.only('x', () => {});",
        },
      ],
    });
    f.setComments([comment({ body: `/codexhost hygiene-exception ${head} intentional fixture` })]);
    await f.run();
    expect(f.github.rest.repos.getCollaboratorPermissionLevel).toHaveBeenCalledWith(
      expect.objectContaining({ username: "contributor" }),
    );
    expect(f.getComments().at(-1).body).not.toContain("已为当前 HEAD 记录例外");
    expect(f.getComments().at(-1).body).toContain("tests/x.test.ts:1");
    f.github.rest.repos.getCollaboratorPermissionLevel.mockResolvedValue({
      data: { permission: "write" },
    });
    await f.run();
    expect(f.getComments().at(-1).body).toContain("已为当前 HEAD 记录例外");
  });

  it("runs a paginated sweep and keeps a failed item eligible for later retry", async () => {
    const f = fixture();
    const core = {
      info: vi.fn(),
      warning: vi.fn(),
      setFailed: vi.fn(),
      summary: { addRaw: vi.fn().mockReturnThis(), write: vi.fn() },
    };
    f.github.rest.issues.listComments.mockRejectedValueOnce(new Error("temporary"));
    const options = {
      github: f.github,
      repo,
      context: { repo, eventName: "schedule", payload: {} },
      core,
      now,
    };
    const first = await runMaintenance(options);
    expect(first[0].status).toContain("执行失败");
    expect(core.setFailed).toHaveBeenCalled();
    expect((await runMaintenance(options))[0].status).toBe("已同步");
  });
});
