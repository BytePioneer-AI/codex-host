import { itemIdentity, validateReport } from "./report.mjs";
import { readItem } from "./github.mjs";
import { skipReason } from "./incremental.mjs";

/** Bind completion to the selected source and a fresh read; never infer an AI verdict. */
export async function verifyBatch(incoming, selection, github) {
  validateReport(incoming, { requireCardSummary: true });
  if (
    incoming.schemaVersion !== 2 ||
    selection?.schemaVersion !== 1 ||
    !Array.isArray(selection.selected) ||
    !Array.isArray(selection.skipped) ||
    !Array.isArray(selection.errors)
  )
    throw new Error("需要版本 2 报告及 prepare-run 生成的 selection.json");
  const expected = new Map();
  for (const item of [...selection.selected, ...selection.skipped]) {
    if (expected.has(itemIdentity(item))) throw new Error("selection 中存在重复条目");
    expected.set(itemIdentity(item), item);
  }
  const result = structuredClone(incoming);
  const errors = [...selection.errors, ...result.errors];
  const entries = [
    ...result.prs.map((item) => ({ item, kind: "pr", skipped: false })),
    ...result.issues.map((item) => ({ item, kind: "issue", skipped: false })),
    ...result.skipped.map((item) => ({ item, kind: item.kind ?? "pr", skipped: true })),
  ];
  for (const { item, kind, skipped } of entries) {
    const target = expected.get(itemIdentity(item));
    if (!target || target.kind !== kind)
      throw new Error(`${itemIdentity(item)} 不在本批对应类型的选取范围内`);
    expected.delete(itemIdentity(item));
    if (!item.source) {
      // A useful partial assessment is still not a completion checkpoint.
      item.source = null;
      errors.push(`${itemIdentity(item)} 分析未完成，下次重试；本批未推进处理版本。`);
      continue;
    }
    if (
      item.source.fingerprint !== target.source.fingerprint ||
      item.source.collectedAt !== target.source.collectedAt
    )
      throw new Error(`${itemIdentity(item)} 的 source 必须原样来自 selection.json`);
    if (
      !skipped &&
      kind === "pr" &&
      (item.headSha !== target.headSha || item.baseSha !== target.baseSha)
    )
      throw new Error(`${itemIdentity(item)} 的评估 HEAD/BASE 与选取快照不一致`);
    try {
      const live = await readItem(github, target);
      if (live.source.fingerprint !== target.source.fingerprint)
        throw new Error("分析期间内容、讨论或提交发生变化");
      const reason = skipReason(live);
      if (Boolean(reason) !== skipped) throw new Error("条目不再属于本次评估/跳过范围");
      if (skipped) item.reason = reason;
      item.source = live.source;
    } catch (error) {
      item.source = null;
      errors.push(`${itemIdentity(item)} 未通过发布前复核，下次重试：${error.message}`);
    }
  }
  // Missing records (including an interrupted analysis) must not masquerade as a finished batch.
  for (const identity of expected.keys()) errors.push(`${identity} 本批尚未完成，未推进处理版本。`);
  result.errors = [...new Set(errors)];
  result.complete = result.errors.length === 0;
  return validateReport(result, { requireCardSummary: true });
}
