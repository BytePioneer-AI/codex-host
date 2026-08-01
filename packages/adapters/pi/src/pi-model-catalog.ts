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

export interface PiNativeModelRef {
  provider: string;
  id: string;
}

export interface PiNativeModel extends PiNativeModelRef {
  reasoning: boolean;
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

export function encodePiModelRef(model: PiNativeModelRef): HarnessModelRef {
  assertNativePart(model.provider, "Model provider");
  assertNativePart(model.id, "Model id");
  const encoded = Buffer.from(JSON.stringify([model.provider, model.id]), "utf8").toString(
    "base64url",
  );
  return harnessModelRefSchema.parse({ id: `${PI_MODEL_REF_PREFIX}${encoded}` });
}

export function decodePiModelRef(ref: HarnessModelRef): PiNativeModelRef {
  const parsedRef = harnessModelRefSchema.parse(ref);
  if (!parsedRef.id.startsWith(PI_MODEL_REF_PREFIX)) {
    throw new Error("Model Ref does not belong to PiAdapter");
  }
  const encoded = parsedRef.id.slice(PI_MODEL_REF_PREFIX.length);
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new Error("Pi Model Ref is malformed");
  }
  if (
    !Array.isArray(decoded) ||
    decoded.length !== 2 ||
    typeof decoded[0] !== "string" ||
    typeof decoded[1] !== "string"
  ) {
    throw new Error("Pi Model Ref has an invalid native identity");
  }
  const native = { provider: decoded[0], id: decoded[1] };
  assertNativePart(native.provider, "Model provider");
  assertNativePart(native.id, "Model id");
  if (encodePiModelRef(native).id !== parsedRef.id) {
    throw new Error("Pi Model Ref is not canonical");
  }
  return native;
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
): HarnessModelCatalog {
  const byRef = new Map<
    string,
    { model: HarnessModelCatalog["models"][number]; reasoning: boolean }
  >();
  for (const native of nativeModels) {
    const ref = encodePiModelRef(native);
    const existing = byRef.get(ref.id);
    if (existing) {
      if (existing.reasoning !== native.reasoning) {
        throw new Error("Pi duplicate Model entries disagree on reasoning capability");
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
  const defaultModel = effectiveModel ? encodePiModelRef(effectiveModel) : undefined;
  if (defaultModel && !byRef.has(defaultModel.id)) {
    throw new Error("Pi effective Model is absent from the available Model catalog");
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
