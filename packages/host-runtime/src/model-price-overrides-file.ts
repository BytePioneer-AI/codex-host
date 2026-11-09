import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  MODEL_PRICE_DEFAULT_METHOD,
  MODEL_PRICE_OVERRIDES_GET_METHOD,
  MODEL_PRICE_OVERRIDES_SET_METHOD,
  modelPriceDefaultParamsSchema,
  modelPriceOverridesGetSchema,
  modelPriceOverridesSetSchema,
  type ModelPriceDefaultResult,
  type ModelPriceOverrides,
  type ModelPriceOverridesSet,
} from "@codexhost/shared-contracts";

import { parseModelPriceOverrides, type ModelPriceCatalog } from "./model-prices.js";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface OverridesDocument {
  /** The parsed file, kept so a change preserves fields and entries it does not touch. */
  document: Record<string, unknown> | null;
  view: ModelPriceOverrides;
}

async function readDocument(file: string): Promise<OverridesDocument> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { document: null, view: { path: file, entries: [], error: null } };
    }
    return { document: null, view: { path: file, entries: [], error: errorMessage(error) } };
  }
  try {
    const document: unknown = JSON.parse(text);
    const entries = [...parseModelPriceOverrides(document)].map(([key, price]) => ({
      key,
      price,
    }));
    return {
      document: document as Record<string, unknown>,
      view: { path: file, entries, error: null },
    };
  } catch (error) {
    return { document: null, view: { path: file, entries: [], error: errorMessage(error) } };
  }
}

export class ModelPriceOverridesError extends Error {
  override name = "ModelPriceOverridesError";
}

/** The custom prices in `file`, or why the Host ignores it. */
export async function readModelPriceOverridesFile(file: string): Promise<ModelPriceOverrides> {
  return (await readDocument(file)).view;
}

/**
 * Applies one change to `file` and keeps every other entry and top-level field. An unusable
 * existing file is never overwritten, since the Host ignores it and the user's text would be lost.
 */
export async function updateModelPriceOverridesFile(
  file: string,
  change: ModelPriceOverridesSet,
): Promise<ModelPriceOverrides> {
  const current = await readDocument(file);
  if (current.view.error !== null) {
    throw new ModelPriceOverridesError(
      `${file} is invalid and was not changed: ${current.view.error}`,
    );
  }
  const document = current.document ?? { models: {} };
  const models = isRecord(document.models) ? document.models : {};
  const { key, price, previousKey } = change;
  // Model IDs are arbitrary strings such as `constructor` or `__proto__`: test own keys only,
  // and build the result with data properties so no key is read from or written to a prototype.
  if (previousKey !== undefined && !Object.hasOwn(models, previousKey)) {
    throw new ModelPriceOverridesError(`Custom price '${previousKey}' no longer exists`);
  }
  if (price !== null && key !== previousKey && Object.hasOwn(models, key)) {
    throw new ModelPriceOverridesError(`Custom price '${key}' already exists`);
  }
  const entries: Array<[string, unknown]> = [];
  for (const [existing, value] of Object.entries(models)) {
    if (existing === previousKey) {
      if (price !== null) entries.push([key, price]);
    } else if (existing !== key) {
      entries.push([existing, value]);
    }
  }
  if (price !== null && previousKey === undefined) entries.push([key, price]);
  const next = Object.fromEntries(entries);
  const updated = { ...document, models: next };
  // The Host must accept what it writes; this also rejects anything the contract let through.
  parseModelPriceOverrides(updated);
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(updated, null, 2)}\n`, { flag: "wx" });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
  return (await readDocument(file)).view;
}

export function isModelPriceOverridesMethod(method: string): boolean {
  return (
    method === MODEL_PRICE_OVERRIDES_GET_METHOD ||
    method === MODEL_PRICE_OVERRIDES_SET_METHOD ||
    method === MODEL_PRICE_DEFAULT_METHOD
  );
}

function parsed<T>(result: { success: true; data: T } | { success: false }): T {
  if (!result.success) throw new ModelPriceOverridesError("Invalid custom model price");
  return result.data;
}

/** Changes in this process apply one at a time, so concurrent saves keep each other's entries. */
let pendingUpdate: Promise<unknown> = Promise.resolve();

/** Serves the custom price methods from the catalog's own `pricing.json`. */
export async function handleModelPriceOverridesRequest(
  catalog: ModelPriceCatalog,
  method: string,
  params: unknown,
): Promise<ModelPriceOverrides | ModelPriceDefaultResult> {
  if (method === MODEL_PRICE_DEFAULT_METHOD) {
    const { model } = parsed(modelPriceDefaultParamsSchema.safeParse(params ?? {}));
    return { price: catalog.defaultPrice(model), suggestions: catalog.similarPrices(model) };
  }
  const file = catalog.overridesPath;
  if (!file) throw new ModelPriceOverridesError("Custom prices are unavailable on this Host");
  if (method === MODEL_PRICE_OVERRIDES_SET_METHOD) {
    const change = parsed(modelPriceOverridesSetSchema.safeParse(params));
    const update = pendingUpdate.then(() => updateModelPriceOverridesFile(file, change));
    pendingUpdate = update.catch(() => undefined);
    return await update;
  }
  parsed(modelPriceOverridesGetSchema.safeParse(params ?? {}));
  return await readModelPriceOverridesFile(file);
}
