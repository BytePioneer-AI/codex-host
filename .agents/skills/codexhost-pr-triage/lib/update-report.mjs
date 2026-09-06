import { execFileSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { renderReport, validateReport, VERDICTS } from "./report.mjs";

const identity = (pr) => `${pr.repository.toLowerCase()}#${pr.number}`;

export function summarize(report) {
  return {
    complete: report.complete,
    evaluated: report.prs.length,
    skipped: report.skipped.length,
    counts: Object.fromEntries(
      VERDICTS.map((verdict) => [
        verdict,
        report.prs.filter((pr) => pr.verdict === verdict).length,
      ]),
    ),
  };
}

/** Incoming identities replace both verdicts and skipped entries; absent identities stay unchanged. */
export function mergeReports(previous, incoming) {
  validateReport(incoming);
  if (previous) validateReport(previous);
  const prior = new Map(
    [...(previous?.prs ?? []), ...(previous?.skipped ?? [])].map((pr) => [identity(pr), pr]),
  );
  for (const pr of [...incoming.prs, ...incoming.skipped]) {
    const oldTime = prior.get(identity(pr))?.evaluatedAt;
    const newTime = pr.evaluatedAt === undefined ? incoming.generatedAt : pr.evaluatedAt;
    if (oldTime && (!newTime || Date.parse(newTime) < Date.parse(oldTime)))
      throw new Error(`拒绝用更旧或未知时间的评估覆盖 ${identity(pr)}`);
  }
  const updated = new Set([...incoming.prs, ...incoming.skipped].map(identity));
  const retain = (entries) =>
    (entries ?? [])
      .filter((pr) => !updated.has(identity(pr)))
      .map((pr) => ({
        ...pr,
        // Legacy reports may already contain mixed snapshots. Never infer their assessment time.
        evaluatedAt: pr.evaluatedAt ?? null,
      }));
  const stamp = (entries) =>
    entries.map((pr) => ({
      ...pr,
      evaluatedAt: pr.evaluatedAt === undefined ? incoming.generatedAt : pr.evaluatedAt,
    }));
  const retainedPrs = retain(previous?.prs);
  const retainedSkipped = retain(previous?.skipped);
  const repositories = new Map();
  for (const name of [...incoming.repositories, ...(previous?.repositories ?? [])]) {
    if (!repositories.has(name.toLowerCase())) repositories.set(name.toLowerCase(), name);
  }
  // Missing collection targets cannot be inferred from PR absence, even in an all-open query.
  const errors = [...new Set([...(previous?.errors ?? []), ...incoming.errors])];
  const report = {
    ...incoming,
    repositories: [...repositories.values()],
    scope: `本次范围：${incoming.scope}\n增量看板：本次评估 ${incoming.prs.length} 条、跳过 ${incoming.skipped.length} 条；保留未复评记录 ${retainedPrs.length + retainedSkipped.length} 条。卡片评估时间与 HEAD/CI 各自属于其原快照；旧格式未知时间不会补成当前时间。历史采集缺口保守保留。`,
    complete: errors.length === 0,
    errors,
    prs: [...stamp(incoming.prs), ...retainedPrs],
    skipped: [...stamp(incoming.skipped), ...retainedSkipped],
  };
  return validateReport(report);
}

async function regularFile(path) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`拒绝非普通文件：${path}`);
    return await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

/** Publish a project-local report, preserving the previous pair and serializing writers. */
export async function updateProjectReport(incoming, projectDirectory = process.cwd()) {
  validateReport(incoming);
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: resolve(projectDirectory),
    encoding: "utf8",
  }).trim();
  const directory = join(root, "pr-triage");
  await mkdir(directory).catch((error) => {
    if (error.code !== "EEXIST") throw error;
  });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error(`拒绝非本地目录：${directory}`);
  const jsonPath = join(directory, "report.json");
  const htmlPath = join(directory, "index.html");
  for (const path of [jsonPath, htmlPath, join(directory, "backups", "probe")]) {
    try {
      execFileSync("git", ["check-ignore", "-q", "--", path], { cwd: root });
    } catch {
      throw new Error(
        "报告目录必须被 Git 忽略且未被跟踪；请先在 .gitignore 添加 /pr-triage/",
      );
    }
  }
  const lock = join(directory, ".update-lock");
  await mkdir(lock); // An existing lock stops concurrent writers; never delete another writer's lock.
  let stage;
  let backup = null;
  try {
    const [oldJson, oldHtml] = await Promise.all([regularFile(jsonPath), regularFile(htmlPath)]);
    if (oldHtml !== null && oldJson === null)
      throw new Error("仅有旧 HTML：请先从页面导出 JSON 并恢复 report.json，禁止覆盖");
    const previous = oldJson === null ? null : validateReport(JSON.parse(oldJson));
    const report = mergeReports(previous, incoming);
    const assets = new URL("../assets/", import.meta.url);
    const [template, styles, script] = await Promise.all(
      ["report-template.html", "report.css", "report.js"].map((name) =>
        readFile(new URL(name, assets), "utf8"),
      ),
    );
    const html = renderReport(report, { template, styles, script });
    stage = await mkdtemp(join(directory, ".pending-"));
    await writeFile(join(stage, "report.json"), `${JSON.stringify(report, null, 2)}\n`, {
      flag: "wx",
    });
    await writeFile(join(stage, "index.html"), html, { flag: "wx" });
    if (oldJson !== null) {
      const backups = join(directory, "backups");
      await mkdir(backups).catch((error) => {
        if (error.code !== "EEXIST") throw error;
      });
      const info = await lstat(backups);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("拒绝非本地备份目录");
      backup = await mkdtemp(join(backups, "snapshot-"));
      await writeFile(join(backup, "report.json"), oldJson, { flag: "wx" });
      if (oldHtml !== null) await writeFile(join(backup, "index.html"), oldHtml, { flag: "wx" });
    }
    // JSON is authoritative. Each rename is atomic, not the pair. A crash can leave HTML stale;
    // retain the lock/backup for manual inspection rather than silently assuming publication finished.
    await rename(join(stage, "report.json"), jsonPath);
    await rename(join(stage, "index.html"), htmlPath);
    return {
      output: htmlPath,
      data: jsonPath,
      backup,
      current: summarize(incoming),
      cumulative: summarize(report),
    };
  } finally {
    if (stage) await rm(stage, { recursive: true, force: true });
    await rm(lock, { recursive: true, force: true });
  }
}
