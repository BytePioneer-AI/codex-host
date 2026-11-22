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

export interface OmpNativeModelRef {
  provider: string;
  id: string;
}

export interface OmpNativeModel extends OmpNativeModelRef {
  reasoning: boolean;
}

const OMP_MODEL_REF_PREFIX = "omp-model-v1.";
const OMP_DRAFT_THINKING_OPTION_IDS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
].map((id) => harnessThinkingOptionIdSchema.parse(id));

const OMP_THINKING_LABELS: Readonly<Record<string, string>> = {
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
  if (value.trim().length === 0) throw new Error(`Omp ${name} must not be empty`);
}

function readableId({ provider, id }: OmpNativeModelRef): string {
  return `${provider}/${id}`;
}

function modelLabel({ provider, id }: OmpNativeModelRef): string {
  return `${provider} / ${id}`;
}

function encodedId({ provider, id }: OmpNativeModelRef): string {
  return `${OMP_MODEL_REF_PREFIX}${Buffer.from(JSON.stringify([provider, id])).toString("base64url")}`;
}

export function encodeOmpModelRef(
  model: OmpNativeModelRef,
  id = readableId(model),
): HarnessModelRef {
  assertNativePart(model.provider, "Model provider");
  assertNativePart(model.id, "Model id");
  return harnessModelRefSchema.parse({ id });
}

export function createOmpModelIndex(models: readonly OmpNativeModelRef[]) {
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
    ref: (model: OmpNativeModelRef) => {
      const id = idsByPair.get(JSON.stringify([model.provider, model.id]));
      return encodeOmpModelRef(
        model,
        id ?? (byId.has(readableId(model)) ? encodedId(model) : readableId(model)),
      );
    },
  };
}

export function resolveOmpModelRef(
  ref: HarnessModelRef,
  index: ReturnType<typeof createOmpModelIndex>,
): OmpNativeModelRef {
  const model = index.byId.get(ref.id);
  if (!model || ref.serviceTier) {
    throw new Error("Model Ref is not in the current Omp Model catalog");
  }
  return { provider: model.provider, id: model.id };
}

export function normalizeStoredOmpModelRef(
  ref: HarnessModelRef,
  catalog: HarnessModelCatalog,
): HarnessModelRef | undefined {
  if (!ref.id.startsWith(OMP_MODEL_REF_PREFIX) || ref.serviceTier) return undefined;
  let tuple: unknown;
  try {
    tuple = JSON.parse(
      Buffer.from(ref.id.slice(OMP_MODEL_REF_PREFIX.length), "base64url").toString("utf8"),
    );
  } catch {
    return undefined;
  }
  if (
    !Array.isArray(tuple) ||
    tuple.length !== 2 ||
    typeof tuple[0] !== "string" ||
    typeof tuple[1] !== "string"
  )
    return undefined;
  const native = { provider: tuple[0], id: tuple[1] };
  const encoded = encodedId(native);
  if (encoded !== ref.id) return undefined;
  const readable = readableId(native);
  return catalog.models.find(
    ({ ref, label }) => ref.id === encoded || (ref.id === readable && label === modelLabel(native)),
  )?.ref;
}

export function sameOmpModel(
  left: OmpNativeModelRef | null,
  right: OmpNativeModelRef | null,
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

export function normalizeOmpThinkingOptions(
  levels: readonly HarnessThinkingOptionId[],
): HarnessThinkingOption[] {
  return levels.map((id) =>
    harnessThinkingOptionSchema.parse({
      id,
      label: OMP_THINKING_LABELS[id] ?? fallbackThinkingLabel(id),
    }),
  );
}

export function normalizeOmpModelCatalog(
  nativeModels: readonly OmpNativeModel[],
  effectiveModel: OmpNativeModelRef | null,
  thinkingLevels: readonly HarnessThinkingOptionId[] | null,
  effectiveThinkingOptionId: HarnessThinkingOptionId | null,
): HarnessModelCatalog {
  const index = createOmpModelIndex(nativeModels);
  const byRef = new Map<
    string,
    { model: HarnessModelCatalog["models"][number]; reasoning: boolean }
  >();
  for (const native of nativeModels) {
    const ref = index.ref(native);
    const existing = byRef.get(ref.id);
    if (existing) {
      if (existing.reasoning !== native.reasoning) {
        throw new Error("Omp duplicate Model entries disagree on reasoning capability");
      }
      continue;
    }
    byRef.set(ref.id, {
      model: {
        ref,
        label: modelLabel(native),
      },
      reasoning: native.reasoning,
    });
  }
  const defaultModel = effectiveModel ? index.ref(effectiveModel) : undefined;
  if (defaultModel && !byRef.has(defaultModel.id)) {
    throw new Error("Omp effective Model is absent from the available Model catalog");
  }
  if (
    thinkingLevels &&
    effectiveThinkingOptionId &&
    !thinkingLevels.includes(effectiveThinkingOptionId)
  ) {
    throw new Error("Omp effective Thinking option is absent from the available option catalog");
  }
  if (thinkingLevels && !effectiveThinkingOptionId) {
    throw new Error("Omp did not report an effective Thinking option");
  }

  const thinkingOptions = thinkingLevels
    ? normalizeOmpThinkingOptions(OMP_DRAFT_THINKING_OPTION_IDS)
    : [];
  const allThinkingOptionIds = thinkingOptions.map(({ id }) => id);
  const offThinkingOptionId = thinkingOptions.find(({ id }) => id === "off")?.id;
  const models = [...byRef.values()]
    .map(({ model, reasoning }) => ({
      ...model,
      supportedThinkingOptionIds: reasoning
        ? allThinkingOptionIds
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
