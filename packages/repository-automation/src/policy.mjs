// Repository governance only: no Host, Harness, or model runtime dependencies.
export const CI_WORKFLOW = "ci.yml";
export const CI_JOBS = [
  "Check ubuntu-22.04",
  "Check macos-14",
  "Check windows-latest",
  "Check Linux ARM64",
];
export const TYPE_LABELS = ["bug", "enhancement", "question", "documentation", "chore"];
export const AREAS = {
  "Desktop / Renderer": "area:desktop",
  "Harness Adapter": "area:adapter",
  "Thread / History": "area:thread",
  "Accounts / Usage": "area:accounts",
  "Install / Update": "area:install-update",
  Remote: "area:remote",
  Documentation: "area:docs",
};
export const LABELS = {
  bug: ["d73a4a", "缺陷报告 / Bug report"],
  enhancement: ["a2eeef", "功能建议 / Feature request"],
  question: ["d876e3", "使用问题 / Question"],
  documentation: ["0075ca", "文档 / Documentation"],
  chore: ["ededed", "维护、测试或重构 / Maintenance"],
  "area:desktop": ["5319e7", "Codex Desktop、Renderer 与界面接入"],
  "area:adapter": ["1d76db", "Harness Adapter 原生能力接入"],
  "area:thread": ["0e8a16", "Thread、历史、恢复与协作"],
  "area:accounts": ["006b75", "Account、认证与 Usage 展示"],
  "area:install-update": ["fbca04", "安装、启动、打包与更新"],
  "area:remote": ["bfdadc", "SSH 与 Remote Control"],
  "area:docs": ["0075ca", "文档相关领域"],
  "awaiting-author": ["fef2c0", "等待作者补充信息或修改；由维护者设置"],
  "automation:ignore": ["ededed", "停用此条目的维护提示及自动分类"],
};
export const COMMENT_MARKER = "<!-- codexhost-maintenance:v1 -->";
export const STATE_PREFIX = "<!-- codexhost-maintenance-state:";
export const BOT_LOGIN = "github-actions[bot]";
export const REVIEW_BOTS = ["chatgpt-codex-connector[bot]", "coderabbitai[bot]"];
export const SHA = /^[a-f0-9]{40}$/u;

export function isMaintenanceComment(comment) {
  return (
    comment?.user?.login === BOT_LOGIN &&
    comment.user?.type === "Bot" &&
    comment.body?.startsWith(COMMENT_MARKER)
  );
}

export function readState(comment) {
  if (!isMaintenanceComment(comment)) return null;
  const match = comment.body.match(/<!-- codexhost-maintenance-state:([^\n]*?) -->/u);
  try {
    const state = JSON.parse(match?.[1] ?? "null");
    return state?.version === 1 ? state : null;
  } catch {
    return null;
  }
}

export function markdown(value, limit = 250) {
  return String(value ?? "")
    .slice(0, limit)
    .replace(/[\r\n]+/gu, " ")
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/@/gu, "＠")
    .replace(/[\\`*_[\]{}|]/gu, "\\$&");
}

export function githubLink(url, text = "查看") {
  // Never repost arbitrary links supplied in a PR description or bot text.
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:" && parsed.hostname === "github.com") {
      return `[${markdown(text)}](${parsed.href.replace(/[()]/gu, (c) => encodeURIComponent(c))})`;
    }
  } catch {
    // An absent URL is normal for pending runs.
  }
  return markdown(text);
}
