import { CI_JOBS, COMMENT_MARKER, STATE_PREFIX, githubLink, markdown } from "./policy.mjs";

export function ciFinished({ run, jobs }) {
  return Boolean(run?.status === "completed" && jobs.every((job) => job.status === "completed"));
}

export function ciFingerprint({ run, jobs }) {
  return JSON.stringify([
    run?.id,
    run?.run_attempt,
    run?.head_sha,
    run?.status,
    run?.conclusion,
    jobs
      .map((job) => [job.id, job.name, job.status, job.conclusion])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  ]);
}

function excerpt(lines) {
  if (!lines?.length) return "";
  const text = lines.join("\n");
  const width = Math.max(3, ...[...text.matchAll(/`+/gu)].map((match) => match[0].length + 1));
  const fence = "`".repeat(width);
  return `\n\n${fence}text\n${text}\n${fence}`;
}

export function renderReport({ item, ci, errors = new Map() }) {
  if (!ciFinished(ci)) return null;
  const { run, jobs } = ci;
  const commit = githubLink(
    `${item.html_url.split("/pull/")[0]}/commit/${item.head.sha}`,
    item.head.sha.slice(0, 7),
  );
  const allPassed =
    run.conclusion === "success" &&
    jobs.length > 0 &&
    jobs.every((job) => job.conclusion === "success") &&
    CI_JOBS.every(
      (name) =>
        jobs.filter((job) => job.name === name && job.conclusion === "success").length === 1,
    );
  let content;
  if (allPassed) {
    content = `✅ 提交 ${commit} 的 CI 全部通过。`;
  } else {
    const failed = jobs.filter(
      (job) => job.conclusion === "failure" || job.conclusion === "timed_out",
    );
    const names = {
      "Check windows-latest": "Windows",
      "Check macos-14": "macOS",
      "Check ubuntu-22.04": "Linux x64",
      "Check Linux ARM64": "Linux ARM64",
    };
    if (failed.length) {
      content = failed
        .slice(0, 4)
        .map(
          (job) =>
            `❌ ${markdown(names[job.name] ?? job.name)} CI ${job.conclusion === "timed_out" ? "超时" : "失败"}。${githubLink(job.html_url ?? run.html_url, "查看日志")}${excerpt(errors.get(job.id))}`,
        )
        .join("\n\n");
      content += `\n\n提交 ${commit}${failed.length > 4 ? `；另有 ${failed.length - 4} 项失败，${githubLink(run.html_url, "查看运行")}` : ""}。`;
    } else {
      const state =
        run.conclusion === "action_required"
          ? "等待维护者批准或其他人工操作，尚未通过"
          : run.conclusion === "cancelled" || jobs.some((job) => job.conclusion === "cancelled")
            ? "已取消，未全部通过"
            : run.conclusion === "skipped" || jobs.some((job) => job.conclusion === "skipped")
              ? "有跳过项，未全部通过"
              : run.conclusion === "failure"
                ? "失败"
                : run.conclusion === "timed_out"
                  ? "超时"
                  : "结果不完整或未确认，不能视为全部通过";
      content = `⚠️ 提交 ${commit} 的 CI ${state}。${githubLink(run.html_url, "查看运行")}`;
    }
  }
  // Bind even identical visible outcomes to their exact run/attempt; never borrow an older result.
  return `${COMMENT_MARKER}\n${content}\n\n${STATE_PREFIX}${JSON.stringify({ version: 2, headSha: item.head.sha, runId: run.id, runAttempt: run.run_attempt })} -->`;
}
