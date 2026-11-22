import { compositeModelRefIds } from "@codexhost/harness-adapter";
import {
  harnessModelCatalogSchema,
  harnessModelRefSchema,
  harnessThinkingOptionIdSchema,
  harnessThinkingOptionSchema,
  type HarnessModelCatalog,
  type HarnessModelRef,
  type HarnessThinkingOption,
  type HarnessThinkingOptionId,
} from "@codexhost/shared-contracts";
import { supportsPiFastModel } from "./pi-fast-mode.js";

export interface PiNativeModelRef {
  provider: string;
  id: string;
  fast?: boolean;
}

export interface PiNativeModel extends PiNativeModelRef {
  reasoning: boolean;
  api?: string;
}

const PI_MODEL_REF_PREFIX = "pi-model-v1.";
const PI_DRAFT_THINKING_OPTION_IDS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
].map((id) => harnessThinkingOptionIdSchema.parse(id));

const PI_THINKING_LABELS: Readonly<Record<string, string>> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertNativePart(value: string, name: string): void {
  if (value.trim().length === 0) throw new Error(`Pi ${name} must not be empty`);
}

function readableId({ provider, id }: PiNativeModelRef): string {
  return `${provider}/${id}`;
}

function modelLabel({ provider, id }: PiNativeModelRef): string {
  return `${provider} / ${id}`;
}

function encodedId({ provider, id }: PiNativeModelRef, legacyFast = false): string {
  const tuple = legacyFast ? [provider, id, true] : [provider, id];
  return `${PI_MODEL_REF_PREFIX}${Buffer.from(JSON.stringify(tuple)).toString("base64url")}`;
}

export function encodePiModelRef(model: PiNativeModelRef, id = readableId(model)): HarnessModelRef {
  assertNativePart(model.provider, "Model provider");
  assertNativePart(model.id, "Model id");
  return harnessModelRefSchema.parse({
    id,
    ...(model.fast ? { serviceTier: "priority" } : {}),
  });
}

export function createPiModelIndex(models: readonly PiNativeModelRef[]) {
  const entries = new Map(
    models.map(({ provider, id }) => [JSON.stringify([provider, id]), { provider, model: id, id }]),
  );
  const byId = compositeModelRefIds([...entries.values()], (entry) => encodedId(entry));
  const idsByPair = new Map(
    [...byId].map(([id, entry]) => [JSON.stringify([entry.provider, entry.model]), id]),
  );
  return {
    models,
    byId,
    ref: (model: PiNativeModelRef) => {
      const id = idsByPair.get(JSON.stringify([model.provider, model.id]));
      return encodePiModelRef(
        model,
        id ?? (byId.has(readableId(model)) ? encodedId(model) : readableId(model)),
      );
    },
  };
}

export function resolvePiModelRef(
  ref: HarnessModelRef,
  index: ReturnType<typeof createPiModelIndex>,
): PiNativeModelRef {
  const model = index.byId.get(ref.id);
  if (!model || ref.serviceTier === "ultrafast") {
    throw new Error("Model Ref is not in the current Pi Model catalog");
  }
  return { provider: model.provider, id: model.id, ...(ref.serviceTier ? { fast: true } : {}) };
}

export function normalizeStoredPiModelRef(
  ref: HarnessModelRef,
  catalog: HarnessModelCatalog,
): HarnessModelRef | undefined {
  if (!ref.id.startsWith(PI_MODEL_REF_PREFIX) || ref.serviceTier === "ultrafast") return undefined;
  let tuple: unknown;
  try {
    tuple = JSON.parse(
      Buffer.from(ref.id.slice(PI_MODEL_REF_PREFIX.length), "base64url").toString("utf8"),
    );
  } catch {
    return undefined;
  }
  if (
    !Array.isArray(tuple) ||
    (tuple.length !== 2 && !(tuple.length === 3 && tuple[2] === true)) ||
    typeof tuple[0] !== "string" ||
    typeof tuple[1] !== "string"
  )
    return undefined;
  const native = { provider: tuple[0], id: tuple[1] };
  const legacyFast = tuple[2] === true;
  if (encodedId(native, legacyFast) !== ref.id || (legacyFast && ref.serviceTier)) return undefined;
  const fast = legacyFast || ref.serviceTier === "priority";
  const encoded = encodedId(native);
  const readable = readableId(native);
  const entry = catalog.models.find(
    ({ ref, label }) => ref.id === encoded || (ref.id === readable && label === modelLabel(native)),
  );
  return fast ? entry?.fastModel : entry?.ref;
}

export function samePiModel(
  left: PiNativeModelRef | null,
  right: PiNativeModelRef | null,
): boolean {
  return left === null
    ? right === null
    : right !== null && left.provider === right.provider && left.id === right.id;
}

function fallbackThinkingLabel(id: string): string {
  const label = id
    .split(/[._~-]+/u)
    .filter((part) => part.length > 0)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
  return label || id;
}

export function normalizePiThinkingOptions(
  levels: readonly HarnessThinkingOptionId[],
): HarnessThinkingOption[] {
  return levels.map((id) =>
    harnessThinkingOptionSchema.parse({
      id,
      label: PI_THINKING_LABELS[id] ?? fallbackThinkingLabel(id),
    }),
  );
}

export function normalizePiModelCatalog(
  nativeModels: readonly PiNativeModel[],
  effectiveModel: PiNativeModelRef | null,
  thinkingLevels: readonly HarnessThinkingOptionId[] | null,
  effectiveThinkingOptionId: HarnessThinkingOptionId | null,
  effectiveModelReasoning: boolean | null = null,
  fastSupported = false,
): HarnessModelCatalog {
  const index = createPiModelIndex(
    effectiveModel ? [...nativeModels, effectiveModel] : nativeModels,
  );
  const byRef = new Map<
    string,
    { model: HarnessModelCatalog["models"][number]; reasoning: boolean; synthesized: boolean }
  >();
  for (const native of nativeModels) {
    const ref = index.ref(native);
    const fastModel =
      fastSupported && supportsPiFastModel(native)
        ? { id: ref.id, serviceTier: "priority" as const }
        : undefined;
    const existing = byRef.get(ref.id);
    if (existing) {
      if (existing.reasoning !== native.reasoning) {
        throw new Error("Pi duplicate Model entries disagree on reasoning capability");
      }
      if (fastModel) existing.model.fastModel = fastModel;
      continue;
    }
    byRef.set(ref.id, {
      model: {
        ref,
        label: modelLabel(native),
        ...(fastModel ? { fastModel } : {}),
      },
      reasoning: native.reasoning,
      synthesized: false,
    });
  }
  const defaultModel = effectiveModel ? index.ref(effectiveModel) : undefined;
  if (effectiveModel && defaultModel && !byRef.has(defaultModel.id)) {
    // Pi resolves its effective Model from the full Model registry plus configured auth, while
    // `get_available_models` lists only currently offered Models (a Provider may filter them, for
    // example by subscription entitlement). The Session keeps running with that Model, so the
    // Catalog must publish it as the current native selection instead of failing inspection.
    const reasoning =
      (effectiveThinkingOptionId && effectiveThinkingOptionId !== "off") ||
      (effectiveModelReasoning ??
        Boolean(thinkingLevels && thinkingLevels.some((level) => level !== "off")));
    byRef.set(defaultModel.id, {
      model: {
        ref: defaultModel,
        label: modelLabel(effectiveModel),
      },
      reasoning,
      synthesized: true,
    });
  }
  if (
    thinkingLevels &&
    effectiveThinkingOptionId &&
    !thinkingLevels.includes(effectiveThinkingOptionId)
  ) {
    throw new Error("Pi effective Thinking option is absent from the available option catalog");
  }
  if (thinkingLevels && !effectiveThinkingOptionId) {
    throw new Error("Pi did not report an effective Thinking option");
  }

  const thinkingOptions = thinkingLevels
    ? normalizePiThinkingOptions(PI_DRAFT_THINKING_OPTION_IDS)
    : [];
  const allThinkingOptionIds = thinkingOptions.map(({ id }) => id);
  const offThinkingOptionId = thinkingOptions.find(({ id }) => id === "off")?.id;
  // `thinkingLevels` are the levels Pi supports for its current Model, which is exactly the
  // synthesized effective Model. Other Models have no per-Model evidence, so they keep the draft set.
  // Without reported levels the Catalog offers no Thinking options at all, so the synthesized Model
  // falls back to the same empty set as every other Model.
  const effectiveThinkingOptionIds = thinkingLevels
    ? allThinkingOptionIds.filter((id) => thinkingLevels.includes(id))
    : allThinkingOptionIds;
  const models = [...byRef.values()]
    .map(({ model, reasoning, synthesized }) => ({
      ...model,
      supportedThinkingOptionIds: reasoning
        ? synthesized
          ? effectiveThinkingOptionIds
          : allThinkingOptionIds
        : offThinkingOptionId
          ? [offThinkingOptionId]
          : [],
    }))
    .sort(
      (left, right) =>
        compareText(left.label, right.label) || compareText(left.ref.id, right.ref.id),
    );
  const defaultThinkingOptionId = thinkingOptions.find(
    ({ id }) => id === effectiveThinkingOptionId,
  )?.id;
  return harnessModelCatalogSchema.parse({
    models,
    ...(defaultModel ? { defaultModel } : {}),
    thinkingOptions,
    ...(defaultThinkingOptionId ? { defaultThinkingOptionId } : {}),
  });
}
