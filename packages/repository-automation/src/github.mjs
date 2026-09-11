import { CI_WORKFLOW } from "./policy.mjs";

export async function list(github, method, parameters) {
  return github.paginate(method, { ...parameters, per_page: 100 });
}

export function newestRun(runs) {
  return [...runs].sort(
    (a, b) =>
      (b.run_started_at ?? b.created_at).localeCompare(a.run_started_at ?? a.created_at) ||
      b.id - a.id,
  )[0];
}

export async function readCi({ github, repo, sha, release = false, pr }) {
  const { data: workflow } = await github.rest.actions.getWorkflow({
    ...repo,
    workflow_id: CI_WORKFLOW,
  });
  if (workflow.path !== ".github/workflows/ci.yml") throw new Error("Unexpected CI workflow path");
  const runs = await list(github, github.rest.actions.listWorkflowRuns, {
    ...repo,
    workflow_id: workflow.id,
    head_sha: sha,
    ...(release ? { event: "push", branch: "main" } : {}),
  });
  const eligible = runs.filter((run) => {
    if (run.workflow_id !== workflow.id || run.head_sha !== sha) return false;
    if (release) {
      return (
        run.event === "push" &&
        run.head_branch === "main" &&
        run.head_repository?.full_name === `${repo.owner}/${repo.repo}`
      );
    }
    if (run.event === "push")
      return run.head_repository?.full_name === `${repo.owner}/${repo.repo}`;
    if (run.event !== "pull_request") return false;
    if (pr && run.head_repository?.id !== pr.head.repo?.id) return false;
    return (
      !pr ||
      !run.pull_requests?.length ||
      run.pull_requests.some((candidate) => candidate.number === pr.number)
    );
  });
  const run = newestRun(eligible);
  const jobs = run
    ? await list(github, github.rest.actions.listJobsForWorkflowRun, {
        ...repo,
        run_id: run.id,
        filter: "latest",
      })
    : [];
  return { run, jobs };
}

export async function resolveTargets({ github, repo, context, number }) {
  const event = context.payload;
  if (context.eventName === "workflow_dispatch") {
    if (context.ref !== `refs/heads/${event.repository.default_branch}`) {
      throw new Error("Manual maintenance must run from the default branch");
    }
    if (number) {
      if (!/^[1-9]\d*$/u.test(String(number)) || !Number.isSafeInteger(Number(number))) {
        throw new Error("Issue / PR number must be a positive integer");
      }
      return [Number(number)];
    }
  }
  if (context.eventName === "issue_comment" && event.comment.user?.login === "github-actions[bot]")
    return [];
  if (event.issue) return [event.issue.number];
  if (context.eventName === "pull_request_target") return [event.pull_request.number];
  let sha;
  if (context.eventName === "workflow_run") {
    const { data: workflow } = await github.rest.actions.getWorkflow({
      ...repo,
      workflow_id: CI_WORKFLOW,
    });
    if (event.workflow_run.workflow_id !== workflow.id) return [];
    sha = event.workflow_run.head_sha;
  } else if (context.eventName === "status") {
    if (
      event.context !== "CodeRabbit" ||
      event.sender?.login !== "coderabbitai[bot]" ||
      event.sender?.id !== 136622811
    )
      return [];
    sha = event.sha;
  }
  if (sha) {
    // A fork CI event can have an empty pull_requests array. Reconcile against live heads.
    const prs = await list(github, github.rest.pulls.list, { ...repo, state: "open" });
    return prs.filter((pr) => pr.head.sha === sha).map((pr) => pr.number);
  }
  if (!["schedule", "workflow_dispatch"].includes(context.eventName)) return [];
  const items = await list(github, github.rest.issues.listForRepo, {
    ...repo,
    state: "open",
    sort: "created",
    direction: "asc",
  });
  return items.map((item) => item.number);
}

export async function collectPr({ github, repo, pr }) {
  const errors = [];
  async function optional(name, operation, fallback) {
    try {
      return await operation();
    } catch {
      errors.push(`${name}读取失败，不能视为已通过`);
      return fallback;
    }
  }
  const [files, commits, reviews, ci] = await Promise.all([
    optional(
      "Diff",
      () => list(github, github.rest.pulls.listFiles, { ...repo, pull_number: pr.number }),
      [],
    ),
    optional(
      "提交记录",
      () => list(github, github.rest.pulls.listCommits, { ...repo, pull_number: pr.number }),
      [],
    ),
    optional(
      "审查记录",
      () => list(github, github.rest.pulls.listReviews, { ...repo, pull_number: pr.number }),
      [],
    ),
    optional("CI", () => readCi({ github, repo, sha: pr.head.sha, pr }), {
      run: null,
      jobs: [],
      unavailable: true,
    }),
  ]);
  return { files, commits, reviews, ci, errors };
}
