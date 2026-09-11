import { AREAS, BOT_LOGIN, TYPE_LABELS } from "./policy.mjs";

const aliases = {
  summary: ["Summary", "问题概述", "变更说明"],
  area: ["Area", "影响领域"],
  reproduction: ["Reproduction", "Steps to reproduce", "复现步骤"],
  expected: ["Expected behavior", "预期行为"],
  actual: ["Actual behavior", "实际行为"],
  version: ["codexhost version", "codexhost 版本"],
  desktop: ["Codex Desktop version", "Codex Desktop 版本"],
  os: ["OS / Architecture", "操作系统与架构"],
  installation: ["Installation", "安装方式"],
  harness: ["Harness / Version", "Harness 与版本"],
  useCase: ["Use case", "使用场景"],
  proposal: ["Proposed behavior", "期望能力"],
  tried: ["What have you tried?", "已尝试的方法"],
  related: ["Related issues", "关联问题"],
  tests: ["Test plan", "Validation", "测试与验证"],
  validatedCommit: ["Validated commit", "验证对应提交"],
};

// Read headings only outside fences. Comments and template placeholders are not evidence.
export function sections(body = "") {
  const result = new Map();
  let heading = "";
  let fence;
  for (const line of String(body)
    .replace(/<!--[\s\S]*?(?:-->|$)/gu, "")
    .split(/\r?\n/u)) {
    const delimiter = /^\s{0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
    if (delimiter && (!fence || (delimiter[0] === fence[0] && delimiter.length >= fence.length))) {
      fence = fence ? undefined : delimiter;
    } else if (!fence) {
      const match = /^#{1,6}\s+(.+?)\s*#*\s*$/u.exec(line);
      if (match) {
        heading = match[1].trim().toLowerCase();
        if (!result.has(heading)) result.set(heading, []);
        continue;
      }
    }
    if (heading) result.get(heading).push(line);
  }
  return new Map([...result].map(([key, lines]) => [key, lines.join("\n").trim()]));
}

export function field(body, name) {
  const parsed = sections(body);
  return (aliases[name] ?? [name])
    .map((alias) => parsed.get(alias.toLowerCase()))
    .filter(Boolean)
    .join("\n");
}

export function hasContent(value) {
  const clean = String(value ?? "")
    .replace(/<!--[\s\S]*?(?:-->|$)/gu, "")
    .replace(/^[\s`*_>#-]+|[\s`*_>#-]+$/gu, "")
    .trim();
  return Boolean(clean) && !/^(?:no response|未填写|todo|tbd|待补充)$/iu.test(clean);
}

export function conventionalType(title) {
  const type = /^(fix|feat|docs|chore|test|ci|build|refactor|perf|style)(?:\([^\n)]+\))?!?:\s+\S/iu
    .exec(title ?? "")?.[1]
    ?.toLowerCase();
  if (!type) return null;
  return { fix: "bug", feat: "enhancement", docs: "documentation" }[type] ?? "chore";
}

export function issueType(item) {
  const explicit = item.labels
    .map((label) => label.name)
    .find((name) => TYPE_LABELS.includes(name));
  if (explicit) return explicit;
  if (/^\[bug\]/iu.test(item.title) || hasContent(field(item.body, "reproduction"))) return "bug";
  if (/^\[feature\]/iu.test(item.title) || hasContent(field(item.body, "proposal")))
    return "enhancement";
  if (/^\[question\]/iu.test(item.title) || hasContent(field(item.body, "tried")))
    return "question";
  return null;
}

function humanChanged(events, names) {
  return events.some(
    (event) =>
      ["labeled", "unlabeled"].includes(event.event) &&
      names.includes(event.label?.name) &&
      event.actor?.login !== BOT_LOGIN,
  );
}

export function planLabels({ item, isPr, events = [], commits = [] }) {
  const current = item.labels.map((label) => label.name);
  const add = [];
  const remove = [];
  // Template-assigned labels count as an explicit choice. Never overrule human labels/removals.
  if (!humanChanged(events, TYPE_LABELS)) {
    let type;
    if (isPr) {
      type = conventionalType(item.title);
      if (!type) {
        const types = [...new Set(commits.map(conventionalType).filter(Boolean))];
        const substantive = types.filter((candidate) => candidate !== "chore");
        type = substantive.length === 1 ? substantive[0] : types.length === 1 ? types[0] : null;
      }
    } else {
      type = issueType(item);
    }
    if (type) {
      if (!current.includes(type)) add.push(type);
      if (isPr)
        remove.push(...current.filter((name) => TYPE_LABELS.includes(name) && name !== type));
    }
  }
  const areaNames = Object.values(AREAS);
  if (!isPr && !humanChanged(events, areaNames)) {
    const area = AREAS[field(item.body, "area").trim()];
    if (area) {
      if (!current.includes(area)) add.push(area);
      remove.push(...current.filter((name) => areaNames.includes(name) && name !== area));
    }
  }
  return { add, remove };
}

export function missingInformation(item, isPr) {
  let required;
  if (isPr) {
    required = ["summary", "related", "tests"];
  } else {
    const kind = issueType(item);
    required =
      kind === "bug"
        ? [
            "summary",
            "expected",
            "actual",
            "reproduction",
            "version",
            "desktop",
            "os",
            "installation",
            "harness",
          ]
        : kind === "enhancement"
          ? ["summary", "useCase", "proposal"]
          : kind === "question"
            ? ["summary", "tried"]
            : ["summary"];
  }
  // Useful free-form reports are not rejected for lacking the template's exact headings.
  return required
    .filter(
      (key) => !(key === "summary" && sections(item.body).size === 0 && hasContent(item.body)),
    )
    .filter((key) => !hasContent(field(item.body, key)))
    .map((key) => aliases[key][0]);
}
