import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";

import type {
  HarnessUsageEntry,
  HarnessUsageStatisticsCapability,
} from "@codexhost/harness-adapter";
import { parseHarnessUsageEntry } from "@codexhost/harness-adapter/usage-statistics";
import type {
  UsageStatisticsParams,
  UsageStatisticsRange,
  UsageStatisticsResult,
  UsageStatisticsSession,
  UsageStatisticsTotals,
} from "@codexhost/shared-contracts";

import {
  cacheWrite1hPrice,
  type ModelPrice,
  type ModelPriceCatalog,
  type ModelPriceLookup,
} from "./model-prices.js";

/** Bump when a reader's output changes meaning, so cached parses are read again. */
const CACHE_VERSION = 5;
const STALE_AFTER_MS = 10_000;
const WARM_DELAY_MS = 3_000;
/** At most one rewrite of a Harness's cache file per interval while its sessions keep growing. */
const PERSIST_INTERVAL_MS = 60_000;
const TOKENS_PER_PRICE_UNIT = 1_000_000;

export interface UsageStatisticsSource {
  harness: string;
  capability: HarnessUsageStatisticsCapability;
}

export interface UsageStatisticsOptions {
  /** Holds the parse cache; it can be deleted at any time and is rebuilt from native storage. */
  directory: string;
  prices: ModelPriceCatalog;
  now?: () => number;
  diagnose?: (message: string) => void;
}

interface CachedSource {
  fingerprint: string;
  entries: readonly HarnessUsageEntry[];
}

interface HarnessCache {
  sources: Map<string, CachedSource>;
  persistedAtMs: number;
  dirty: boolean;
}

type CompactEntry = [
  string,
  number,
  string | null,
  number,
  number | null,
  number | null,
  number | null,
  number,
  number | null,
  string | null,
  string | null,
  number | null,
  number | null,
  boolean,
];

function compact(entry: HarnessUsageEntry): CompactEntry {
  return [
    entry.id,
    entry.occurredAtMs,
    entry.model ?? null,
    entry.inputTokens,
    entry.cachedInputTokens ?? null,
    entry.cacheWriteInputTokens ?? null,
    entry.cacheWrite1hInputTokens ?? null,
    entry.outputTokens,
    entry.reasoningOutputTokens ?? null,
    entry.sessionId ?? null,
    entry.cwd ?? null,
    entry.costUsd ?? null,
    entry.credits ?? null,
    entry.tokensUnknown === true,
  ];
}

/** One string per distinct value: Models and directories repeat across many thousand entries. */
function interner(): (value: unknown) => unknown {
  const seen = new Map<string, string>();
  return (value) => {
    if (typeof value !== "string") return value;
    const known = seen.get(value);
    if (known !== undefined) return known;
    seen.set(value, value);
    return value;
  };
}

function expand(value: unknown, intern: (value: unknown) => unknown): HarnessUsageEntry | null {
  if (!Array.isArray(value) || value.length !== 14) return null;
  const [id, occurredAtMs, model, input, cached, written, written1h, output, reasoning] = value;
  const [sessionId, cwd, costUsd, credits, tokensUnknown] = value.slice(9);
  return parseHarnessUsageEntry({
    id,
    occurredAtMs,
    ...(model !== null ? { model: intern(model) } : {}),
    inputTokens: input,
    ...(cached !== null ? { cachedInputTokens: cached } : {}),
    ...(written !== null ? { cacheWriteInputTokens: written } : {}),
    ...(written1h !== null ? { cacheWrite1hInputTokens: written1h } : {}),
    outputTokens: output,
    ...(reasoning !== null ? { reasoningOutputTokens: reasoning } : {}),
    ...(sessionId !== null ? { sessionId } : {}),
    ...(cwd !== null ? { cwd: intern(cwd) } : {}),
    ...(costUsd !== null ? { costUsd } : {}),
    ...(credits !== null ? { credits } : {}),
    ...(tokensUnknown === true ? { tokensUnknown } : {}),
  });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function localDate(ms: number): string {
  const date = new Date(ms);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/** Calendar days before or after `date` (a local date), as a local date. */
function shiftDate(date: string, days: number): string {
  const value = new Date(`${date}T12:00:00`);
  value.setDate(value.getDate() + days);
  return localDate(value.getTime());
}

/** A request once deduplicated, with its local calendar position worked out once. */
interface IndexedEntry {
  harness: string;
  entry: HarnessUsageEntry;
  date: string;
  weekday: number;
  hour: number;
}

const SESSIONS_PER_MEASURE = 50;
const MODELS_PER_SESSION = 16;

function emptyTotals(): UsageStatisticsTotals {
  return {
    requests: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    cacheKnownInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    costUsd: 0,
    unpricedRequests: 0,
    unmeteredRequests: 0,
  };
}

function addEntry(totals: UsageStatisticsTotals, entry: HarnessUsageEntry, cost: number | null) {
  totals.requests += 1;
  // Without token counts there is nothing to sum or price.
  if (entry.tokensUnknown) {
    totals.unmeteredRequests += 1;
    return;
  }
  totals.inputTokens += entry.inputTokens;
  totals.outputTokens += entry.outputTokens;
  totals.reasoningOutputTokens += entry.reasoningOutputTokens ?? 0;
  if (entry.cachedInputTokens !== undefined && entry.cacheWriteInputTokens !== undefined) {
    totals.cachedInputTokens += entry.cachedInputTokens;
    totals.cacheWriteInputTokens += entry.cacheWriteInputTokens;
    totals.cacheKnownInputTokens += entry.inputTokens;
  }
  if (cost === null) totals.unpricedRequests += 1;
  else totals.costUsd += cost;
}

/** Input that neither came from nor went to the cache, plus output: the page's "tokens". */
function tokensWithoutCache(totals: UsageStatisticsTotals): number {
  return (
    totals.inputTokens -
    totals.cachedInputTokens -
    totals.cacheWriteInputTokens +
    totals.outputTokens
  );
}

function grouped<K, T extends object>(
  map: Map<K, UsageStatisticsTotals>,
  shape: (key: K) => T,
): Array<T & UsageStatisticsTotals> {
  return [...map]
    .map(([key, totals]) => ({ ...shape(key), ...totals }))
    .sort(
      (left, right) =>
        right.costUsd - left.costUsd || tokensWithoutCache(right) - tokensWithoutCache(left),
    );
}

function bucket<K>(map: Map<K, UsageStatisticsTotals>, key: K): UsageStatisticsTotals {
  let totals = map.get(key);
  if (!totals) {
    totals = emptyTotals();
    map.set(key, totals);
  }
  return totals;
}

const RANGE_DAYS: Record<UsageStatisticsRange, number | null> = {
  today: 1,
  "7d": 7,
  "30d": 30,
  "90d": 90,
  all: null,
};

/**
 * One request's API-equivalent cost at `price`, with the same formula and the same "unknown is
 * not zero" rule as the per-Thread meter; null when it cannot be priced.
 */
export function usageEntryCostUsd(
  price: ModelPrice | null,
  entry: HarnessUsageEntry,
): number | null {
  const cacheRead = entry.cachedInputTokens;
  const cacheWrite = entry.cacheWriteInputTokens;
  if (!price || cacheRead === undefined || cacheWrite === undefined) return null;
  const cacheWrite1h = entry.cacheWrite1hInputTokens ?? 0;
  const cacheWrite5m = cacheWrite - cacheWrite1h;
  if (
    (cacheRead > 0 && price.cacheRead === undefined) ||
    (cacheWrite5m > 0 && price.cacheWrite === undefined)
  ) {
    return null;
  }
  return (
    ((entry.inputTokens - cacheRead - cacheWrite) * price.input +
      cacheRead * (price.cacheRead ?? 0) +
      cacheWrite5m * (price.cacheWrite ?? 0) +
      cacheWrite1h * cacheWrite1hPrice(price) +
      entry.outputTokens * price.output) /
    TOKENS_PER_PRICE_UNIT
  );
}

/**
 * Machine-wide usage from the Harnesses' local storage. Each source is parsed once per
 * fingerprint and kept on disk; a request copied into several sources (a fork, a resume) is
 * counted once; cost is priced when read, so a new or changed price restates history.
 */
export class UsageStatistics {
  readonly #options: UsageStatisticsOptions;
  readonly #directory: string;
  readonly #abort = new AbortController();
  readonly #caches = new Map<string, HarnessCache>();
  readonly #failures = new Map<string, string>();
  #sources: (() => readonly UsageStatisticsSource[]) | null = null;
  #loaded: Promise<void> | null = null;
  #refreshing: Promise<void> | null = null;
  #refreshedAtMs = 0;
  #modelLabels = new Map<string, Readonly<Record<string, string>>>();
  #progress = { sources: 0, read: 0 };
  #warm = false;
  #warmTimer: NodeJS.Timeout | undefined;
  /** Bumped whenever a cached parse is added, replaced or removed. */
  #generation = 0;
  #index: { generation: number; entries: IndexedEntry[] } | null = null;

  constructor(options: UsageStatisticsOptions) {
    this.#options = options;
    this.#directory = path.join(options.directory, `v${CACHE_VERSION}`);
  }

  /** The Harnesses to read; call once their plugins are loaded. */
  attach(sources: () => readonly UsageStatisticsSource[]): void {
    this.#sources = sources;
    this.#scheduleWarm();
  }

  /** Reads every source in the background soon after the sources are attached. */
  warm(): void {
    this.#warm = true;
    this.#scheduleWarm();
  }

  close(): void {
    clearTimeout(this.#warmTimer);
    this.#abort.abort();
  }

  /** What is known now; a stale result starts a background refresh for the next request. */
  async get(params: UsageStatisticsParams | UsageStatisticsRange): Promise<UsageStatisticsResult> {
    await this.#load();
    const now = this.#now();
    if (!this.#refreshing && now - this.#refreshedAtMs > STALE_AFTER_MS) this.#startRefresh();
    return this.#aggregate(
      typeof params === "string" ? { range: params } : params,
      now,
      await this.#options.prices.lookup(),
    );
  }

  /** Completes the current refresh, for tests and callers that need a settled result. */
  async settled(): Promise<void> {
    await this.#refreshing;
  }

  #now(): number {
    return this.#options.now?.() ?? Date.now();
  }

  #scheduleWarm(): void {
    if (!this.#warm || !this.#sources || this.#warmTimer) return;
    this.#warmTimer = setTimeout(() => {
      void this.#load().then(() => {
        if (!this.#refreshing && this.#refreshedAtMs === 0) this.#startRefresh();
      });
    }, WARM_DELAY_MS);
    this.#warmTimer.unref();
  }

  #startRefresh(): void {
    this.#refreshing = this.#refresh()
      .catch((error: unknown) => this.#options.diagnose?.(`Usage statistics: ${message(error)}`))
      .finally(() => {
        this.#refreshing = null;
      });
  }

  async #refresh(): Promise<void> {
    const signal = this.#abort.signal;
    const listed: Array<{
      harness: string;
      capability: HarnessUsageStatisticsCapability;
      ids: { id: string; fingerprint: string }[];
    }> = [];
    this.#progress = { sources: 0, read: 0 };
    this.#modelLabels.clear();
    for (const { harness, capability } of this.#sources?.() ?? []) {
      try {
        const labels = await capability.readModelLabels?.(signal);
        if (labels)
          this.#modelLabels.set(
            harness,
            Object.fromEntries(
              Object.entries(labels).filter(
                ([id, label]) =>
                  id.length > 0 &&
                  id.length <= 512 &&
                  typeof label === "string" &&
                  label.length > 0 &&
                  label.length <= 512,
              ),
            ),
          );
      } catch {
        if (signal.aborted) return;
        // Optional display metadata must never prevent usage collection or pricing.
      }
      try {
        const ids = [...(await capability.listSources(signal))];
        listed.push({ harness, capability, ids });
        this.#progress.sources += ids.length;
        this.#failures.delete(harness);
      } catch (error) {
        if (signal.aborted) return;
        this.#failures.set(harness, message(error));
      }
    }
    for (const { harness, capability, ids } of listed) {
      const cache = this.#cache(harness);
      const present = new Set<string>();
      let failed: string | null = null;
      for (const { id, fingerprint } of ids) {
        present.add(id);
        if (cache.sources.get(id)?.fingerprint !== fingerprint) {
          try {
            const entries = (await capability.readSource(id, signal))
              .map(parseHarnessUsageEntry)
              .filter((entry): entry is HarnessUsageEntry => entry !== null);
            cache.sources.set(id, { fingerprint, entries });
            cache.dirty = true;
            this.#generation += 1;
          } catch (error) {
            if (signal.aborted) return;
            failed ??= message(error);
          }
          // Large histories are parsed in pieces; other Host requests run in between.
          await yieldToEventLoop();
        }
        this.#progress.read += 1;
      }
      for (const id of cache.sources.keys()) {
        if (!present.has(id)) {
          cache.sources.delete(id);
          cache.dirty = true;
          this.#generation += 1;
        }
      }
      if (failed) this.#failures.set(harness, failed);
      await this.#persist(harness, cache);
    }
    this.#refreshedAtMs = this.#now();
  }

  #cache(harness: string): HarnessCache {
    let cache = this.#caches.get(harness);
    if (!cache) {
      cache = { sources: new Map(), persistedAtMs: 0, dirty: false };
      this.#caches.set(harness, cache);
    }
    return cache;
  }

  #file(harness: string): string {
    return path.join(this.#directory, `${encodeURIComponent(harness)}.json`);
  }

  #load(): Promise<void> {
    this.#loaded ??= this.#readCaches().catch(() => undefined);
    return this.#loaded;
  }

  async #readCaches(): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.#directory);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const harness = decodeURIComponent(name.slice(0, -".json".length));
      try {
        const value: unknown = JSON.parse(await readFile(path.join(this.#directory, name), "utf8"));
        if (
          typeof value !== "object" ||
          value === null ||
          !Array.isArray((value as { sources?: unknown }).sources)
        )
          continue;
        const cache = this.#cache(harness);
        const intern = interner();
        for (const source of (value as { sources: unknown[] }).sources) {
          if (!Array.isArray(source) || source.length !== 3) continue;
          const [id, fingerprint, entries] = source;
          if (typeof id !== "string" || typeof fingerprint !== "string" || !Array.isArray(entries))
            continue;
          cache.sources.set(id, {
            fingerprint,
            entries: entries
              .map((entry) => expand(entry, intern))
              .filter((entry): entry is HarnessUsageEntry => entry !== null),
          });
          this.#generation += 1;
        }
        cache.persistedAtMs = this.#now();
      } catch {
        // A broken cache file is rebuilt from native storage.
      }
      await yieldToEventLoop();
    }
  }

  async #persist(harness: string, cache: HarnessCache): Promise<void> {
    if (!cache.dirty || this.#now() - cache.persistedAtMs < PERSIST_INTERVAL_MS) return;
    const file = this.#file(harness);
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await mkdir(this.#directory, { recursive: true });
      const sources = [...cache.sources].map(([id, source]) => [
        id,
        source.fingerprint,
        source.entries.map(compact),
      ]);
      await writeFile(temporary, JSON.stringify({ version: CACHE_VERSION, sources }));
      await rename(temporary, file);
      cache.dirty = false;
      cache.persistedAtMs = this.#now();
    } catch (error) {
      this.#options.diagnose?.(`Usage statistics cache for ${harness}: ${message(error)}`);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  /** Every request once, per Harness in source order, with its local date and hour. */
  #indexed(): IndexedEntry[] {
    if (this.#index?.generation === this.#generation) return this.#index.entries;
    const entries: IndexedEntry[] = [];
    for (const [harness, cache] of this.#caches) {
      const seen = new Set<string>();
      for (const { entries: parsed } of cache.sources.values()) {
        for (const entry of parsed) {
          if (seen.has(entry.id)) continue;
          seen.add(entry.id);
          const at = new Date(entry.occurredAtMs);
          entries.push({
            harness,
            entry,
            date: localDate(entry.occurredAtMs),
            weekday: at.getDay(),
            hour: at.getHours(),
          });
        }
      }
    }
    this.#index = { generation: this.#generation, entries };
    return entries;
  }

  #aggregate(
    params: UsageStatisticsParams,
    now: number,
    lookup: ModelPriceLookup,
  ): UsageStatisticsResult {
    const { range } = params;
    const days = RANGE_DAYS[range];
    const to = localDate(now);
    let from: string | null = null;
    if (days !== null) from = shiftDate(to, -days + 1);
    const inRange = (date: string): boolean => (from === null || date >= from) && date <= to;
    const day = params.date !== undefined && inRange(params.date) ? params.date : null;
    const harnessFilter = params.harness ?? null;
    const modelFilter = params.model;
    const projectFilter = params.project;

    const prices = new Map<string, ModelPrice | null>();
    const userPrices = new Map<string, ModelPrice | null>();
    let unlistedModel = false;
    const priceOf = (model: string | undefined): ModelPrice | null => {
      if (model === undefined) return null;
      if (!prices.has(model)) prices.set(model, lookup.find(model));
      return prices.get(model) ?? null;
    };
    const userPriceOf = (model: string | undefined): ModelPrice | null => {
      if (model === undefined) return null;
      if (!userPrices.has(model)) userPrices.set(model, lookup.userPrice(model));
      return userPrices.get(model) ?? null;
    };
    // A price the user set for the model wins; then what the Harness recorded the request cost;
    // then the list price.
    const costOf = (entry: HarnessUsageEntry): number | null => {
      if (entry.tokensUnknown) return null;
      const userPrice = userPriceOf(entry.model);
      if (userPrice) return usageEntryCostUsd(userPrice, entry);
      if (entry.costUsd !== undefined) return entry.costUsd;
      const price = priceOf(entry.model);
      if (price === null && entry.model !== undefined) unlistedModel = true;
      return usageEntryCostUsd(price, entry);
    };

    const harnesses = new Set<string>();
    const models = new Set<string | null>();
    const modelLabels = new Map<string, { harness: string; model: string; label: string }>();
    const projects = new Set<string | null>();
    const totals = emptyTotals();
    const daily = new Map<string, UsageStatisticsTotals>();
    const hourly = new Map<number, UsageStatisticsTotals>();
    const byHarness = new Map<string, UsageStatisticsTotals>();
    const byModel = new Map<string | null, UsageStatisticsTotals>();
    const credits = new Map<string, NonNullable<UsageStatisticsResult["credits"]>[number]>();
    const harnessPriced = new Map<string | null, number>();
    const byProject = new Map<string | null, UsageStatisticsTotals>();
    const sessions = new Map<
      string,
      {
        harness: string;
        sessionId: string;
        project: string | null;
        models: Map<string, number>;
        firstAtMs: number;
        lastAtMs: number;
        totals: UsageStatisticsTotals;
      }
    >();

    for (const indexed of this.#indexed()) {
      const { harness, entry, date } = indexed;
      if (!inRange(date)) continue;
      const model = entry.model ?? null;
      const project = entry.cwd ?? null;
      harnesses.add(harness);
      models.add(model);
      if (model !== null && modelLabels.size < 4096) {
        const labels = this.#modelLabels.get(harness);
        const label = labels && Object.hasOwn(labels, model) ? labels[model] : undefined;
        modelLabels.set(`${harness}\u0000${model}`, { harness, model, label: label ?? model });
      }
      projects.add(project);
      if (harnessFilter !== null && harness !== harnessFilter) continue;
      if (modelFilter !== undefined && model !== modelFilter) continue;
      if (projectFilter !== undefined && project !== projectFilter) continue;
      const cost = costOf(entry);
      addEntry(bucket(daily, `${date}\u0000${harness}`), entry, cost);
      if (day !== null && date !== day) continue;
      addEntry(totals, entry, cost);
      const creditsKey = JSON.stringify([harness, model]);
      let creditGroup = credits.get(creditsKey);
      if (!creditGroup) {
        creditGroup = { harness, model, credits: 0, reportedRequests: 0, requests: 0 };
        credits.set(creditsKey, creditGroup);
      }
      creditGroup.requests += 1;
      if (entry.credits !== undefined) {
        creditGroup.credits += entry.credits;
        creditGroup.reportedRequests += 1;
      }
      addEntry(bucket(hourly, indexed.weekday * 24 + indexed.hour), entry, cost);
      addEntry(bucket(byHarness, harness), entry, cost);
      addEntry(bucket(byModel, model), entry, cost);
      if (entry.costUsd !== undefined && userPriceOf(entry.model) === null) {
        harnessPriced.set(model, (harnessPriced.get(model) ?? 0) + 1);
      }
      addEntry(bucket(byProject, project), entry, cost);
      if (entry.sessionId !== undefined) {
        const key = `${harness}\u0000${entry.sessionId}`;
        let session = sessions.get(key);
        if (!session) {
          session = {
            harness,
            sessionId: entry.sessionId,
            project,
            models: new Map(),
            firstAtMs: entry.occurredAtMs,
            lastAtMs: entry.occurredAtMs,
            totals: emptyTotals(),
          };
          sessions.set(key, session);
        }
        session.project ??= project;
        if (model !== null) session.models.set(model, (session.models.get(model) ?? 0) + 1);
        session.firstAtMs = Math.min(session.firstAtMs, entry.occurredAtMs);
        session.lastAtMs = Math.max(session.lastAtMs, entry.occurredAtMs);
        addEntry(session.totals, entry, cost);
      }
    }

    // The top sessions by cost and by tokens without cache: a cheap model's long session and an
    // expensive model's short one both make the list.
    const allSessions = [...sessions.values()];
    const top = new Set([
      ...[...allSessions]
        .sort((left, right) => right.totals.costUsd - left.totals.costUsd)
        .slice(0, SESSIONS_PER_MEASURE),
      ...[...allSessions]
        .sort((left, right) => tokensWithoutCache(right.totals) - tokensWithoutCache(left.totals))
        .slice(0, SESSIONS_PER_MEASURE),
    ]);
    const sessionList: UsageStatisticsSession[] = [...top]
      .map((session) => ({
        harness: session.harness,
        sessionId: session.sessionId,
        project: session.project,
        models: [...session.models]
          .sort((left, right) => right[1] - left[1])
          .slice(0, MODELS_PER_SESSION)
          .map(([name]) => name),
        firstAtMs: session.firstAtMs,
        lastAtMs: session.lastAtMs,
        ...session.totals,
      }))
      .sort(
        (left, right) =>
          right.costUsd - left.costUsd || tokensWithoutCache(right) - tokensWithoutCache(left),
      );

    // A model without a price may have been listed since the table was fetched.
    if (unlistedModel) this.#options.prices.missing();

    const byName = (left: string | null, right: string | null): number =>
      left === right ? 0 : left === null ? 1 : right === null ? -1 : left.localeCompare(right);
    return {
      range,
      from,
      to,
      filters: {
        harness: harnessFilter,
        model: modelFilter ?? null,
        unknownModel: modelFilter === null,
        project: projectFilter ?? null,
        unknownProject: projectFilter === null,
        date: day,
      },
      reading: {
        // Complete once every source has been read at least once; later refreshes only add.
        complete: this.#refreshedAtMs > 0,
        sources: this.#progress.sources,
        read: this.#progress.read,
      },
      failures: [...this.#failures].map(([name, text]) => ({
        harness: name,
        message: text.slice(0, 2048),
      })),
      options: {
        harnesses: [...harnesses].sort(),
        models: [...models].sort(byName).slice(0, 4096),
        projects: [...projects].sort(byName).slice(0, 4096),
      },
      modelLabels: [...modelLabels.values()],
      credits: [...credits.values()]
        .filter((row) => row.reportedRequests > 0)
        .sort(
          (left, right) =>
            left.harness.localeCompare(right.harness) || byName(left.model, right.model),
        )
        .slice(0, 4096),
      totals,
      daily: [...daily]
        .map(([key, value]) => {
          const [date = "", harness = ""] = key.split("\u0000");
          return { date, harness, ...value };
        })
        .sort(
          (left, right) =>
            left.date.localeCompare(right.date) || left.harness.localeCompare(right.harness),
        ),
      hourly: [...hourly]
        .map(([slot, value]) => ({ weekday: Math.floor(slot / 24), hour: slot % 24, ...value }))
        .sort((left, right) => left.weekday - right.weekday || left.hour - right.hour),
      byHarness: grouped(byHarness, (name) => ({ harness: name })),
      byModel: grouped(byModel, (name) => ({ model: name }))
        .slice(0, 4096)
        .map((row) => ({ ...row, harnessPricedRequests: harnessPriced.get(row.model) ?? 0 })),
      byProject: grouped(byProject, (name) => ({ project: name })).slice(0, 4096),
      sessions: sessionList,
    };
  }
}
