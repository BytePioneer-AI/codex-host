import { createHash } from "node:crypto";
import { itemIdentity, validateReport } from "./report.mjs";

export function parseTarget(value, repository) {
  let kind;
  let number;
  if (/^\d+$/u.test(value)) number = Number(value);
  else {
    const url = new URL(value);
    const match = url.pathname.match(/^\/([^/]+\/[^/]+)\/(pull|issues)\/(\d+)\/?$/u);
    if (
      url.origin !== "https://github.com" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !match
    )
      throw new Error(`不是 GitHub Issue/PR URL：${value}`);
    repository = match[1];
    kind = match[2] === "pull" ? "pr" : "issue";
    number = Number(match[3]);
  }
  if (
    !/^[a-z\d][a-z\d-]*\/[a-z\d_.-]+$/iu.test(repository) ||
    [".", ".."].includes(repository.split("/")[1]) ||
    !Number.isSafeInteger(number) ||
    number < 1
  )
    throw new Error(`条目身份无效：${value}`);
  return { repository, number, ...(kind ? { kind } : {}) };
}

function requireValue(condition, message) {
  if (!condition) throw new Error(`GitHub 核心材料不完整：${message}`);
}

function discussion(entries, review = false) {
  requireValue(Array.isArray(entries), "讨论列表");
  return entries
    .map((entry) => {
      requireValue(
        Number.isSafeInteger(entry.id) && typeof entry.body === "string",
        "讨论 ID / 正文",
      );
      requireValue(
        review ? typeof entry.state === "string" : typeof entry.updated_at === "string",
        "讨论版本",
      );
      return {
        id: entry.id,
        body: entry.body,
        author: entry.user?.login ?? null,
        url: entry.html_url ?? null,
        updatedAt: entry.updated_at ?? entry.submitted_at ?? null,
        ...(review ? { state: entry.state, commit: entry.commit_id ?? null } : {}),
        ...(entry.path
          ? { path: entry.path, commit: entry.commit_id ?? null, line: entry.line ?? null }
          : {}),
      };
    })
    .sort((a, b) => a.id - b.id);
}

/** A content fingerprint, not a last-run timestamp. CI is intentionally outside value triage. */
export function snapshotItem(
  { repository, issue, pull = null, comments, reviews = [], reviewComments = [] },
  collectedAt = new Date().toISOString(),
) {
  requireValue(
    issue &&
      typeof issue.title === "string" &&
      typeof issue.updated_at === "string" &&
      Number.isFinite(Date.parse(issue.updated_at)) &&
      ["open", "closed"].includes(issue.state) &&
      (issue.body === null || typeof issue.body === "string") &&
      Array.isArray(issue.labels),
    "Issue 元数据",
  );
  const target = parseTarget(String(issue.number), repository);
  const kind = issue.pull_request ? "pr" : "issue";
  requireValue(kind === "issue" || pull !== null, "PR 元数据");
  if (pull) {
    requireValue(
      kind === "pr" &&
        pull.number === issue.number &&
        typeof pull.draft === "boolean" &&
        typeof pull.base?.ref === "string" &&
        [pull.head?.sha, pull.base?.sha].every(
          (sha) => typeof sha === "string" && /^(?:[a-f\d]{40}|[a-f\d]{64})$/iu.test(sha),
        ),
      "PR HEAD / BASE",
    );
  }
  const labels = issue.labels.map((label) => (typeof label === "string" ? label : label?.name));
  requireValue(
    labels.every((label) => typeof label === "string" && label.length > 0),
    "标签列表",
  );
  const metadata = {
    ...target,
    kind,
    url: `https://github.com/${repository}/${kind === "pr" ? "pull" : "issues"}/${issue.number}`,
    title: issue.title,
    state: issue.state,
    draft: pull?.draft ?? false,
    merged: Boolean(pull?.merged_at),
    updatedAt: issue.updated_at,
    body: issue.body ?? "",
    labels: labels.sort(),
    baseRef: pull?.base.ref ?? null,
    baseSha: pull?.base.sha ?? null,
    headSha: pull?.head.sha ?? null,
    comments: discussion(comments),
    reviews: discussion(reviews, true),
    reviewComments: discussion(reviewComments),
  };
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        ...metadata,
        repository: repository.toLowerCase(),
        url: metadata.url.toLowerCase(),
      }),
    )
    .digest("hex");
  return { ...metadata, source: { fingerprint, collectedAt } };
}

export function reportEntries(report) {
  return report ? [...report.prs, ...(report.issues ?? []), ...report.skipped] : [];
}

export function skipReason(item) {
  if (item.state === "closed") return item.merged ? "已合并" : "已关闭";
  if (item.draft) return "草稿";
  return null;
}

/** No state is advanced here; only verified report publication records completion. */
export function selectBatch(items, previous, { type = "all", limit = 10, force = false } = {}) {
  if (!["all", "pr", "issue"].includes(type)) throw new Error("type 必须是 all / pr / issue");
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("limit 必须是正整数");
  if (previous) validateReport(previous);
  const old = new Map(reportEntries(previous).map((item) => [itemIdentity(item), item]));
  const unique = new Map();
  for (const item of items) {
    const key = itemIdentity(item);
    if (unique.has(key)) throw new Error(`采集条目重复：${key}`);
    unique.set(key, item);
  }
  const pending = [];
  const skipped = [];
  const unchanged = [];
  for (const item of unique.values()) {
    if (type !== "all" && item.kind !== type) continue;
    const prior = old.get(itemIdentity(item));
    if (!force && prior?.source?.fingerprint === item.source.fingerprint) {
      unchanged.push(itemIdentity(item));
      continue;
    }
    const reason = skipReason(item);
    if (reason) skipped.push({ item, reason });
    else pending.push(item);
  }
  // Oldest outstanding activity first, so a steady stream of new reports does not starve the backlog.
  pending.sort(
    (a, b) =>
      Date.parse(a.updatedAt) - Date.parse(b.updatedAt) ||
      a.number - b.number ||
      a.repository.localeCompare(b.repository),
  );
  return { selected: pending.slice(0, limit), deferred: pending.slice(limit), skipped, unchanged };
}
