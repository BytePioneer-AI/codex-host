import type { JsonObject, JsonValue } from "@codexhost/protocol-core";
import {
  harnessCommandCatalogSchema,
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

export function nativeThreadCommands(skills: JsonObject) {
  return harnessCommandCatalogSchema.parse({
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
        description: "Review uncommitted changes, or follow your review instructions",
        argumentMode: "text",
      },
      ...(Array.isArray(skills.data) ? skills.data : []).flatMap((entry) =>
        isRecord(entry) && Array.isArray(entry.skills)
          ? entry.skills.flatMap((skill) =>
              isRecord(skill) && skill.enabled === true && typeof skill.name === "string"
                ? [
                    {
                      id: `skill:${skill.name}`,
                      invocation: `$${skill.name}`,
                      label: skill.name,
                      ...(typeof skill.description === "string" && skill.description
                        ? { description: skill.description.slice(0, 512) }
                        : {}),
                      argumentMode: "text",
                      kind: "skill",
                    },
                  ]
                : [],
            )
          : [],
      ),
    ],
  });
}
