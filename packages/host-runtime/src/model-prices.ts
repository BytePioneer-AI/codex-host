import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { bundledModelPrices } from "./model-prices.generated.js";

/**
 * USD per million Tokens: [input, output, cacheRead, cacheWrite, canonical]. Cache prices are
 * null when unknown. canonical is `true` when the entry is its model's official listing, or the
 * official `provider/model` ID when it is a resale listing.
 */
export type ModelPriceEntry =
  | readonly [number, number]
  | readonly [number, number, number | null]
  | readonly [number, number, number | null, number | null]
  | readonly [number, number, number | null, number | null, string | true];

export interface ModelPriceTableData {
  fetchedAtMs: number;
  providers: Record<string, Record<string, ModelPriceEntry>>;
}

export interface ModelPrice {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export const MODELS_DEV_URL = "https://models.dev/api.json";
const REFRESH_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 30_000;
/** A refreshed table smaller than this is treated as a broken response, not a price change. */
const MINIMUM_PRICED_MODELS = 1_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function price(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Converts the models.dev catalog into the compact table; throws when it is unusable. */
export function compactModelsDev(api: unknown): ModelPriceTableData["providers"] {
  if (!isRecord(api)) throw new Error("models.dev catalog must be an object");
  const providers: ModelPriceTableData["providers"] = {};
  let count = 0;
  for (const [providerId, provider] of Object.entries(api)) {
    if (!isRecord(provider) || !isRecord(provider.models)) continue;
    for (const [modelId, model] of Object.entries(provider.models)) {
      if (!isRecord(model) || !isRecord(model.cost)) continue;
      const input = price(model.cost.input);
      const output = price(model.cost.output);
      if (input === null || output === null) continue;
      const cacheRead = price(model.cost.cache_read);
      const cacheWrite = price(model.cost.cache_write);
      const canonicalId =
        typeof model.canonical_model_id === "string" && model.canonical_model_id.length > 0
          ? model.canonical_model_id
          : null;
      const canonical =
        canonicalId === null
          ? null
          : canonicalId === `${providerId}/${modelId}`
            ? true
            : canonicalId;
      const entry: ModelPriceEntry =
        canonical !== null
          ? [input, output, cacheRead, cacheWrite, canonical]
          : cacheWrite !== null
            ? [input, output, cacheRead, cacheWrite]
            : cacheRead !== null
              ? [input, output, cacheRead]
              : [input, output];
      (providers[providerId] ??= {})[modelId] = entry;
      count += 1;
    }
  }
  if (count < MINIMUM_PRICED_MODELS) {
    throw new Error(`models.dev catalog has only ${count} priced models`);
  }
  return providers;
}

function isEntry(value: unknown): value is ModelPriceEntry {
  if (!Array.isArray(value) || value.length < 2 || value.length > 5) return false;
  if (price(value[0]) === null || price(value[1]) === null) return false;
  for (const index of [2, 3]) {
    if (value.length > index && value[index] !== null && price(value[index]) === null) return false;
  }
  return value.length < 5 || value[4] === true || typeof value[4] === "string";
}

/** Validates a cached table; returns null for anything unusable. */
export function parseModelPriceTable(value: unknown): ModelPriceTableData | null {
  if (!isRecord(value) || !isRecord(value.providers)) return null;
  if (typeof value.fetchedAtMs !== "number" || !Number.isSafeInteger(value.fetchedAtMs)) {
    return null;
  }
  for (const models of Object.values(value.providers)) {
    if (!isRecord(models) || !Object.values(models).every(isEntry)) return null;
  }
  return value as unknown as ModelPriceTableData;
}

/**
 * User overrides: `{ "models": { "<model>" | "<provider>/<model>": { input, output,
 * cacheRead?, cacheWrite? } } }`, USD per million Tokens. Throws when any entry is invalid.
 */
export function parseModelPriceOverrides(value: unknown): Map<string, ModelPrice> {
  if (!isRecord(value) || !isRecord(value.models)) {
    throw new Error("Price overrides must contain a 'models' object");
  }
  const overrides = new Map<string, ModelPrice>();
  for (const [key, entry] of Object.entries(value.models)) {
    if (key.length === 0 || !isRecord(entry)) {
      throw new Error(`Price override '${key}' is invalid`);
    }
    for (const field of Object.keys(entry)) {
      if (!["input", "output", "cacheRead", "cacheWrite"].includes(field)) {
        throw new Error(`Price override '${key}' contains unknown field '${field}'`);
      }
    }
    const input = price(entry.input);
    const output = price(entry.output);
    if (input === null || output === null) {
      throw new Error(`Price override '${key}' needs non-negative 'input' and 'output'`);
    }
    const resolved: ModelPrice = { input, output };
    for (const field of ["cacheRead", "cacheWrite"] as const) {
      if (entry[field] === undefined) continue;
      const candidate = price(entry[field]);
      if (candidate === null) throw new Error(`Price override '${key}' has invalid '${field}'`);
      resolved[field] = candidate;
    }
    overrides.set(key, resolved);
  }
  return overrides;
}

function entryPrice(entry: ModelPriceEntry): ModelPrice {
  const [input, output, cacheRead, cacheWrite] = entry;
  return {
    input,
    output,
    ...(cacheRead !== undefined && cacheRead !== null ? { cacheRead } : {}),
    ...(cacheWrite !== undefined && cacheWrite !== null ? { cacheWrite } : {}),
  };
}

/** Exact-match lookup; never guesses between differently priced listings. */
export class ModelPriceLookup {
  readonly #providers: ModelPriceTableData["providers"];
  readonly #overrides: ReadonlyMap<string, ModelPrice>;
  readonly #listings = new Map<string, Array<{ provider: string; entry: ModelPriceEntry }>>();

  constructor(table: ModelPriceTableData, overrides: ReadonlyMap<string, ModelPrice> = new Map()) {
    this.#providers = table.providers;
    this.#overrides = overrides;
    for (const [provider, models] of Object.entries(table.providers)) {
      for (const [model, entry] of Object.entries(models)) {
        let listings = this.#listings.get(model);
        if (!listings) {
          listings = [];
          this.#listings.set(model, listings);
        }
        listings.push({ provider, entry });
      }
    }
  }

  find(model: string, provider?: string): ModelPrice | null {
    const override =
      (provider ? this.#overrides.get(`${provider}/${model}`) : undefined) ??
      this.#overrides.get(model);
    if (override) return override;
    const exact = provider ? this.#providers[provider]?.[model] : undefined;
    if (exact) return entryPrice(exact);
    const listings = this.#listings.get(model) ?? [];
    const [only] = listings;
    if (only && listings.length === 1) return entryPrice(only.entry);
    // Several providers list this ID: use it only when they all name one official listing.
    const officials = new Set<string>();
    for (const { provider: listedBy, entry } of listings) {
      const canonical = entry[4];
      if (canonical === true) officials.add(`${listedBy}/${model}`);
      else if (typeof canonical === "string") officials.add(canonical);
    }
    const [official] = officials;
    if (official === undefined || officials.size !== 1) return null;
    const separator = official.indexOf("/");
    const officialProvider = official.slice(0, separator);
    // An alias such as `deepseek-flash` may name a canonical model the catalog does not list;
    // the official provider's own listing of this ID is then the official price.
    const officialEntry =
      this.#providers[officialProvider]?.[official.slice(separator + 1)] ??
      listings.find(({ provider: listedBy }) => listedBy === officialProvider)?.entry;
    return officialEntry ? entryPrice(officialEntry) : null;
  }
}

export interface ModelPriceCatalogOptions {
  /** Holds the refreshed table cache and the user's `pricing.json`. */
  directory: string;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  diagnose?: (message: string) => void;
}

export function defaultModelPriceDirectory(environment: NodeJS.ProcessEnv): string {
  const dataDirectory = environment.CODEXHOST_DATA_DIR;
  return dataDirectory ? path.resolve(dataDirectory) : path.join(os.homedir(), ".codexhost");
}

/**
 * Bundled models.dev snapshot, refreshed in the background at most weekly, with user overrides
 * from `pricing.json`. Failures fall back silently to the previous table.
 */
export class ModelPriceCatalog {
  readonly #options: ModelPriceCatalogOptions | null;
  readonly #cachePath: string | null;
  readonly #overridesPath: string | null;
  #table: ModelPriceTableData = bundledModelPrices;
  #overrides: ReadonlyMap<string, ModelPrice> = new Map();
  #overridesVersion: string | null = null;
  #lookup: ModelPriceLookup | null = null;
  #started: Promise<void> | null = null;

  /** Without options the catalog uses only the bundled snapshot: no disk or network access. */
  constructor(options?: ModelPriceCatalogOptions) {
    this.#options = options ?? null;
    this.#cachePath = options ? path.join(options.directory, "pricing", "models-dev.json") : null;
    this.#overridesPath = options ? path.join(options.directory, "pricing.json") : null;
  }

  /** Loads the cached table and schedules a background refresh when it is stale. */
  start(): Promise<void> {
    this.#started ??= this.#start();
    return this.#started;
  }

  async #start(): Promise<void> {
    const options = this.#options;
    const cachePath = this.#cachePath;
    if (!options || !cachePath) return;
    try {
      const cached = parseModelPriceTable(JSON.parse(await readFile(cachePath, "utf8")));
      if (cached && cached.fetchedAtMs > this.#table.fetchedAtMs) this.#setTable(cached);
    } catch {
      // Missing or corrupt cache: the bundled snapshot stays in use.
    }
    const now = options.now?.() ?? Date.now();
    if (now - this.#table.fetchedAtMs >= REFRESH_AFTER_MS)
      void this.#refresh(options, cachePath, now);
  }

  async #refresh(options: ModelPriceCatalogOptions, cachePath: string, now: number): Promise<void> {
    try {
      const response = await (options.fetch ?? globalThis.fetch)(MODELS_DEV_URL, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const table: ModelPriceTableData = {
        fetchedAtMs: now,
        providers: compactModelsDev(await response.json()),
      };
      await mkdir(path.dirname(cachePath), { recursive: true });
      const temporary = `${cachePath}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify(table));
      await rename(temporary, cachePath);
      this.#setTable(table);
    } catch (error) {
      options.diagnose?.(
        `Model price refresh failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  #setTable(table: ModelPriceTableData): void {
    this.#table = table;
    this.#lookup = null;
  }

  /** Current lookup, reloading `pricing.json` when it changed. */
  async lookup(): Promise<ModelPriceLookup> {
    if (this.#overridesPath) await this.#reloadOverrides(this.#overridesPath);
    this.#lookup ??= new ModelPriceLookup(this.#table, this.#overrides);
    return this.#lookup;
  }

  async #reloadOverrides(overridesPath: string): Promise<void> {
    let version: string | null;
    try {
      const info = await stat(overridesPath);
      version = `${info.mtimeMs}:${info.size}`;
    } catch {
      version = null;
    }
    if (version === this.#overridesVersion) return;
    this.#overridesVersion = version;
    this.#lookup = null;
    if (version === null) {
      this.#overrides = new Map();
      return;
    }
    try {
      this.#overrides = parseModelPriceOverrides(JSON.parse(await readFile(overridesPath, "utf8")));
    } catch (error) {
      this.#overrides = new Map();
      this.#options?.diagnose?.(
        `Ignoring ${overridesPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
