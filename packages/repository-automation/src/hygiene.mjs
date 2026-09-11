import { SHA } from "./policy.mjs";

const patterns = [
  {
    code: "focused-test",
    pattern:
      /^\s*(?:(?:await|return|void)\s+)?(?:it|test|describe|suite)(?:\.(?:concurrent|sequential))?\s*\.\s*only\s*(?:\(|\.)/u,
    message: "新增聚焦测试（only），可能使其他测试不运行",
  },
  {
    code: "skipped-test",
    pattern:
      /^\s*(?:(?:await|return|void)\s+)?(?:(?:it|test|describe|suite)(?:\.(?:concurrent|sequential))?\s*\.\s*(?:skip|todo)\s*(?:\(|\.)|(?:xit|xtest|xdescribe)\s*\()/u,
    message: "新增跳过或待实现测试，请说明原因",
  },
  {
    code: "type-suppression",
    pattern: /^\s*(?:\/\/|\/\*|\*)\s*@ts-(?:ignore|nocheck|expect-error)\b/u,
    message: "新增 TypeScript 抑制指令，请说明覆盖的风险",
  },
  {
    code: "lint-suppression",
    pattern: /^\s*(?:\/\/|\/\*|\*)\s*(?:eslint-disable(?:-next-line|-line)?|rustfmt::skip)\b/u,
    message: "新增静态检查抑制指令，请说明原因",
  },
  {
    code: "ignored-rust-test",
    pattern: /^\s*#\[ignore(?:\s*=|\])/u,
    message: "新增 Rust 忽略测试",
  },
  {
    code: "rust-lint-suppression",
    pattern: /^\s*#!?\[allow\(/u,
    message: "新增 Rust allow 属性，请说明原因",
  },
];

function addedLines(patch) {
  const lines = [];
  let lineNumber = 0;
  for (const line of patch.split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(line);
    if (hunk) {
      lineNumber = Number(hunk[1]);
    } else if (lineNumber > 0 && line.startsWith("+")) {
      lines.push({ line: lineNumber++, text: line.slice(1) });
    } else if (line.startsWith(" ")) {
      lineNumber += 1;
    }
  }
  return lines;
}

export function inspectHygiene(files, expectedFiles = files.length) {
  const findings = [];
  const unavailable = [];
  for (const file of files) {
    if (file.status === "removed" || !/\.(?:[cm]?[jt]sx?|rs)$/u.test(file.filename)) continue;
    if (/(?:^|\/)(?:fixtures?|__fixtures__|dist|generated|vendor)\//u.test(file.filename)) continue;
    if (!file.patch) {
      if (file.additions > 0) unavailable.push(file.filename);
      continue;
    }
    const additions = addedLines(file.patch);
    if (typeof file.additions === "number" && additions.length < file.additions)
      unavailable.push(file.filename);
    for (const added of additions) {
      for (const rule of patterns) {
        if (rule.pattern.test(added.text)) {
          findings.push({
            code: rule.code,
            file: file.filename,
            line: added.line,
            message: rule.message,
          });
        }
      }
    }
  }
  return { findings, unavailable, incomplete: expectedFiles !== files.length };
}

export function exceptionCommand(comment) {
  if (comment.user?.type !== "User") return null;
  const firstLine = (comment.body ?? "").trim().split(/\r?\n/u)[0];
  const grant = /^\/codexhost hygiene-exception ([a-f0-9]{40}) (.{5,500})$/u.exec(firstLine);
  if (grant) return { sha: grant[1], reason: grant[2], revoked: false };
  const revoke = /^\/codexhost hygiene-exception revoke ([a-f0-9]{40})$/u.exec(firstLine);
  return revoke ? { sha: revoke[1], revoked: true } : null;
}

export async function findHygieneException({ comments, headSha, permissionFor }) {
  if (!SHA.test(headSha)) return null;
  const candidates = comments
    .map((comment) => ({ comment, command: exceptionCommand(comment) }))
    .filter(({ command }) => command?.sha === headSha)
    .sort(
      (a, b) =>
        (b.comment.updated_at ?? b.comment.created_at).localeCompare(
          a.comment.updated_at ?? a.comment.created_at,
        ) || b.comment.id - a.comment.id,
    );
  for (const { comment, command } of candidates) {
    const permission = await permissionFor(comment.user.login);
    if (!["admin", "maintain", "write"].includes(permission)) continue;
    return command.revoked
      ? null
      : { ...command, author: comment.user.login, url: comment.html_url };
  }
  return null;
}
