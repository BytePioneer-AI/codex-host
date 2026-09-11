import { field, issueType, missingInformation } from "./intake.mjs";
import { inspectHygiene } from "./hygiene.mjs";
import { reviewEvidence } from "./reviews.mjs";
import {
  CI_JOBS,
  COMMENT_MARKER,
  STATE_PREFIX,
  SHA,
  githubLink,
  markdown,
  readState,
} from "./policy.mjs";

function ciState(run) {
  if (!run) return "尚未发现本提交的 CI 运行";
  if (run.conclusion === "action_required")
    return "等待维护者批准或其他人工操作（action_required）";
  if (run.status !== "completed")
    return run.status === "queued" || run.status === "requested" || run.status === "waiting"
      ? "排队／等待中"
      : "运行中";
  return (
    {
      success: "工作流报告通过",
      failure: "失败",
      cancelled: "已取消",
      skipped: "已跳过",
      timed_out: "超时",
      neutral: "中性结果",
    }[run.conclusion] ?? "状态未确认"
  );
}

function timestamp(value, fallback) {
  return Number.isFinite(Date.parse(value)) ? Date.parse(value) : fallback;
}

export function activityState({ item, comments, previous, now }) {
  const saved = readState(previous);
  const created = timestamp(item.created_at, now);
  let lastActivity = timestamp(saved?.lastActivityAt, created);
  const previousWrite = timestamp(previous?.updated_at, 0);
  const updated = timestamp(item.updated_at, created);
  // Our own summary edits must not keep an otherwise inactive item alive.
  if (!previous || updated > previousWrite) lastActivity = Math.max(lastActivity, updated);
  for (const comment of comments) {
    if (comment.id === previous?.id) continue;
    lastActivity = Math.max(
      lastActivity,
      timestamp(comment.updated_at ?? comment.created_at, created),
    );
  }
  return { version: 1, lastActivityAt: new Date(Math.min(now, lastActivity)).toISOString() };
}

export function reminder({ labels, state, now }) {
  const days = Math.floor((now - Date.parse(state.lastActivityAt)) / 86400000);
  const waiting = labels.some((label) => label.name === "awaiting-author");
  const threshold = waiting ? 14 : 30;
  if (days < threshold) return null;
  return waiting
    ? `🔔 已等待作者 ${days} 天：请补充所需信息或修改；维护者可移除 awaiting-author。不会自动关闭。`
    : `🔔 已 ${days} 天没有观察到其他活动：请维护者确认下一步、负责人或是否需要作者补充。不会自动关闭。`;
}

export function renderReport({
  item,
  isPr,
  comments,
  previous,
  prData,
  exception,
  now = Date.now(),
}) {
  const state = activityState({ item, comments, previous, now });
  if (isPr) state.headSha = item.head.sha;
  const lines = [
    COMMENT_MARKER,
    `## codexhost ${isPr ? "PR" : "Issue"} 维护摘要`,
    "",
    "> 这是确定性状态提示，不是 AI 审查、合并授权或完整测试证明。",
    "",
  ];
  const missing = missingInformation(item, isPr);
  lines.push("### 信息完整性", "");
  if (missing.length) {
    lines.push(
      `建议补充：${missing.map((name) => `\`${name}\``).join("、")}。`,
      "",
      "这是提示，不因模板格式关闭条目。暂时未知／不适用可明确说明；请勿粘贴 Token、Cookie、账号文件或未脱敏日志。",
    );
  } else if (!isPr && !issueType(item)) {
    lines.push(
      "未识别条目类型，暂未检查特定模板字段。可选择 Bug / Feature / Question 表单；若是运行故障，请补充版本、环境和复现条件。不会按格式关闭。",
    );
  } else {
    lines.push("所检查的说明字段已填写；内容真实性和复现结果仍需确认。");
  }
  if (isPr) {
    const head = item.head.sha;
    const priorHead = readState(previous)?.headSha;
    lines.push(
      "",
      "### 提交与验证",
      "",
      `当前 HEAD：\`${head}\`；目标分支：${markdown(item.base.ref)}。`,
    );
    if (priorHead && priorHead !== head)
      lines.push(
        "⚠️ HEAD 已变化；旧测试声明和旧审查不能直接证明新提交正确。不会自动修改 Draft 状态。",
      );
    const validated = field(item.body, "validatedCommit").trim().replace(/^`|`$/gu, "");
    lines.push(
      SHA.test(validated)
        ? validated === head
          ? "作者的 Validated commit 对应当前 HEAD；这仍是作者声明，不是机器人执行过本地测试的证明。"
          : `⚠️ 测试声明绑定旧提交 \`${validated}\`，请重新验证后更新 Validated commit。`
        : "⚠️ 测试说明尚未绑定完整提交 SHA。请在 Validated commit 填写实际验证过的 40 位 HEAD SHA；不得仅为消除提示而填写。",
    );
    lines.push(
      "Desktop／真实 Harness 的实机验证应在 Test plan 单独说明；CI 通过不替代它。",
      "",
      "### CI",
      "",
    );
    const { run, jobs, unavailable } = prData.ci;
    lines.push(
      unavailable
        ? "⚠️ CI 状态读取失败，不能视为通过。"
        : `${ciState(run)}${run ? ` · ${githubLink(run.html_url, "运行详情")}` : ""}。`,
    );
    lines.push("", "| 检查 | 结果 |", "| --- | --- |");
    for (const name of CI_JOBS) {
      const job = jobs.find((candidate) => candidate.name === name);
      const value = job
        ? job.status !== "completed"
          ? job.status
          : (job.conclusion ?? "unknown")
        : "未运行／未取得结果";
      lines.push(`| ${name} | ${markdown(value)} |`);
    }
    if (
      run?.conclusion === "success" &&
      CI_JOBS.some((name) => !jobs.some((job) => job.name === name && job.conclusion === "success"))
    ) {
      lines.push("", "⚠️ 工作流虽显示成功，但四项检查没有全部成功证据；不能当成完整 CI 通过。");
    }
    lines.push(
      "",
      "### 已有审查记录",
      "",
      "| 审查者 | 最近可确认状态 | 提交范围 |",
      "| --- | --- | --- |",
    );
    for (const review of reviewEvidence({ reviews: prData.reviews, comments })) {
      const scope = review.sha
        ? head.startsWith(review.sha)
          ? `当前 HEAD（${review.sha.slice(0, 7)}）`
          : `旧提交 ${review.sha.slice(0, 7)}，需复核`
        : "未绑定／未确认";
      lines.push(
        `| ${markdown(review.author)} | ${githubLink(review.url, review.status)} | ${scope} |`,
      );
    }
    lines.push(
      "",
      "未发现记录 ≠ 已审查；无问题评论、绿色机器人状态 ≠ 人工批准。旧提交上的修改请求不会被本工作流撤销。",
    );
    const hygiene = inspectHygiene(prData.files, item.changed_files);
    lines.push("", "### 新增规范风险（提示）", "");
    if (hygiene.incomplete || hygiene.unavailable.length) {
      lines.push("⚠️ Diff 或 patch 不完整，规范检查覆盖不完整，不能报告全部通过。");
    }
    if (hygiene.findings.length) {
      for (const finding of hygiene.findings.slice(0, 30)) {
        lines.push(`- ${markdown(finding.file)}:${finding.line} — ${finding.message}。`);
      }
      if (hygiene.findings.length > 30)
        lines.push(`另有 ${hygiene.findings.length - 30} 条同类提示，请查看完整 Diff。`);
      if (exception) {
        lines.push(
          "",
          `维护者 ${markdown(exception.author)} 已为当前 HEAD 记录例外：${markdown(exception.reason, 500)} · ${githubLink(exception.url, "例外记录")}。例外不替代测试，也不授予合并权限。`,
        );
      } else {
        lines.push(
          "",
          "若有合理原因，维护者可评论 `/codexhost hygiene-exception <完整HEAD SHA> <原因>`。新提交自动使旧例外失效；用 `/codexhost hygiene-exception revoke <完整HEAD SHA>` 撤销。",
        );
      }
    } else if (!hygiene.incomplete && !hygiene.unavailable.length) {
      lines.push("没有发现配置的新增风险模式；不是完整语法分析，不替代现有 lint／测试。");
    }
    for (const error of prData.errors) lines.push("", `⚠️ ${error}。`);
  }
  const notice = reminder({ labels: item.labels, state, now });
  if (notice) lines.push("", "### 长期等待提醒", "", notice);
  lines.push(
    "",
    "---",
    "按事件和定时任务刷新；不自动关闭、批准、合并或切换 Draft。添加 automation:ignore 可停用此条目的维护提示。",
    "",
    `${STATE_PREFIX}${JSON.stringify(state)} -->`,
  );
  // Preserve one comment and avoid notifying on every sweep when nothing changed.
  return lines.join("\n");
}
