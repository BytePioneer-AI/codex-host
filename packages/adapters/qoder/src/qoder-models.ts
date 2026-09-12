import { Buffer } from "node:buffer";
import {
  HARNESS_MODEL_LABEL_MAX_LENGTH,
  HARNESS_MODEL_REF_MAX_LENGTH,
  harnessModelCatalogSchema,
  harnessModelRefSchema,
  type HarnessModel,
  type HarnessModelCatalog,
  type HarnessModelRef,
} from "@codexhost/shared-contracts";
import { z } from "zod";
import type { QoderModelInfo } from "./qoder-sdk-types.js";

const QODER_MODEL_REF_PREFIX = "qoder-model-v1.";
const QODER_MODEL_VALUE_MAX_LENGTH = 512;

export const QODER_DEFAULT_MODEL_REF = encodeQoderModelRef("default");

export function encodeQoderModelRef(value: string): HarnessModelRef {
  const parsed = z.string().trim().min(1).max(QODER_MODEL_VALUE_MAX_LENGTH).parse(value);
  const id = `${QODER_MODEL_REF_PREFIX}${Buffer.from(parsed, "utf8").toString("base64url")}`;
  if (id.length > HARNESS_MODEL_REF_MAX_LENGTH) {
    throw new Error("Qoder Model value is too long for a Model Ref");
  }
  return harnessModelRefSchema.parse({ id });
}

export function decodeQoderModelRef(ref: HarnessModelRef): string | undefined {
  const parsed = harnessModelRefSchema.parse(ref);
  if (!parsed.id.startsWith(QODER_MODEL_REF_PREFIX)) {
    throw new Error("Qoder Model Ref belongs to another Adapter");
  }
  const encoded = parsed.id.slice(QODER_MODEL_REF_PREFIX.length);
  if (encoded.length === 0) throw new Error("Qoder Model Ref is empty");
  try {
    return Buffer.from(encoded, "base64url").toString("utf8");
  } catch {
    throw new Error("Qoder Model Ref is not valid base64url");
  }
}

export function parseQoderModelCatalog(rawModels?: unknown[]): HarnessModelCatalog {
  const models: HarnessModel[] = [];
  const seenRefs = new Set<string>();

  if (Array.isArray(rawModels)) {
    for (const item of rawModels) {
      if (typeof item === "object" && item !== null) {
        const raw = item as Record<string, unknown>;
        const value = typeof raw.value === "string" && raw.value.trim().length > 0
          ? raw.value.trim()
          : typeof raw.id === "string" && raw.id.trim().length > 0
            ? raw.id.trim()
            : undefined;
        if (!value) continue;

        const labelCandidate = typeof raw.displayName === "string" && raw.displayName.trim().length > 0
          ? raw.displayName.trim()
          : typeof raw.name === "string" && raw.name.trim().length > 0
            ? raw.name.trim()
            : value;
        const label = labelCandidate.slice(0, HARNESS_MODEL_LABEL_MAX_LENGTH);

        const ref = encodeQoderModelRef(value);
        if (!seenRefs.has(ref.id)) {
          seenRefs.add(ref.id);
          models.push({
            ref,
            label,
          });
        }
      }
    }
  }

  if (models.length === 0) {
    models.push({
      ref: QODER_DEFAULT_MODEL_REF,
      label: "Default",
    });
  }

  const defaultModel = models[0]!.ref;

  return harnessModelCatalogSchema.parse({
    models,
    defaultModel,
    thinkingOptions: [],
  });
}
