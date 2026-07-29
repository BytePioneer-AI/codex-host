import {
  harnessModelCatalogSchema,
  harnessModelRefSchema,
  type HarnessModelCatalog,
  type HarnessModelRef,
} from "@codexhost/shared-contracts";

export interface PiNativeModelRef {
  provider: string;
  id: string;
}

const PI_MODEL_REF_PREFIX = "pi-model-v1.";

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

export function normalizePiModelCatalog(
  nativeModels: readonly PiNativeModelRef[],
  effectiveModel: PiNativeModelRef | null,
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
  return harnessModelCatalogSchema.parse({
    models,
    ...(defaultModel ? { defaultModel } : {}),
  });
}
