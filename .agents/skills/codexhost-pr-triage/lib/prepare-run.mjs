import { lstat, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { collectCandidates } from "./github.mjs";
import { parseTarget, selectBatch } from "./incremental.mjs";
import { readProjectReport } from "./update-report.mjs";

/** Create a work packet without changing the cumulative report or completion markers. */
export async function prepareRun(options, github) {
  const { project = process.cwd(), type = "all", limit = 10, force = false } = options;
  if (!["all", "pr", "issue"].includes(type) || !Number.isSafeInteger(limit) || limit < 1)
    throw new Error("type 必须是 all / pr / issue，limit 必须是正整数");
  const storage = await readProjectReport(project);
  await github.authenticate();
  const repository = options.repository ?? (await github.repository());
  const targets = (options.targets ?? []).map((value) => parseTarget(value, repository));
  if (targets.some((item) => item.kind && type !== "all" && item.kind !== type))
    throw new Error("指定 URL 的类型与 --type 不一致");
  const collection = await collectCandidates(github, {
    repository,
    targets,
    type,
    previous: storage.report,
  });
  const batch = selectBatch(collection.items, storage.report, {
    type,
    limit,
    force: force || targets.length > 0,
  });
  const skipped = batch.skipped.map(({ item, reason }) => ({
    repository: item.repository,
    number: item.number,
    kind: item.kind,
    title: item.title,
    url: item.url,
    reason,
    source: item.source,
  }));
  const generatedAt = new Date().toISOString();
  const selection = {
    schemaVersion: 1,
    generatedAt,
    repositories: collection.repositories,
    scope: `${targets.length ? "指定条目强制复评" : force ? "强制复评" : "增量分诊"} · ${type} · 本批上限 ${limit} · 选中 ${batch.selected.length} · 待后续处理 ${batch.deferred.length} · 未变化 ${batch.unchanged.length}`,
    errors: collection.errors,
    selected: batch.selected,
    skipped: batch.skipped.map(({ item }) => item),
    deferred: batch.deferred.map(({ repository, number, kind, title, url }) => ({
      repository,
      number,
      kind,
      title,
      url,
    })),
    unchanged: batch.unchanged,
  };
  const report = {
    schemaVersion: 2,
    generatedAt,
    repositories: selection.repositories,
    scope: selection.scope,
    complete: collection.errors.length === 0,
    errors: collection.errors,
    prs: [],
    issues: [],
    skipped,
  };
  const runs = join(storage.directory, "runs");
  await mkdir(runs, { mode: 0o700 }).catch((error) => {
    if (error.code !== "EEXIST") throw error;
  });
  const info = await lstat(runs);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("拒绝非本地 runs 目录");
  const directory = await mkdtemp(join(runs, "run-"));
  const selectionPath = join(directory, "selection.json");
  const inputPath = join(directory, "report.json");
  await Promise.all([
    writeFile(selectionPath, `${JSON.stringify(selection, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    }),
    writeFile(inputPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 }),
  ]);
  return {
    selection: selectionPath,
    input: inputPath,
    selected: batch.selected.length,
    deferred: batch.deferred.length,
    unchanged: batch.unchanged.length,
    skipped: skipped.length,
    complete: collection.errors.length === 0,
    errors: collection.errors,
  };
}
