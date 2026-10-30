import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { modelRef } from "@codexhost/adapter-codebuddy";
import type { HarnessModelCatalog } from "@codexhost/harness-adapter";
import {
  HARNESS_MODEL_LABEL_MAX_LENGTH,
  harnessModelCatalogSchema,
} from "@codexhost/shared-contracts";
import { workBuddyInvocation } from "./command.js";

const MAX_PRODUCT_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const PRODUCT_CONFIG_PATH_ENV = "ACC_PRODUCT_CONFIG_PATH";
const PRODUCT_CONFIG_INLINE_ENVS = [
  "ACC_PRODUCT_CONFIG_V3",
  "ACC_PRODUCT_CONFIG_V2",
  "ACC_PRODUCT_CONFIG",
] as const;
export interface WorkBuddyProductModel {
  id: string;
  name: string;
  credits?: string;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function nonBlank(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  const normalized = value.trim();
  return normalized || undefined;
}

export function parseWorkBuddyProductModels(value: unknown): WorkBuddyProductModel[] {
  const product = record(value);
  const models = product.models;
  const agents = product.agents;
  if (!Array.isArray(models) || !Array.isArray(agents)) return [];
  const cli = agents.map(record).find((agent) => nonBlank(agent.name) === "cli");
  if (!Array.isArray(cli?.models)) return [];
  const configuredIds = new Set(cli.models.map(nonBlank).filter((id): id is string => !!id));
  const parsed: WorkBuddyProductModel[] = [];
  const ids = new Set<string>();
  for (const value of models) {
    const source = record(value);
    const id = nonBlank(source.id);
    const name = nonBlank(source.name);
    if (!id || !name || !configuredIds.has(id) || ids.has(id)) continue;
    try {
      modelRef(id);
    } catch {
      continue;
    }
    ids.add(id);
    if (name.length > HARNESS_MODEL_LABEL_MAX_LENGTH) continue;
    const credits = nonBlank(source.credits);
    parsed.push({
      id,
      name,
      ...(credits && credits.length <= 64 ? { credits } : {}),
    });
  }
  return parsed;
}

async function readProductJson(file: string): Promise<unknown | undefined> {
  const metadata = await stat(file);
  if (!metadata.isFile() || metadata.size <= 0 || metadata.size > MAX_PRODUCT_SNAPSHOT_BYTES)
    return;
  return JSON.parse(await readFile(file, "utf8"));
}

function bundledFallbackProductPath(invocation: ReturnType<typeof workBuddyInvocation>) {
  const cli = invocation.arguments[0];
  if (!cli || cli.startsWith("-")) return;
  return path.join(path.dirname(path.dirname(cli)), "product.json");
}

export async function loadWorkBuddyProductModels(
  environment: NodeJS.ProcessEnv,
): Promise<WorkBuddyProductModel[]> {
  const invocation = workBuddyInvocation(environment, true);
  const productEnvironment = invocation.environment;
  const configuredPath = nonBlank(productEnvironment[PRODUCT_CONFIG_PATH_ENV]);
  if (configuredPath) {
    try {
      return parseWorkBuddyProductModels(await readProductJson(configuredPath));
    } catch {
      return [];
    }
  }
  for (const name of PRODUCT_CONFIG_INLINE_ENVS) {
    const inline = nonBlank(productEnvironment[name]);
    if (!inline) continue;
    try {
      return parseWorkBuddyProductModels(JSON.parse(inline));
    } catch {
      return [];
    }
  }
  const fallback = bundledFallbackProductPath(invocation);
  if (!fallback) return [];
  try {
    return parseWorkBuddyProductModels(await readProductJson(fallback));
  } catch {
    return [];
  }
}

function normalizedLabel(value: string): string {
  return value.trim().toLocaleLowerCase();
}

/** Native ACP Models stay first; product-file duplicates are removed by ID and display label. */
export function mergeWorkBuddyProductModels(
  catalog: HarnessModelCatalog,
  productModels: readonly WorkBuddyProductModel[],
): HarnessModelCatalog {
  const refs = new Set(catalog.models.map((model) => model.ref.id));
  const labels = new Set(catalog.models.map((model) => normalizedLabel(model.label)));
  const models = [...catalog.models];
  for (const productModel of productModels) {
    const ref = modelRef(productModel.id);
    const labelKey = normalizedLabel(productModel.name);
    if (refs.has(ref.id) || labels.has(labelKey)) continue;
    refs.add(ref.id);
    labels.add(labelKey);
    const creditLabel = productModel.credits?.replace(/^x/iu, "").replace(/\s*credits$/iu, "x");
    const annotatedLabel = creditLabel
      ? `${productModel.name} · ${creditLabel}`
      : productModel.name;
    models.push({
      ref,
      label:
        annotatedLabel.length <= HARNESS_MODEL_LABEL_MAX_LENGTH
          ? annotatedLabel
          : productModel.name,
    });
  }
  return harnessModelCatalogSchema.parse({ ...catalog, models });
}
