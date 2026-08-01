import {
  harnessModelCatalogSchema,
  harnessModelRefSchema,
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

const PI_MODEL_REF_PREFIX = "pi-model-v1.";

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
  nativeModels: readonly PiNativeModelRef[],
  effectiveModel: PiNativeModelRef | null,
  thinkingLevels: readonly HarnessThinkingOptionId[] | null,
  effectiveThinkingOptionId: HarnessThinkingOptionId | null,
): HarnessModelCatalog {
  const byRef = new Map<string, HarnessModelCatalog["models"][number]>();
  for (const native of nativeModels) {
    const ref = encodePiModelRef(native);
    if (!byRef.has(ref.id)) {
      byRef.set(ref.id, {
        ref,
        label: `${native.provider} / ${native.id}`,
      });
    }
  }
  const models = [...byRef.values()].sort(
    (left, right) => compareText(left.label, right.label) || compareText(left.ref.id, right.ref.id),
  );
  const defaultModel = effectiveModel ? encodePiModelRef(effectiveModel) : undefined;
  if (defaultModel && !byRef.has(defaultModel.id)) {
    throw new Error("Pi effective Model is absent from the available Model catalog");
  }
  const thinkingOptions = normalizePiThinkingOptions(thinkingLevels ?? []);
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
  const supportedThinkingOptionIds = thinkingOptions.map(({ id }) => id);
  const normalizedModels = models.map((model) =>
    model.ref.id === defaultModel?.id && thinkingLevels
      ? { ...model, supportedThinkingOptionIds }
      : model,
  );
  return harnessModelCatalogSchema.parse({
    models: normalizedModels,
    ...(defaultModel ? { defaultModel } : {}),
    thinkingOptions,
    ...(thinkingLevels && effectiveThinkingOptionId
      ? { defaultThinkingOptionId: effectiveThinkingOptionId }
      : {}),
  });
}
