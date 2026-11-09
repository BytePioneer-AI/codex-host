import type { JsonObject, JsonValue } from "@codexhost/protocol-core";
import {
  harnessCommandCatalogSchema,
  harnessCommandDescriptorSchema,
  harnessConfigurationStateSchema,
} from "@codexhost/shared-contracts";
import { encodeOfficialCodexModelRef } from "../official-codex-model-ref.js";

const isRecord = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function nativeThreadConfiguration(settings: JsonObject) {
  const profile = isRecord(settings.activePermissionProfile)
    ? settings.activePermissionProfile
    : undefined;
  const effort = settings.effort ?? settings.reasoningEffort;
  return harnessConfigurationStateSchema.parse({
    ...(typeof settings.model === "string"
      ? {
          effectiveModel: encodeOfficialCodexModelRef(
            settings.model,
            typeof settings.serviceTier === "string" ? settings.serviceTier : null,
          ),
          resolvedModelLabel: settings.model,
        }
      : {}),
    ...(typeof effort === "string" ? { effectiveThinkingOptionId: effort } : {}),
    ...(typeof profile?.id === "string" ? { effectivePermissionModeId: profile.id } : {}),
  });
}

/** The empty RPC response acknowledges submission, not applied settings. */
export async function updateNativeThreadSettings(
  request: (method: string, params: JsonObject) => Promise<JsonObject>,
  notifications: Set<(value: JsonValue) => void>,
  threadId: string,
  settings: JsonObject,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let listener: (value: JsonValue) => void = () => {};
  const confirmed = new Promise<JsonObject>((resolve, reject) => {
    timer = setTimeout(() => reject(new Error("Codex settings confirmation timed out")), 15_000);
    listener = (value) => {
      if (value === null) {
        reject(new Error("Official Codex stopped before confirming settings"));
        return;
      }
      if (
        !isRecord(value) ||
        value.method !== "thread/settings/updated" ||
        !isRecord(value.params) ||
        value.params.threadId !== threadId
      )
        return;
      const applied = value.params.threadSettings;
      if (!isRecord(applied) || typeof applied.model !== "string") {
        reject(new Error("Codex returned invalid model settings"));
        return;
      }
      // A preceding turn/start can still have a settings notification in flight.
      if (settings.model !== undefined && applied.model !== settings.model) return;
      if (settings.effort !== undefined && applied.effort !== settings.effort) return;
      if (Object.hasOwn(settings, "serviceTier")) {
        if (!(applied.serviceTier === null || typeof applied.serviceTier === "string")) {
          reject(new Error("Codex returned invalid service tier settings"));
          return;
        }
        if ((applied.serviceTier ?? "default") !== (settings.serviceTier ?? "default")) return;
      }
      if (
        settings.permissions !== undefined &&
        (!isRecord(applied.activePermissionProfile) ||
          applied.activePermissionProfile.id !== settings.permissions)
      )
        return;
      resolve(applied);
    };
    notifications.add(listener);
  });
  try {
    const [, applied] = await Promise.all([
      request("thread/settings/update", { threadId, ...settings }).then((response) => {
        if (isRecord(response.error)) throw new Error(String(response.error.message));
      }),
      confirmed,
    ]);
    return nativeThreadConfiguration(applied);
  } finally {
    clearTimeout(timer);
    notifications.delete(listener);
  }
}

function nativeSkills(result: JsonObject) {
  const skills = new Map<string, { name: string; path: string }>();
  const commands = [];
  const warnings: string[] = [];
  if (!Array.isArray(result.data)) warnings.push("Codex returned an invalid Skills list");
  for (const entry of Array.isArray(result.data) ? result.data : []) {
    if (!isRecord(entry) || !Array.isArray(entry.skills)) {
      warnings.push("Codex returned an invalid Skills list entry");
      continue;
    }
    for (const error of Array.isArray(entry.errors) ? entry.errors : []) {
      warnings.push(`Codex Skill error: ${JSON.stringify(error)}`);
    }
    for (const skill of entry.skills) {
      if (isRecord(skill) && skill.enabled === false) continue;
      const command = harnessCommandDescriptorSchema.safeParse(
        isRecord(skill)
          ? {
              id: `skill:${skill.name}`,
              invocation: `$${skill.name}`,
              label: skill.name,
              ...(typeof skill.description === "string" && skill.description.trim()
                ? { description: skill.description.trim().slice(0, 512) }
                : {}),
              argumentMode: "text",
              kind: "skill",
            }
          : null,
      );
      if (
        !isRecord(skill) ||
        skill.enabled !== true ||
        typeof skill.name !== "string" ||
        skill.name !== skill.name.trim() ||
        typeof skill.path !== "string" ||
        !skill.path.trim() ||
        !command.success
      ) {
        warnings.push(`Skipped invalid Codex Skill: ${JSON.stringify(skill)}`);
        continue;
      }
      // Codex lists workspace Skills before same-named user Skills. Keep that order.
      const previous = skills.get(skill.name);
      if (previous) {
        warnings.push(
          `Skipped duplicate Skill '${skill.name}' at ${skill.path}; using ${previous.path}`,
        );
        continue;
      }
      skills.set(skill.name, { name: skill.name, path: skill.path });
      commands.push(command.data);
    }
  }
  return { skills, commands, warnings };
}

export function nativeThreadSkillInput(result: JsonObject, name: string): JsonObject | undefined {
  const skill = nativeSkills(result).skills.get(name);
  return skill ? { type: "skill", ...skill } : undefined;
}

export function nativeThreadCommands(skills: JsonObject) {
  const catalog = nativeSkills(skills);
  return harnessCommandCatalogSchema.parse({
    ...(catalog.warnings.length ? { warnings: catalog.warnings } : {}),
    source: "live",
    commands: [
      {
        id: "compact",
        invocation: "/compact",
        label: "Compact",
        description: "Summarize the conversation to free up context",
        argumentMode: "none",
      },
      {
        id: "review",
        invocation: "/review",
        label: "Review",
        description: "Review uncommitted changes; type /review instructions for a custom review",
        argumentMode: "none",
      },
      ...catalog.commands,
    ],
  });
}
