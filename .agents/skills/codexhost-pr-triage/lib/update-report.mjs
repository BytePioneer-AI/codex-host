import { execFileSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { itemIdentity as identity, renderReport, validateReport, VERDICTS } from "./report.mjs";

export function summarize(report) {
  return {
    complete: report.complete,
    evaluated: report.prs.length,
    issues: report.issues?.length ?? 0,
    processed: [...report.prs, ...(report.issues ?? [])].filter((item) => item.source).length,
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
  validateReport(incoming, { requireCardSummary: true });
  if (previous) validateReport(previous);
  const incomingEntries = [...incoming.prs, ...(incoming.issues ?? []), ...incoming.skipped];
  const oldEntries = new Map(
    [...(previous?.prs ?? []), ...(previous?.issues ?? []), ...(previous?.skipped ?? [])].map(
      (item) => [identity(item), item],
    ),
  );
  for (const item of incomingEntries) {
    const prior = oldEntries.get(identity(item));
    if (
      item.source &&
      prior?.source &&
      Date.parse(item.source.collectedAt) < Date.parse(prior.source.collectedAt)
    )
      throw new Error(`${identity(item)} 的快照早于现有报告；请重新采集`);
  }
  const updated = new Set(incomingEntries.map(identity));
  const retain = (entries) => (entries ?? []).filter((pr) => !updated.has(identity(pr)));
  const retainedPrs = retain(previous?.prs);
  const retainedIssues = retain(previous?.issues);
  const retainedSkipped = retain(previous?.skipped);
  const repositories = new Map();
  for (const name of [...incoming.repositories, ...(previous?.repositories ?? [])]) {
    if (!repositories.has(name.toLowerCase())) repositories.set(name.toLowerCase(), name);
  }
  // Missing collection targets cannot be inferred from PR absence, even in an all-open query.
  const errors = [...new Set([...(previous?.errors ?? []), ...incoming.errors])];
  const report = {
    ...incoming,
    schemaVersion: Math.max(incoming.schemaVersion, previous?.schemaVersion ?? 1),
    ...(incoming.schemaVersion === 2 || previous?.schemaVersion === 2
      ? { issues: [...(incoming.issues ?? []), ...retainedIssues] }
      : {}),
    repositories: [...repositories.values()],
    scope: `本次范围：${incoming.scope}\n增量看板：本次评估 ${incoming.prs.length} 个 PR、${incoming.issues?.length ?? 0} 个 Issue、跳过 ${incoming.skipped.length} 条；保留未复评记录 ${retainedPrs.length + retainedIssues.length + retainedSkipped.length} 条。保留项沿用原 HEAD、CI 和结论。历史采集缺口保守保留。`,
    complete: errors.length === 0,
    errors,
    prs: [...incoming.prs, ...retainedPrs],
    skipped: [...incoming.skipped, ...retainedSkipped],
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

/** Shared local storage boundary for collection and publication. */
export async function projectReportPaths(projectDirectory = process.cwd()) {
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: resolve(projectDirectory),
    encoding: "utf8",
  }).trim();
  const directory = join(root, "pr-triage");
  await mkdir(directory).catch((error) => {
    if (error.code !== "EEXIST") throw error;
  });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`拒绝非本地目录：${directory}`);
  for (const name of ["runs", "backups"]) {
    const child = await lstat(join(directory, name)).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (child && (!child.isDirectory() || child.isSymbolicLink()))
      throw new Error(`拒绝非本地 ${name} 目录`);
  }
  const jsonPath = join(directory, "report.json");
  const htmlPath = join(directory, "index.html");
  for (const path of [
    jsonPath,
    htmlPath,
    join(directory, "backups", "probe"),
    join(directory, "runs", "probe"),
  ]) {
    try {
      execFileSync("git", ["check-ignore", "-q", "--", path], { cwd: root });
    } catch {
      throw new Error("报告目录必须被 Git 忽略且未被跟踪；请先在 .gitignore 添加 /pr-triage/");
    }
  }
  return { root, directory, jsonPath, htmlPath };
}

export async function readProjectReport(projectDirectory) {
  const paths = await projectReportPaths(projectDirectory);
  const locked = await lstat(join(paths.directory, ".update-lock")).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (locked) throw new Error("报告已有更新锁，请确认没有更新进程后恢复");
  const [json, html] = await Promise.all([
    regularFile(paths.jsonPath),
    regularFile(paths.htmlPath),
  ]);
  if (html !== null && json === null) throw new Error("仅有旧 HTML：请先恢复 report.json");
  return { ...paths, report: json === null ? null : validateReport(JSON.parse(json)) };
}

/** Publish a project-local report, preserving the previous pair and serializing writers. */
export async function updateProjectReport(incoming, projectDirectory = process.cwd()) {
  validateReport(incoming, { requireCardSummary: true });
  const { directory, jsonPath, htmlPath } = await projectReportPaths(projectDirectory);
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
