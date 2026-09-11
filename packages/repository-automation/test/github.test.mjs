import { describe, expect, it, vi } from "vitest";
import { readCi, resolveTargets } from "../src/github.mjs";
import { ci, head, oldHead, pr, repo } from "./fixtures.mjs";

function githubFixture(runs = [ci().run]) {
  const github = {
    paginate: vi.fn(async (method, args) => (await method(args)).data),
    rest: {
      actions: {
        getWorkflow: vi.fn(async () => ({ data: { id: 1, path: ".github/workflows/ci.yml" } })),
        listWorkflowRuns: vi.fn(async () => ({ data: runs })),
        listJobsForWorkflowRun: vi.fn(async () => ({ data: ci().jobs })),
      },
      issues: { listForRepo: vi.fn(async () => ({ data: [{ number: 1 }, { number: 105 }] })) },
      pulls: {
        list: vi.fn(async () => ({ data: [pr(), pr({ number: 8, head: { sha: oldHead } })] })),
      },
    },
  };
  return github;
}

describe("live CI evidence and target routing", () => {
  it("reads the real CI workflow, pages all results, and selects the newest execution", async () => {
    const github = githubFixture([
      ci().run,
      ci({ id: 43, conclusion: "failure", created_at: "2026-09-10T12:00:00Z" }).run,
    ]);
    const result = await readCi({ github, repo, sha: head, release: true });
    expect(result.run.id).toBe(43);
    expect(result.run.conclusion).toBe("failure");
    expect(github.rest.actions.listWorkflowRuns).toHaveBeenCalledWith(
      expect.objectContaining({
        workflow_id: 1,
        head_sha: head,
        event: "push",
        branch: "main",
        per_page: 100,
      }),
    );
    expect(github.rest.actions.listJobsForWorkflowRun).toHaveBeenCalledWith(
      expect.objectContaining({ run_id: 43, filter: "latest", per_page: 100 }),
    );
  });

  it("does not use foreign workflows, fork pushes, another commit, or PR CI as release evidence", async () => {
    const invalid = [
      ci({ workflow_id: 99 }).run,
      ci({ head_repository: { full_name: "fork/codex-host" } }).run,
      ci({ head_sha: oldHead }).run,
      ci({ event: "pull_request" }).run,
    ];
    const github = githubFixture(invalid);
    expect((await readCi({ github, repo, sha: head, release: true })).run).toBeUndefined();
    expect(github.rest.actions.listJobsForWorkflowRun).not.toHaveBeenCalled();
  });

  it("matches fork PR CI by head repository even when GitHub has no associated PR array", async () => {
    const github = githubFixture([
      ci({ event: "pull_request", head_repository: { id: 2 }, pull_requests: [] }).run,
    ]);
    expect((await readCi({ github, repo, sha: head, pr: pr() })).run.id).toBe(42);
    expect(
      (await readCi({ github, repo, sha: head, pr: pr({ head: { sha: head, repo: { id: 3 } } }) }))
        .run,
    ).toBeUndefined();
  });

  it("propagates API failures rather than fabricating green status", async () => {
    const github = githubFixture();
    github.rest.actions.getWorkflow.mockRejectedValue(new Error("unavailable"));
    await expect(readCi({ github, repo, sha: head })).rejects.toThrow("unavailable");
  });

  it("uses a paginated open-PR list for manual reconciliation, never Issues", async () => {
    const github = githubFixture();
    const result = await resolveTargets({
      github,
      repo,
      context: {
        eventName: "workflow_dispatch",
        ref: "refs/heads/main",
        payload: { repository: { default_branch: "main" } },
      },
    });
    expect(result).toEqual([7, 8]);
    expect(github.rest.issues.listForRepo).not.toHaveBeenCalled();
    expect(github.rest.pulls.list).toHaveBeenCalledWith(
      expect.objectContaining({ state: "open", per_page: 100 }),
    );
  });

  it("rejects branch-selected dispatches and malformed user numbers before listing data", async () => {
    const github = githubFixture();
    const context = {
      eventName: "workflow_dispatch",
      ref: "refs/heads/feature",
      payload: { repository: { default_branch: "main" } },
    };
    await expect(resolveTargets({ github, repo, context, number: "7" })).rejects.toThrow(
      "default branch",
    );
    context.ref = "refs/heads/main";
    for (const number of ["-1", "1; echo token", "0", "1e3", "9007199254740992"]) {
      await expect(resolveTargets({ github, repo, context, number })).rejects.toThrow(
        "positive integer",
      );
    }
    expect(await resolveTargets({ github, repo, context, number: "7" })).toEqual([7]);
    expect(github.paginate).not.toHaveBeenCalled();
  });

  it("never reacts to discussion comments or CodeRabbit statuses", async () => {
    const github = githubFixture();
    expect(
      await resolveTargets({
        github,
        repo,
        context: {
          eventName: "issue_comment",
          payload: { issue: { number: 7 }, comment: { user: { login: "github-actions[bot]" } } },
        },
      }),
    ).toEqual([]);
    expect(
      await resolveTargets({
        github,
        repo,
        context: {
          eventName: "status",
          payload: {
            context: "CodeRabbit",
            sha: head,
            sender: { login: "coderabbitai[bot]", id: 5 },
          },
        },
      }),
    ).toEqual([]);
    expect(
      await resolveTargets({
        github,
        repo,
        context: {
          eventName: "status",
          payload: {
            context: "CodeRabbit",
            sha: head,
            sender: { login: "coderabbitai[bot]", id: 136622811 },
          },
        },
      }),
    ).toEqual([]);
  });

  it("reconciles workflow_run by live head instead of trusting payload PR numbers or workflow names", async () => {
    const github = githubFixture();
    const context = {
      eventName: "workflow_run",
      payload: { workflow_run: { workflow_id: 1, head_sha: head, pull_requests: [] } },
    };
    expect(await resolveTargets({ github, repo, context })).toEqual([7]);
    context.payload.workflow_run.workflow_id = 9;
    expect(await resolveTargets({ github, repo, context })).toEqual([]);
  });
});
