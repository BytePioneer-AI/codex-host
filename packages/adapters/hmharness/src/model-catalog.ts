import { Buffer } from "node:buffer";

import {
  HARNESS_MODEL_REF_MAX_LENGTH,
  harnessModelCatalogSchema,
  harnessModelRefSchema,
  type HarnessModelCatalog,
  type HarnessModelRef,
} from "@codexhost/shared-contracts";

const MODEL_REF_PREFIX = "hmh-model-v1.";

export interface HmHarnessProvider {
  readonly name: string;
  readonly model: string;
  readonly purposes: readonly string[];
}

export interface HmHarnessProviderCatalog {
  readonly chat: string | null;
  readonly providers: readonly HmHarnessProvider[];
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`HMHarness ${label} must not be empty`);
  }
  return value;
}

export function parseHmHarnessProviderCatalog(stdout: string): HmHarnessProviderCatalog {
  const line = stdout
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .at(-1);
  if (!line) throw new Error("HMHarness provider catalog is empty");
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error("HMHarness provider catalog is not JSON");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("HMHarness provider catalog has an invalid root");
  }
  const root = parsed as Record<string, unknown>;
  const chat =
    root.chat === null || root.chat === undefined ? null : text(root.chat, "chat provider");
  const providers = root.providers;
  if (!Array.isArray(providers) || providers.length === 0) {
    throw new Error("HMHarness provider catalog has no models");
  }
  return {
    chat,
    providers: providers.map((value) => {
      if (typeof value !== "object" || value === null) {
        throw new Error("HMHarness provider entry is invalid");
      }
      const provider = value as Record<string, unknown>;
      return {
        name: text(provider.name, "provider name"),
        model: text(provider.model, "model"),
        purposes: Array.isArray(provider.purposes)
          ? provider.purposes.filter((purpose): purpose is string => typeof purpose === "string")
          : [],
      };
    }),
  };
}

export interface HmHarnessNativeModelRef {
  readonly provider: string;
  readonly model: string;
}

export function encodeHmHarnessModelRef(model: HmHarnessNativeModelRef): HarnessModelRef {
  const provider = text(model.provider, "provider name");
  const nativeModel = text(model.model, "model");
  const encoded = Buffer.from(JSON.stringify([provider, nativeModel]), "utf8").toString(
    "base64url",
  );
  const id = `${MODEL_REF_PREFIX}${encoded}`;
  if (id.length > HARNESS_MODEL_REF_MAX_LENGTH) {
    throw new Error("HMHarness Model identity is too long");
  }
  return harnessModelRefSchema.parse({ id });
}

export function decodeHmHarnessModelRef(ref: HarnessModelRef): HmHarnessNativeModelRef {
  const parsed = harnessModelRefSchema.parse(ref);
  if (!parsed.id.startsWith(MODEL_REF_PREFIX)) {
    throw new Error("HMHarness Model Ref belongs to another Adapter");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(
      Buffer.from(parsed.id.slice(MODEL_REF_PREFIX.length), "base64url").toString("utf8"),
    );
  } catch {
    throw new Error("HMHarness Model Ref is malformed");
  }
  if (
    !Array.isArray(decoded) ||
    decoded.length !== 2 ||
    typeof decoded[0] !== "string" ||
    typeof decoded[1] !== "string"
  ) {
    throw new Error("HMHarness Model Ref has an invalid native identity");
  }
  const native = { provider: decoded[0], model: decoded[1] };
  if (encodeHmHarnessModelRef(native).id !== parsed.id) {
    throw new Error("HMHarness Model Ref is not canonical");
  }
  return native;
}

export function normalizeHmHarnessModelCatalog(
  catalog: HmHarnessProviderCatalog,
): HarnessModelCatalog {
  const models = [...catalog.providers]
    .sort(
      (left, right) => left.name.localeCompare(right.name) || left.model.localeCompare(right.model),
    )
    .map((provider) => ({
      ref: encodeHmHarnessModelRef({ provider: provider.name, model: provider.model }),
      label: `${provider.name} / ${provider.model}`,
      resolvedModelLabel: provider.model,
    }));
  const refs = new Set(models.map(({ ref }) => ref.id));
  if (refs.size !== models.length)
    throw new Error("HMHarness provider catalog contains duplicates");
  const defaultModel =
    catalog.chat === null
      ? undefined
      : models.find(({ label }) => label.startsWith(`${catalog.chat} / `))?.ref;
  return harnessModelCatalogSchema.parse({
    models,
    ...(defaultModel ? { defaultModel } : {}),
    thinkingOptions: [],
  });
}
