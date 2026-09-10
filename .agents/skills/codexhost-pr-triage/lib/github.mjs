import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { itemIdentity } from "./report.mjs";
import { parseTarget, snapshotItem } from "./incremental.mjs";

const execute = promisify(execFile);

/** The only GitHub transport: fixed host, REST GET, argv (never shell interpolation). */
export function createGithub(cwd = process.cwd()) {
  async function gh(args) {
    const { stdout } = await execute("gh", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      timeout: 120_000,
    });
    return stdout;
  }
  return {
    async authenticate() {
      await gh(["auth", "status", "--hostname", "github.com"]);
    },
    async repository() {
      return JSON.parse(await gh(["repo", "view", "--json", "nameWithOwner"])).nameWithOwner;
    },
    async get(path) {
      if (!/^repos\/[a-z\d][a-z\d-]*\/[a-z\d_.-]+\//iu.test(path))
        throw new Error("不支持的 GitHub 读取路径");
      return JSON.parse(await gh(["api", "--hostname", "github.com", "--method", "GET", path]));
    },
  };
}

/** Retain known pages on failure; an incomplete enumeration is never an empty queue. */
export async function paginate(github, path) {
  const items = [];
  for (let page = 1; ; page++) {
    try {
      const result = await github.get(
        `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
      );
      if (!Array.isArray(result)) throw new Error("分页响应不是数组");
      items.push(...result);
      if (result.length < 100) return { items, error: null };
    } catch (error) {
      return { items, error: `${path} 第 ${page} 页：${error.message}` };
    }
  }
}

async function allPages(github, path) {
  const result = await paginate(github, path);
  if (result.error) throw new Error(result.error);
  return result.items;
}

export async function readItem(github, target) {
  parseTarget(String(target.number), target.repository);
  const root = `repos/${target.repository}`;
  const issue = await github.get(`${root}/issues/${target.number}`);
  if (issue.number !== target.number) throw new Error("GitHub 返回了不同的条目编号");
  const kind = issue.pull_request ? "pr" : "issue";
  if (target.kind && target.kind !== kind) throw new Error("URL 类型与 GitHub 条目不一致");
  const [pull, comments, reviews, reviewComments] = await Promise.all([
    kind === "pr" ? github.get(`${root}/pulls/${target.number}`) : null,
    allPages(github, `${root}/issues/${target.number}/comments`),
    kind === "pr" ? allPages(github, `${root}/pulls/${target.number}/reviews`) : [],
    kind === "pr" ? allPages(github, `${root}/pulls/${target.number}/comments`) : [],
  ]);
  return snapshotItem({
    repository: target.repository,
    issue,
    pull,
    comments,
    reviews,
    reviewComments,
  });
}

/** Collect metadata and discussion only. Diffs and code are read by the agent for selected PRs. */
export async function collectCandidates(
  github,
  { repository, targets = [], type = "all", previous = null },
) {
  parseTarget("1", repository);
  const errors = [];
  const jobs = new Map();
  const add = (item) => {
    if (type === "all" || !item.kind || item.kind === type) {
      const key = itemIdentity(item);
      const old = jobs.get(key);
      if (old?.kind && item.kind && old.kind !== item.kind) throw new Error(`条目类型冲突：${key}`);
      jobs.set(key, old?.kind ? old : item);
    }
  };
  if (targets.length) targets.forEach(add);
  else {
    const result = await paginate(
      github,
      `repos/${repository}/issues?state=open&sort=created&direction=asc`,
    );
    if (result.error) errors.push(`Open 列表不完整，剩余数量未知：${result.error}`);
    for (const issue of result.items) {
      try {
        add({
          ...parseTarget(String(issue.number), repository),
          kind: issue.pull_request ? "pr" : "issue",
        });
      } catch (error) {
        errors.push(`列表条目无效：${error.message}`);
      }
    }
    // Absence is not closure. Re-read previously evaluated items only after complete pagination.
    if (!result.error) {
      for (const item of [...(previous?.prs ?? []), ...(previous?.issues ?? [])]) {
        if (
          item.repository.toLowerCase() !== repository.toLowerCase() ||
          jobs.has(itemIdentity(item))
        )
          continue;
        add(parseTarget(item.url, repository));
      }
    }
  }
  const work = [...jobs.values()];
  const items = [];
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, work.length) }, async () => {
      while (cursor < work.length) {
        const target = work[cursor++];
        try {
          const item = await readItem(github, target);
          if (type !== "all" && item.kind !== type)
            throw new Error("指定编号的类型与 --type 不一致");
          items.push(item);
        } catch (error) {
          errors.push(`${itemIdentity(target)} 未完成采集：${error.message}`);
        }
      }
    }),
  );
  return {
    items,
    errors: errors.sort(),
    repositories: [
      ...new Map(
        [repository, ...targets.map((item) => item.repository)].map((name) => [
          name.toLowerCase(),
          name,
        ]),
      ).values(),
    ],
  };
}
