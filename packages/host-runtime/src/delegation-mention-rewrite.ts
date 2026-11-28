import { stripDelegationMentions, type DelegationMention } from "@codexhost/shared-contracts";
import type { JsonObject, JsonValue } from "@codexhost/protocol-core";

import { DELEGATION_SKILL_NAME } from "./delegation-skill.js";

/** Native Codex `skill` UserInput pointing at the managed delegation Skill. */
export interface DelegationSkillReference {
  name: string;
  path: string;
}

function isRemoteTarget(mention: DelegationMention): boolean {
  return mention.hostId !== undefined && mention.hostId !== "local";
}

function mentionKey(mention: DelegationMention): string {
  const host = isRemoteTarget(mention) ? mention.hostId : "";
  return `${host ?? ""}::${mention.harnessId ?? ""}`;
}

function describeTargets(mentions: readonly DelegationMention[]): string {
  return mentions
    .map(({ hostId, harnessId, label }) => {
      if (hostId !== undefined && hostId !== "local") {
        return harnessId !== undefined
          ? `@${label} (remote Host \`${hostId}\`, Harness \`${harnessId}\`)`
          : `@${label} (remote Host \`${hostId}\`, Harness unspecified)`;
      }
      return `@${label} (Harness \`${harnessId ?? ""}\`)`;
    })
    .join(", ");
}

/**
 * Explicit, model-facing delegation request derived from `#` / `@` mention chips.
 * The target Host and/or Harness is resolved by the Host, so the model does not guess it.
 */
export function delegationMentionInstruction(mentions: readonly DelegationMention[]): string {
  const plural = mentions.length > 1;
  const hasRemote = mentions.some(isRemoteTarget);
  if (!hasRemote) {
    return [
      `[codexhost delegation] The user mentioned ${describeTargets(mentions)}.`,
      `Use the ${DELEGATION_SKILL_NAME} skill to delegate this request to ${plural ? "each mentioned Harness" : "that Harness"}`,
      "with `delegate start --harness <id>` through the executable in CODEXHOST_CLI_PATH, instead of doing the task yourself.",
    ].join(" ");
  }
  const hasRemoteWithHarness = mentions.some((m) => isRemoteTarget(m) && m.harnessId !== undefined);
  const hasRemoteHostOnly = mentions.some((m) => isRemoteTarget(m) && m.harnessId === undefined);
  const hasLocal = mentions.some((m) => !isRemoteTarget(m) && m.harnessId !== undefined);
  const parts = [
    `[codexhost delegation] The user mentioned ${describeTargets(mentions)}.`,
    `Use the ${DELEGATION_SKILL_NAME} skill to delegate this request to ${plural ? "each mentioned target" : "that target"} through the executable in CODEXHOST_CLI_PATH, instead of doing the task yourself.`,
  ];
  if (hasRemoteWithHarness) {
    parts.push(
      "For remote targets with a Harness, run `delegate start --host <hostId> --harness <id> --cwd <remote-path>` (use `project list --host <hostId>` first if the user did not specify a remote path).",
    );
  }
  if (hasRemoteHostOnly) {
    parts.push(
      "For remote targets without a specified Harness, inspect available Harnesses with `harness list --host <hostId>` to choose an appropriate Harness, then run `delegate start --host <hostId> --harness <id> --cwd <remote-path>` (use `project list --host <hostId>` first if the user did not specify a remote path).",
    );
  }
  if (hasLocal) {
    parts.push("For local targets, run `delegate start --harness <id>`.");
  }
  return parts.join(" ");
}

function appendInstruction(text: string, mentions: readonly DelegationMention[]): string {
  const instruction = delegationMentionInstruction(mentions);
  return text.trim().length === 0 ? instruction : `${text}\n\n${instruction}`;
}

function filterActionableMentions(mentions: readonly DelegationMention[]): DelegationMention[] {
  return mentions.filter((m) => isRemoteTarget(m) || m.harnessId !== undefined);
}

/** External Harness Turns carry plain text only. */
export function rewriteDelegationMentionText(text: string): string {
  const { text: stripped, mentions } = stripDelegationMentions(text);
  const actionable = filterActionableMentions(mentions);
  return actionable.length === 0 ? text : appendInstruction(stripped, actionable);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Rewrite a native Codex `turn/start` / `turn/steer` input array. Returns null
 * when no delegation mention is present so the original frame is forwarded
 * untouched. When the managed Skill is available it is attached as a native
 * `skill` input item so Codex loads it deterministically.
 */
export function rewriteDelegationMentionInput(
  input: readonly JsonValue[],
  skill: DelegationSkillReference | null,
): JsonValue[] | null {
  const mentions: DelegationMention[] = [];
  const seen = new Set<string>();
  let lastTextIndex = -1;
  const rewritten = input.map((item, index): JsonValue => {
    if (!isRecord(item) || item.type !== "text" || typeof item.text !== "string") return item;
    lastTextIndex = index;
    const result = stripDelegationMentions(item.text);
    const actionable = filterActionableMentions(result.mentions);
    for (const mention of actionable) {
      const key = mentionKey(mention);
      if (seen.has(key)) continue;
      seen.add(key);
      mentions.push(mention);
    }
    return actionable.length === 0 ? item : ({ ...item, text: result.text } as JsonObject);
  });
  if (mentions.length === 0) return null;

  const target = rewritten[lastTextIndex];
  if (isRecord(target) && typeof target.text === "string") {
    rewritten[lastTextIndex] = {
      ...target,
      text: appendInstruction(target.text, mentions),
    } as JsonObject;
  }
  const hasSkill = rewritten.some(
    (item) => isRecord(item) && item.type === "skill" && item.name === skill?.name,
  );
  if (skill && !hasSkill) rewritten.push({ type: "skill", name: skill.name, path: skill.path });
  return rewritten;
}
