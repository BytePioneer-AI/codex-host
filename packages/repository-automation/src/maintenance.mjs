import { collectPr, list, resolveTargets } from "./github.mjs";
import { planLabels } from "./intake.mjs";
import { findHygieneException } from "./hygiene.mjs";
import { renderReport } from "./report.mjs";
import { LABELS, githubLink, isMaintenanceComment } from "./policy.mjs";

async function readItem(github, repo, number) {
  const { data: issue } = await github.rest.issues.get({ ...repo, issue_number: number });
  if (!issue.pull_request) return { item: issue, isPr: false };
  const { data: pr } = await github.rest.pulls.get({ ...repo, pull_number: number });
  return { item: pr, isPr: true };
}

function sameSnapshot(left, right) {
  return (
    left.state === right.state &&
    right.state === "open" &&
    left.title === right.title &&
    left.body === right.body &&
    left.head?.sha === right.head?.sha &&
    left.base?.sha === right.base?.sha &&
    left.base?.ref === right.base?.ref &&
    !right.locked &&
    !right.labels.some((label) => label.name === "automation:ignore")
  );
}

async function ensureLabels(github, repo) {
  const existing = await list(github, github.rest.issues.listLabelsForRepo, repo);
  const names = new Set(existing.map((label) => label.name));
  for (const [name, [color, description]] of Object.entries(LABELS)) {
    if (names.has(name)) continue;
    try {
      await github.rest.issues.createLabel({ ...repo, name, color, description });
    } catch (error) {
      if (error.status !== 422) throw error;
      // Another maintainer may have created the label concurrently. Verify instead of swallowing validation errors.
      await github.rest.issues.getLabel({ ...repo, name });
    }
  }
}

export async function maintainItem({ github, repo, number, dryRun = false, now = Date.now() }) {
  const { item, isPr } = await readItem(github, repo, number);
  if (
    item.state !== "open" ||
    item.locked ||
    item.labels.some((label) => label.name === "automation:ignore")
  ) {
    return { number, status: "跳过（已关闭、锁定或停用）" };
  }
  // Both are required: without comments we could duplicate a report; without events we could override a human label.
  const [comments, events, prData] = await Promise.all([
    list(github, github.rest.issues.listComments, { ...repo, issue_number: number }),
    list(github, github.rest.issues.listEvents, { ...repo, issue_number: number }),
    isPr ? collectPr({ github, repo, pr: item }) : null,
  ]);
  const previous = comments.find(isMaintenanceComment);
  const labels = planLabels({
    item,
    isPr,
    events,
    commits: prData?.commits.map((commit) => commit.commit.message),
  });
  const permissions = new Map();
  const exception = isPr
    ? await findHygieneException({
        comments,
        headSha: item.head.sha,
        permissionFor: async (username) => {
          if (!permissions.has(username)) {
            try {
              const { data } = await github.rest.repos.getCollaboratorPermissionLevel({
                ...repo,
                username,
              });
              permissions.set(username, data.permission);
            } catch {
              permissions.set(username, "none");
            }
          }
          return permissions.get(username);
        },
      })
    : null;
  const body = renderReport({ item, isPr, comments, previous, prData, exception, now });
  if (dryRun) return { number, status: "预览，未写入 GitHub", labels, body };
  const labelsChanged = labels.add.length > 0 || labels.remove.length > 0;
  if (!labelsChanged && previous?.body === body)
    return { number, status: "未变化", url: item.html_url };

  const before = (await readItem(github, repo, number)).item;
  if (!sameSnapshot(item, before) || before.updated_at !== item.updated_at) {
    return { number, status: "条目已变化，跳过过期快照，等待下次刷新" };
  }
  for (const name of labels.remove)
    await github.rest.issues.removeLabel({ ...repo, issue_number: number, name });
  if (labels.add.length)
    await github.rest.issues.addLabels({ ...repo, issue_number: number, labels: labels.add });
  if (labelsChanged) {
    const latest = (await readItem(github, repo, number)).item;
    if (!sameSnapshot(item, latest)) return { number, status: "条目已变化，未更新摘要" };
  }
  if (previous?.body !== body) {
    if (previous) {
      await github.rest.issues.updateComment({ ...repo, comment_id: previous.id, body });
    } else {
      await github.rest.issues.createComment({ ...repo, issue_number: number, body });
    }
  }
  return {
    number,
    status: prData?.errors.length ? "摘要已更新，部分数据读取失败" : "已同步",
    url: item.html_url,
  };
}

export async function runMaintenance({
  github,
  context,
  core,
  number,
  dryRun = false,
  now = Date.now(),
}) {
  const repo = context.repo;
  const targets = await resolveTargets({ github, repo, context, number });
  if (!dryRun && targets.length) await ensureLabels(github, repo);
  const results = [];
  let failed = 0;
  for (const target of targets) {
    try {
      const result = await maintainItem({ github, repo, number: target, dryRun, now });
      results.push(result);
      core.info(`#${target}: ${result.status}`);
    } catch (error) {
      failed += 1;
      // Do not copy arbitrary API payloads, response headers or secrets into public comments.
      core.warning(
        `#${target}: maintenance failed (HTTP ${error.status ?? "unknown"}); no completion is claimed`,
      );
      results.push({ number: target, status: "执行失败，需要重试" });
    }
  }
  const rows = results.map(
    (result) =>
      `- #${result.number}: ${result.status}${result.url ? ` · ${githubLink(result.url)}` : ""}${result.labels ? `; labels +[${result.labels.add.join(", ")}] -[${result.labels.remove.join(", ")}]` : ""}`,
  );
  const preview =
    dryRun && number && results[0]?.body
      ? ["", "## Proposed comment (not posted)", "", results[0].body]
      : [];
  await core.summary
    .addRaw(
      [
        "## Repository maintenance",
        "",
        dryRun
          ? "Dry run: no GitHub mutations. Select one item number to preview its full comment."
          : "规则自动化；不调用模型。",
        "",
        ...rows,
        ...preview,
      ].join("\n"),
    )
    .write();
  if (failed)
    core.setFailed(
      `${failed} item(s) failed; retry by number or wait for the next scheduled sweep`,
    );
  return results;
}
