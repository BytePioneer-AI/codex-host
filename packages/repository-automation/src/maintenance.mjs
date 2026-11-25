import { list, readCi, resolveTargets } from "./github.mjs";
import { planLabels } from "./intake.mjs";
import { ciFinished, ciFingerprint, renderReport } from "./report.mjs";
import { readJobErrors } from "./ci-logs.mjs";
import { LABELS, isMaintenanceComment } from "./policy.mjs";

function eligible(pr) {
  return (
    pr.state === "open" &&
    !pr.locked &&
    !pr.labels.some((label) => label.name === "automation:ignore")
  );
}

function sameSnapshot(left, right) {
  return (
    eligible(right) &&
    left.head.sha === right.head.sha &&
    left.base.sha === right.base.sha &&
    left.base.ref === right.base.ref &&
    left.title === right.title &&
    left.body === right.body &&
    left.updated_at === right.updated_at
  );
}

async function ensureLabel(github, repo, name) {
  try {
    await github.rest.issues.getLabel({ ...repo, name });
  } catch (error) {
    if (error.status !== 404) throw error;
    const [color, description] = LABELS[name];
    try {
      await github.rest.issues.createLabel({ ...repo, name, color, description });
    } catch (createError) {
      if (createError.status !== 422) throw createError;
      await github.rest.issues.getLabel({ ...repo, name });
    }
  }
}

export async function maintainItem({ github, repo, number, dryRun = false }) {
  const { data: issue } = await github.rest.issues.get({ ...repo, issue_number: number });
  if (!issue.pull_request) return { number, status: "跳过（不是 PR）" };
  const getPr = async () => (await github.rest.pulls.get({ ...repo, pull_number: number })).data;
  const item = await getPr();
  if (!eligible(item)) return { number, status: "跳过（已关闭、锁定或停用）" };
  // Required ownership reads fail closed; a forged marker can never be adopted.
  const [comments, events] = await Promise.all([
    list(github, github.rest.issues.listComments, { ...repo, issue_number: number }),
    list(github, github.rest.issues.listEvents, { ...repo, issue_number: number }),
  ]);
  const previous = comments.find(isMaintenanceComment);
  const labels = planLabels({ item, events });
  let ci;
  try {
    ci = await readCi({ github, repo, sha: item.head.sha, pr: item });
  } catch {
    // Independent title classification can still proceed; unavailable CI never produces a result.
  }
  let body = null;
  if (ci && ciFinished(ci)) {
    const errors = new Map();
    for (const job of ci.jobs.filter((job) => job.conclusion === "failure").slice(0, 4)) {
      errors.set(job.id, await readJobErrors({ github, repo, job }));
    }
    body = renderReport({ item, ci, errors });
  }
  if (dryRun) return { number, status: "预览，未写入 GitHub", labels, body };
  const labelsChanged = labels.add.length || labels.remove.length;
  const commentChanged = body !== null && previous?.body !== body;
  if (!labelsChanged && !commentChanged)
    return { number, status: body ? "未变化" : ci ? "等待 CI 完成" : "CI 读取失败，未评论" };
  if (!sameSnapshot(item, await getPr())) return { number, status: "PR 已变化，跳过过期快照" };
  // A rerun/new run during log download invalidates the old report, even at the same SHA.
  if (
    commentChanged &&
    ciFingerprint(ci) !==
      ciFingerprint(await readCi({ github, repo, sha: item.head.sha, pr: item }))
  )
    return { number, status: "CI 已变化，跳过过期快照" };
  for (const name of labels.add) await ensureLabel(github, repo, name);
  for (const name of labels.remove)
    await github.rest.issues.removeLabel({ ...repo, issue_number: number, name });
  if (labels.add.length)
    await github.rest.issues.addLabels({ ...repo, issue_number: number, labels: labels.add });
  if (commentChanged) {
    const fresh = await getPr();
    // Our own label writes can change updated_at, but cannot excuse a head/body/base change.
    if (
      !sameSnapshot(
        { ...item, updated_at: labelsChanged ? fresh.updated_at : item.updated_at },
        fresh,
      )
    )
      return { number, status: "PR 已变化，未评论" };
    if (previous)
      await github.rest.issues.updateComment({ ...repo, comment_id: previous.id, body });
    else await github.rest.issues.createComment({ ...repo, issue_number: number, body });
  }
  return { number, status: !ci ? "标签已同步；CI 读取失败，未评论" : "已同步" };
}

export async function runMaintenance({ github, context, core, number, dryRun = false }) {
  const repo = context.repo;
  const targets = await resolveTargets({ github, repo, context, number });
  const results = [];
  let failed = 0;
  for (const target of targets) {
    try {
      const result = await maintainItem({ github, repo, number: target, dryRun });
      results.push(result);
      core.info(`#${target}: ${result.status}`);
    } catch (error) {
      failed++;
      core.warning(`#${target}: maintenance failed (HTTP ${error.status ?? "unknown"})`);
      results.push({ number: target, status: "执行失败，需要重试" });
    }
  }
  const rows = results.map(
    (result) =>
      `- #${result.number}: ${result.status}${result.labels ? `; labels +[${result.labels.add.join(", ")}] -[${result.labels.remove.join(", ")}]` : ""}`,
  );
  const preview =
    dryRun && number && results[0]?.body
      ? ["", "## Proposed comment (not posted)", "", results[0].body]
      : [];
  await core.summary
    .addRaw(
      [
        "## PR labels and CI",
        "",
        dryRun ? "Dry run: no GitHub mutations." : "仅标题标签和 CI 结果；不调用模型。",
        "",
        ...rows,
        ...preview,
      ].join("\n"),
    )
    .write();
  if (failed) core.setFailed(`${failed} item(s) failed; retry by number`);
  return results;
}
