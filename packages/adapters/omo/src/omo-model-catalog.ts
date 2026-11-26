import { compositeModelRefIds } from "@codexhost/harness-adapter";
import type { HarnessError } from "@codexhost/harness-adapter";
import {
  harnessModelCatalogSchema,
  harnessModelRefSchema,
  harnessThinkingOptionIdSchema,
  harnessThinkingOptionSchema,
  type HarnessModelCatalog,
  type HarnessThinkingOption,
  type HarnessThinkingOptionId,
} from "@codexhost/shared-contracts";

/**
 * The Thinking levels `omo --mode rpc` accepts (`set_thinking_level`). `xhigh` and
 * `max` are only offered by Models that support them.
 */
export const OMO_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type OmoThinkingLevel = (typeof OMO_THINKING_LEVELS)[number];

const OMO_THINKING_LABELS: Readonly<Record<OmoThinkingLevel, string>> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};

/**
 * Native Thinking level to Harness Thinking option ID. The enum is mapped one to one:
 * every level has a target, and no ID outside this table is produced.
 */
export const OMO_THINKING_OPTION_IDS: Readonly<Record<OmoThinkingLevel, HarnessThinkingOptionId>> =
  {
    off: harnessThinkingOptionIdSchema.parse("off"),
    minimal: harnessThinkingOptionIdSchema.parse("minimal"),
    low: harnessThinkingOptionIdSchema.parse("low"),
    medium: harnessThinkingOptionIdSchema.parse("medium"),
    high: harnessThinkingOptionIdSchema.parse("high"),
    xhigh: harnessThinkingOptionIdSchema.parse("xhigh"),
    max: harnessThinkingOptionIdSchema.parse("max"),
  };

export const OMO_THINKING_OPTIONS: readonly HarnessThinkingOption[] = OMO_THINKING_LEVELS.map(
  (level) =>
    harnessThinkingOptionSchema.parse({
      id: OMO_THINKING_OPTION_IDS[level],
      label: OMO_THINKING_LABELS[level],
    }),
);

const OMO_MODEL_REF_PREFIX = "omo-model-v1.";

/** A Model row from `get_available_models`, with the fields the catalog publishes. */
export interface OmoNativeModel {
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow?: number;
  maxTokens?: number;
}

export interface OmoRejectedModelRow {
  index: number;
  error: HarnessError;
}

export interface OmoModelCatalog {
  catalog: HarnessModelCatalog;
  /** Accepted rows in response order, carrying the native limits the catalog cannot hold. */
  models: readonly OmoNativeModel[];
  rejected: readonly OmoRejectedModelRow[];
}

/** A `get_available_models` response that cannot be read at all. */
export class OmoModelCatalogProtocolError extends Error {
  readonly code = "protocolError" as const;

  constructor(message: string) {
    super(message);
    this.name = "OmoModelCatalogProtocolError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function pairKey(model: { provider: string; id: string }): string {
  return JSON.stringify([model.provider, model.id]);
}

function encodedRefId({ provider, model }: { provider: string; model: string }): string {
  return `${OMO_MODEL_REF_PREFIX}${Buffer.from(JSON.stringify([provider, model])).toString("base64url")}`;
}

function protocolError(message: string): HarnessError {
  return { code: "protocolError", message, retryable: false };
}

function parseModelRow(value: unknown, index: number): OmoNativeModel | HarnessError {
  if (!isRecord(value)) {
    return protocolError(`OmO Model catalog row ${index} is not an object`);
  }
  if (!nonBlankString(value.provider)) {
    return protocolError(`OmO Model catalog row ${index} has no provider`);
  }
  if (!nonBlankString(value.id)) {
    return protocolError(`OmO Model catalog row ${index} has no Model id`);
  }
  if (typeof value.reasoning !== "boolean") {
    return protocolError(`OmO Model catalog row ${index} has no reasoning capability`);
  }
  // The native context window and output limit are advisory metadata: an unusable
  // value is dropped, it does not make the Model unusable.
  const contextWindow = positiveInteger(value.contextWindow);
  const maxTokens = positiveInteger(value.maxTokens);
  return {
    provider: value.provider,
    id: value.id,
    name: nonBlankString(value.name) ? value.name : `${value.provider} / ${value.id}`,
    reasoning: value.reasoning,
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
  };
}

function isHarnessError(value: OmoNativeModel | HarnessError): value is HarnessError {
  return "code" in value;
}

/**
 * Maps a `get_available_models` response `data` payload to a Harness Model Catalog.
 * Rows missing a Provider or Model id are reported as typed protocol errors and
 * skipped; the remaining rows still produce a catalog.
 */
export function normalizeOmoModelCatalog(data: unknown): OmoModelCatalog {
  if (!isRecord(data) || !Array.isArray(data.models)) {
    throw new OmoModelCatalogProtocolError("OmO get_available_models response has no models array");
  }
  const rejected: OmoRejectedModelRow[] = [];
  const accepted: OmoNativeModel[] = [];
  const byPair = new Map<string, OmoNativeModel>();
  for (const [index, value] of data.models.entries()) {
    const parsed = parseModelRow(value, index);
    if (isHarnessError(parsed)) {
      rejected.push({ index, error: parsed });
      continue;
    }
    const key = pairKey(parsed);
    const previous = byPair.get(key);
    if (previous) {
      if (
        previous.reasoning !== parsed.reasoning ||
        previous.contextWindow !== parsed.contextWindow ||
        previous.maxTokens !== parsed.maxTokens
      ) {
        rejected.push({
          index,
          error: protocolError(
            `OmO Model catalog row ${index} repeats ${parsed.provider}/${parsed.id} with different capabilities`,
          ),
        });
      }
      continue;
    }
    byPair.set(key, parsed);
    accepted.push(parsed);
  }
  const refIdsByPair = new Map<string, string>();
  const refEntries = accepted.map(({ provider, id }) => ({ provider, model: id, id }));
  for (const [refId, entry] of compositeModelRefIds(refEntries, encodedRefId)) {
    refIdsByPair.set(pairKey({ provider: entry.provider, id: entry.id }), refId);
  }
  const models = accepted
    .map((model) => {
      const refId = refIdsByPair.get(pairKey(model));
      if (refId === undefined) {
        throw new OmoModelCatalogProtocolError(
          `OmO Model ${model.provider}/${model.id} has no Model Ref`,
        );
      }
      return {
        ref: harnessModelRefSchema.parse({ id: refId }),
        label: model.name,
        supportedThinkingOptionIds: model.reasoning
          ? OMO_THINKING_LEVELS.map((level) => OMO_THINKING_OPTION_IDS[level])
          : [OMO_THINKING_OPTION_IDS.off],
      };
    })
    .sort(
      (left, right) =>
        (left.label < right.label ? -1 : left.label > right.label ? 1 : 0) ||
        (left.ref.id < right.ref.id ? -1 : left.ref.id > right.ref.id ? 1 : 0),
    );
  return {
    catalog: harnessModelCatalogSchema.parse({ models, thinkingOptions: OMO_THINKING_OPTIONS }),
    models: accepted,
    rejected,
  };
}
