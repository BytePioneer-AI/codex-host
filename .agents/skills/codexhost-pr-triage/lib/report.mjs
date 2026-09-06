// Local report contract and serialization. No GitHub access or verdict inference.
export const VERDICTS = ["ACCEPT", "SIMPLIFY", "DISCUSS", "DECLINE"];
export const CI_STATES = [
  "pass",
  "fail",
  "pending",
  "cancelled",
  "skipped",
  "none",
  "unknown",
  "mixed",
];
export const CONFLICT_STATES = ["clear", "conflicting", "unknown"];

function check(condition, path, message) {
  if (!condition) throw new Error(`${path}: ${message}`);
}

function object(value, path, keys) {
  check(value !== null && typeof value === "object" && !Array.isArray(value), path, "必须是对象");
  for (const key of keys) check(Object.hasOwn(value, key), `${path}.${key}`, "缺少字段");
  for (const key of Object.keys(value)) check(keys.includes(key), `${path}.${key}`, "不支持的字段");
}

function text(value, path) {
  check(typeof value === "string" && value.trim().length > 0, path, "必须是非空字符串");
}

function list(value, path, validateItem, minimum = 0) {
  check(Array.isArray(value), path, "必须是数组");
  check(value.length >= minimum, path, `至少需要 ${minimum} 项`);
  value.forEach((item, index) => validateItem(item, `${path}[${index}]`));
}

function integer(value, path, minimum = 0) {
  check(Number.isSafeInteger(value) && value >= minimum, path, `必须是 ≥ ${minimum} 的整数`);
}

function timestamp(value, path) {
  text(value, path);
  check(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) &&
      Number.isFinite(Date.parse(value)),
    path,
    "必须是带时区的 ISO 时间",
  );
}

function repository(value, path) {
  text(value, path);
  check(/^[a-z\d][a-z\d-]*\/[a-z\d_.-]+$/iu.test(value), path, "必须是 OWNER/REPO");
  check(![".", ".."].includes(value.split("/")[1]), path, "仓库名无效");
}

function webUrl(value, path) {
  text(value, path);
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${path}: URL 无效`);
  }
  check(
    ["https:", "http:"].includes(url.protocol) && !url.username && !url.password,
    path,
    "只允许不含凭据的 http/https URL",
  );
  return url;
}

function identity(pr, path, repositories, identities) {
  repository(pr.repository, `${path}.repository`);
  integer(pr.number, `${path}.number`, 1);
  text(pr.title, `${path}.title`);
  check(repositories.has(pr.repository.toLowerCase()), `${path}.repository`, "不在报告仓库范围内");
  const key = `${pr.repository.toLowerCase()}#${pr.number}`;
  check(!identities.has(key), path, "PR 重复，或同时出现在已评估与跳过列表中");
  identities.add(key);
  const url = webUrl(pr.url, `${path}.url`);
  check(
    url.origin === "https://github.com" &&
      url.pathname.toLowerCase() === `/${pr.repository}/pull/${pr.number}`.toLowerCase() &&
      !url.search &&
      !url.hash,
    `${path}.url`,
    "必须与仓库和编号对应的 GitHub PR URL 一致",
  );
}

/** Validate without filling fields, changing verdicts, or modifying the input. */
export function validateReport(report) {
  object(report, "report", [
    "schemaVersion",
    "generatedAt",
    "repositories",
    "scope",
    "complete",
    "errors",
    "prs",
    "skipped",
  ]);
  check(report.schemaVersion === 1, "report.schemaVersion", "仅支持版本 1");
  timestamp(report.generatedAt, "report.generatedAt");
  text(report.scope, "report.scope");
  list(report.repositories, "report.repositories", repository, 1);
  const repositories = new Set(report.repositories.map((name) => name.toLowerCase()));
  check(repositories.size === report.repositories.length, "report.repositories", "仓库重复");
  check(typeof report.complete === "boolean", "report.complete", "必须是布尔值");
  list(report.errors, "report.errors", text);
  check(
    report.complete ? report.errors.length === 0 : report.errors.length > 0,
    "report.errors",
    "完整报告应为空；部分结果必须说明采集缺口",
  );
  const identities = new Set();
  list(report.prs, "report.prs", (pr, path) => {
    object(pr, path, [
      "repository",
      "number",
      "title",
      "url",
      "baseSha",
      "headSha",
      "verdict",
      "reason",
      "value",
      "scope",
      "cost",
      "action",
      "stats",
      "integration",
      "evidence",
      "questions",
      "simplifications",
    ]);
    identity(pr, path, repositories, identities);
    check(VERDICTS.includes(pr.verdict), `${path}.verdict`, `必须是 ${VERDICTS.join(" / ")}`);
    for (const field of ["reason", "value", "scope", "cost", "action"])
      text(pr[field], `${path}.${field}`);
    check(!/[\r\n]/u.test(pr.reason), `${path}.reason`, "理由必须是一行");
    for (const field of ["baseSha", "headSha"]) {
      if (pr[field] === null) {
        check(pr.verdict === "DISCUSS", `${path}.${field}`, "缺少版本证据只能标为 DISCUSS");
      } else {
        check(
          typeof pr[field] === "string" && /^(?:[a-f\d]{40}|[a-f\d]{64})$/iu.test(pr[field]),
          `${path}.${field}`,
          "必须是完整 SHA 或 null",
        );
      }
    }
    if (pr.stats !== null) {
      object(pr.stats, `${path}.stats`, ["files", "additions", "deletions"]);
      for (const field of ["files", "additions", "deletions"])
        integer(pr.stats[field], `${path}.stats.${field}`);
    }
    object(pr.integration, `${path}.integration`, ["ci", "conflict", "collectedAt", "note"]);
    check(CI_STATES.includes(pr.integration.ci), `${path}.integration.ci`, "不支持的 CI 状态");
    check(
      CONFLICT_STATES.includes(pr.integration.conflict),
      `${path}.integration.conflict`,
      "不支持的冲突状态",
    );
    timestamp(pr.integration.collectedAt, `${path}.integration.collectedAt`);
    text(pr.integration.note, `${path}.integration.note`);
    list(pr.questions, `${path}.questions`, text, pr.verdict === "DISCUSS" ? 1 : 0);
    list(pr.simplifications, `${path}.simplifications`, text, pr.verdict === "SIMPLIFY" ? 1 : 0);
    list(
      pr.evidence,
      `${path}.evidence`,
      (evidence, evidencePath) => {
        object(evidence, evidencePath, ["label", "url", "revision", "detail"]);
        for (const field of ["label", "revision", "detail"])
          text(evidence[field], `${evidencePath}.${field}`);
        if (evidence.url !== null) webUrl(evidence.url, `${evidencePath}.url`);
      },
      pr.verdict === "DISCUSS" ? 0 : 1,
    );
    check(pr.evidence.length <= 5, `${path}.evidence`, "最多 5 个关键证据");
  });
  list(report.skipped, "report.skipped", (pr, path) => {
    object(pr, path, ["repository", "number", "title", "url", "reason"]);
    identity(pr, path, repositories, identities);
    text(pr.reason, `${path}.reason`);
  });
  return report;
}

/** Escape the raw-text script boundary, including HTML comments and line separators. */
export function renderReport(report, { template, styles, script }) {
  validateReport(report);
  const escaped = JSON.stringify(report).replace(
    /[<>&\u2028\u2029]/gu,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  const parts = {
    "<!-- REPORT_DATA -->": `<script id="report-data" type="application/json">${escaped}</script>`,
    "/* REPORT_STYLES */": styles,
    "/* REPORT_SCRIPT */": script,
  };
  for (const marker of Object.keys(parts)) {
    check(template.split(marker).length === 2, "template", `占位符必须恰好出现一次：${marker}`);
  }
  // One pass: payload text resembling a marker or replacement token stays literal.
  return template.replace(
    /<!-- REPORT_DATA -->|\/\* REPORT_STYLES \*\/|\/\* REPORT_SCRIPT \*\//gu,
    (marker) => parts[marker],
  );
}
