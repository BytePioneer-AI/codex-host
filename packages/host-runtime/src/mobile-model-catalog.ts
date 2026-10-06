import { createHash } from "node:crypto";
import type { HarnessAdapter } from "@codexhost/harness-adapter";
import {
  harnessIdSchema,
  encodeHarnessPluginRoute,
  type HarnessPluginDescriptor,
  type HarnessInspection,
} from "@codexhost/shared-contracts";
import type { ExternalHarnessId, JsonObject } from "@codexhost/protocol-core";

/** Native capability-derived entries, never copied from an unrelated official Model. */
export async function mobileModelCatalog(
  adapters: ReadonlyMap<ExternalHarnessId, HarnessAdapter>,
  descriptors: ReadonlyMap<string, HarnessPluginDescriptor>,
): Promise<JsonObject[]> {
  const entries: JsonObject[] = [];
  for (const [harnessId, adapter] of adapters) {
    let initial: HarnessInspection;
    try {
      initial = await adapter.inspect({});
    } catch {
      continue;
    }
    {
      const inspection = initial;
      if (inspection.status !== "ready") continue;
      const catalog = inspection.catalog;
      for (const candidate of catalog.models) {
        for (const fast of [false, true]) {
          const ref = fast ? candidate.fastModel : candidate.ref;
          if (!ref) continue;
          const route = encodeHarnessPluginRoute({
            harnessId: harnessIdSchema.parse(harnessId),
            model: ref,
          });
          const efforts = catalog.thinkingOptions.filter((option) =>
            candidate.supportedThinkingOptionIds?.includes(option.id),
          );
          const defaultEffort =
            efforts.find((option) => option.id === catalog.defaultThinkingOptionId)?.id ??
            efforts[0]?.id ??
            "none";
          const sourceName = descriptors.get(harnessId)?.name ?? harnessId;
          entries.push({
            id: route,
            model: route,
            displayName: `${candidate.label}${fast ? " · Fast" : ""}`,
            description: `Harness: ${sourceName}`,
            hidden: false,
            isDefault: false,
            upgrade: null,
            upgradeInfo: null,
            availabilityNux: null,
            supportedReasoningEfforts: (efforts.length
              ? efforts
              : [{ id: "none", label: "Default" }]
            ).map((option) => ({ reasoningEffort: option.id, description: option.label })),
            defaultReasoningEffort: defaultEffort,
            inputModalities: ["text"],
            supportsPersonality: false,
            multiAgentVersion: null,
            additionalSpeedTiers: [],
            serviceTiers: [],
            defaultServiceTier: null,
            availableAccessPrograms: null,
          });
        }
      }
    }
  }
  return entries;
}

export function mobileCatalogPage(data: JsonObject[], params: JsonObject): JsonObject {
  const fingerprint = createHash("sha256").update(JSON.stringify(data)).digest("hex").slice(0, 16);
  let offset = 0;
  if (params.cursor != null) {
    if (typeof params.cursor !== "string") throw new Error("Invalid model catalog cursor");
    const match = /^mobile-models:([a-f0-9]{16}):(\d+)$/.exec(params.cursor);
    if (!match || match[1] !== fingerprint)
      throw new Error("Model catalog changed; reload from the first page");
    offset = Number(match[2]);
    if (!Number.isSafeInteger(offset) || offset > data.length)
      throw new Error("Invalid model catalog offset");
  }
  const limit = params.limit == null ? 100 : params.limit;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 200)
    throw new Error("Model page limit must be between 1 and 200");
  return {
    data: data.slice(offset, offset + limit),
    nextCursor:
      offset + limit < data.length ? `mobile-models:${fingerprint}:${offset + limit}` : null,
  };
}
