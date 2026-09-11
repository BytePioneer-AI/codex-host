import { BOT_LOGIN, TYPE_LABELS } from "./policy.mjs";

// Only an explicit Conventional Commit title is evidence; never infer from body or commits.
export function conventionalType(title) {
  const type = /^(fix|feat|docs)(?:\([^\r\n)]+\))?!?:[ \t]+\S/iu
    .exec(title ?? "")?.[1]
    ?.toLowerCase();
  return { fix: "bug", feat: "enhancement", docs: "documentation" }[type] ?? null;
}

export function planLabels({ item, events }) {
  const type = conventionalType(item.title);
  const empty = { add: [], remove: [] };
  if (!type) return empty;
  const changes = events.filter(
    (event) =>
      ["labeled", "unlabeled"].includes(event.event) && TYPE_LABELS.includes(event.label?.name),
  );
  // Respect manual choices/removals and other tools, including when ownership is unknown.
  if (changes.some((event) => event.actor?.login !== BOT_LOGIN)) return empty;
  const current = item.labels
    .map((label) => label.name)
    .filter((name) => TYPE_LABELS.includes(name));
  if (
    current.some(
      (name) => !changes.some((event) => event.event === "labeled" && event.label.name === name),
    )
  )
    return empty;
  return {
    add: current.includes(type) ? [] : [type],
    remove: current.filter((name) => name !== type),
  };
}
