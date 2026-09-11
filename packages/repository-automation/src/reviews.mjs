import { REVIEW_BOTS, SHA } from "./policy.mjs";

function botCommentEvidence(comment) {
  if (comment.user?.type !== "Bot") return null;
  const body = comment.body ?? "";
  const common = {
    author: comment.user.login,
    date: comment.updated_at ?? comment.created_at,
    url: comment.html_url,
  };
  if (
    comment.user.login === "chatgpt-codex-connector[bot]" &&
    body.includes("<!-- codex-pull-request-review-summary -->")
  ) {
    const row = body
      .split("\n")
      .find((line) => line.startsWith("|") && /\bCode Review\b/u.test(line));
    const columns = row?.split("|") ?? [];
    const sha = /`([a-f0-9]{7,40})`/u.exec(columns[3] ?? "")?.[1];
    const status = /\bCompleted\b/u.test(columns[2] ?? "")
      ? "机器人报告已完成"
      : /\bRunning\b/u.test(columns[2] ?? "")
        ? "审查运行中"
        : /\b(?:Failed|Skipped)\b/u.test(columns[2] ?? "")
          ? "审查失败或跳过"
          : "机器人状态未确认";
    return { ...common, sha, status };
  }
  if (comment.user.login === "coderabbitai[bot]") {
    // A success commit status can mean "rate limited". Never equate it with a review.
    const preamble = body.split("<!-- walkthrough_start -->")[0];
    if (
      /^\s*(?:>\s*)?(?:#{1,4}\s+)?(?:Rate limit exceeded|Review rate limited|Review skipped)\b/imu.test(
        preamble,
      )
    ) {
      return { ...common, status: "审查限流或跳过（不证明已审）" };
    }
    const coverage = /<!-- final_review_risk_coverage:([^\n]+?) -->/u.exec(body)?.[1];
    try {
      const evidence = JSON.parse(coverage ?? "null");
      if (evidence?.kind === "reviewed" && SHA.test(evidence.coveredCommitId)) {
        return { ...common, sha: evidence.coveredCommitId, status: "机器人报告已完成" };
      }
    } catch {
      return { ...common, status: "机器人状态格式未识别" };
    }
  }
  return null;
}

export function reviewEvidence({ reviews, comments }) {
  const records = reviews
    .filter((review) => review.state !== "PENDING")
    .map((review) => ({
      author: review.user?.login ?? "已删除账号",
      date: review.submitted_at,
      sha: review.commit_id,
      url: review.html_url,
      opinionated: ["APPROVED", "CHANGES_REQUESTED"].includes(review.state),
      commentOnly: review.user?.type !== "Bot" && review.state === "COMMENTED",
      status:
        review.user?.type === "Bot" && /unable to review.*quota/is.test(review.body ?? "")
          ? "未审查（额度不足）"
          : ({
              APPROVED: "已批准",
              CHANGES_REQUESTED: "请求修改",
              COMMENTED: "已提交审查意见",
              DISMISSED: "审查已撤销",
            }[review.state] ?? "审查状态未知"),
    }));
  for (const comment of comments) {
    const evidence = botCommentEvidence(comment);
    if (evidence) records.push(evidence);
  }
  records.sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));
  const latest = new Map();
  for (const record of records) {
    // A later human COMMENTED review is not a new approval or withdrawal of a change request.
    if (record.commentOnly && latest.get(record.author)?.opinionated) continue;
    latest.set(record.author, record);
  }
  for (const author of REVIEW_BOTS) {
    if (!latest.has(author)) latest.set(author, { author, status: "未发现可确认的审查记录" });
  }
  return [...latest.values()];
}
