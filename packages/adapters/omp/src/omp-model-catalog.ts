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

export function encodeOmpModelRef(model: OmpNativeModelRef): HarnessModelRef {
  assertNativePart(model.provider, "Model provider");
  assertNativePart(model.id, "Model id");
  const encoded = Buffer.from(JSON.stringify([model.provider, model.id]), "utf8").toString(
    "base64url",
  );
  return harnessModelRefSchema.parse({ id: `${OMP_MODEL_REF_PREFIX}${encoded}` });
}

export function decodeOmpModelRef(ref: HarnessModelRef): OmpNativeModelRef {
  const parsedRef = harnessModelRefSchema.parse(ref);
  if (!parsedRef.id.startsWith(OMP_MODEL_REF_PREFIX)) {
    throw new Error("Model Ref does not belong to OmpAdapter");
  }
  const encoded = parsedRef.id.slice(OMP_MODEL_REF_PREFIX.length);
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new Error("Omp Model Ref is malformed");
  }
  if (
    !Array.isArray(decoded) ||
    decoded.length !== 2 ||
    typeof decoded[0] !== "string" ||
    typeof decoded[1] !== "string"
  ) {
    throw new Error("Omp Model Ref has an invalid native identity");
  }
  const native = { provider: decoded[0], id: decoded[1] };
  assertNativePart(native.provider, "Model provider");
  assertNativePart(native.id, "Model id");
  if (encodeOmpModelRef(native).id !== parsedRef.id) {
    throw new Error("Omp Model Ref is not canonical");
  }
  return native;
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
  const byRef = new Map<
    string,
    { model: HarnessModelCatalog["models"][number]; reasoning: boolean }
  >();
  for (const native of nativeModels) {
    const ref = encodeOmpModelRef(native);
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
        label: `${native.provider} / ${native.id}`,
      },
      reasoning: native.reasoning,
    });
  }
  const defaultModel = effectiveModel ? encodeOmpModelRef(effectiveModel) : undefined;
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
