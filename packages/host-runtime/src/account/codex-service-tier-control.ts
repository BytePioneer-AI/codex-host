import type { JsonObject, JsonValue } from "@codexhost/protocol-core";
import {
  codexServiceTierRequestValue,
  codexServiceTierSettingsSchema,
  type CodexServiceTierEffect,
  type CodexServiceTierResult,
  type CodexServiceTierSettings,
} from "@codexhost/shared-contracts";

export type OfficialConfigRequest = (method: string, params: JsonObject) => Promise<JsonObject>;

/** Advertised request tiers by model slug and id; static for one native process. */
type TierCatalog = ReadonlyMap<string, ReadonlySet<string>>;

const THREAD_CACHE_LIMIT = 512;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function result(response: JsonObject): Record<string, unknown> {
  if (response.error || !isRecord(response.result)) {
    throw new Error("Could not read the native Codex configuration");
  }
  return response.result;
}

async function readTierCatalog(request: OfficialConfigRequest): Promise<TierCatalog> {
  const catalog = new Map<string, ReadonlySet<string>>();
  const cursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const response = result(
      await request("model/list", { includeHidden: true, cursor, limit: 100 }),
    );
    if (!Array.isArray(response.data)) throw new Error("Codex model catalog is unavailable");
    for (const model of response.data) {
      if (!isRecord(model)) continue;
      const tiers = new Set(
        Array.isArray(model.serviceTiers)
          ? model.serviceTiers.flatMap((entry) =>
              isRecord(entry) && typeof entry.id === "string" ? [entry.id] : [],
            )
          : [],
      );
      for (const key of [model.model, model.id]) {
        if (typeof key === "string" && !catalog.has(key)) catalog.set(key, tiers);
      }
    }
    cursor = stringOrNull(response.nextCursor);
    if (cursor && cursors.has(cursor)) throw new Error("Invalid model catalog pagination");
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return catalog;
}

function advertises(catalog: TierCatalog, model: string | null, tier: string): boolean {
  if (model !== null) return catalog.get(model)?.has(tier) ?? false;
  // Without a configured model the provider default applies; any advertisement is the best signal.
  return [...catalog.values()].some((tiers) => tiers.has(tier));
}

/** A Composer tier would override the thread's tier, so "off" must neutralize it explicitly. */
function carriesTier(params: Record<string, unknown>): boolean {
  return (
    typeof params.serviceTier === "string" ||
    (typeof params.serviceTierForTurn === "string" && params.serviceTierForTurn !== "default")
  );
}

/** Confirmed settings are shared by every client of one official runtime, not by a draft UI. */
export class CodexServiceTierControl {
  #settings: CodexServiceTierSettings | null = null;
  #pending: Promise<unknown> = Promise.resolve();
  #catalog: Promise<TierCatalog> | null = null;
  /** Model provider by thread id; a model change never changes a thread's provider. */
  readonly #threads = new Map<string, string>();

  /** Sees every native output frame; unrelated frames must stay O(1). */
  observe(value: JsonValue): void {
    if (!isRecord(value)) return;
    if (typeof value.method === "string") {
      if (!isRecord(value.params)) return;
      if (value.method === "thread/started" && isRecord(value.params.thread)) {
        this.#observeThread(value.params.thread, value.params.thread);
      } else if (value.method === "thread/settings/updated") {
        const { threadId, threadSettings } = value.params;
        if (typeof threadId !== "string" || !isRecord(threadSettings)) return;
        const provider = stringOrNull(threadSettings.modelProvider);
        if (provider) this.#remember(threadId, provider);
      }
      return;
    }
    // thread/start, resume and fork report the effective model at the top level.
    if (isRecord(value.result) && isRecord(value.result.thread)) {
      this.#observeThread(value.result.thread, value.result);
    }
  }

  /** A replacement native process may load a different model catalog. */
  reset(): void {
    this.#threads.clear();
    this.#catalog = null;
  }

  apply(
    settings: CodexServiceTierSettings,
    request: OfficialConfigRequest,
  ): Promise<CodexServiceTierResult> {
    const parsed = codexServiceTierSettingsSchema.parse(settings);
    const update = this.#pending.then(async (): Promise<CodexServiceTierResult> => {
      let effect: CodexServiceTierEffect = { state: "off" };
      if (parsed.enabled) {
        const config = result(
          await request("config/read", { includeLayers: false, cwd: null }),
        ).config;
        if (!isRecord(config)) throw new Error("Could not read the native Codex configuration");
        const provider = stringOrNull(config.model_provider);
        const configModel = stringOrNull(config.model);
        if (provider === null || provider === "openai") {
          effect = { state: "inactive", reason: "officialProvider" };
        } else {
          // The tier is forced either way; the catalog only decides the informational notice.
          const catalog = await this.#tierCatalog(request).catch(() => null);
          effect =
            catalog && !advertises(catalog, configModel, codexServiceTierRequestValue(parsed.tier))
              ? { state: "active", notice: "notAdvertised" }
              : { state: "active" };
        }
      }
      // Inactive settings are still accepted: each turn is decided by its own thread.
      this.#settings = { ...parsed };
      return { settings: { ...parsed }, effect };
    });
    this.#pending = update.catch(() => undefined);
    return update;
  }

  /**
   * The `serviceTierForTurn` value for an official `turn/start`, or null to forward unchanged.
   * Never rejects: a tier that cannot be confirmed must not block or fail the user's turn.
   */
  async tierForTurn(
    params: Readonly<Record<string, unknown>>,
    request: OfficialConfigRequest,
  ): Promise<string | null> {
    const threadId = params.threadId;
    if (typeof threadId !== "string") return null;
    await this.#pending;
    const settings = this.#settings;
    if (!settings || (!settings.enabled && !carriesTier(params))) return null;
    const provider = this.#threads.get(threadId) ?? (await this.#readThread(threadId, request));
    if (!provider || provider === "openai") return null;
    if (!settings.enabled) return "default";
    // Forced locally: whether the provider honors the tier is the provider's decision.
    return codexServiceTierRequestValue(settings.tier);
  }

  #tierCatalog(request: OfficialConfigRequest): Promise<TierCatalog> {
    if (!this.#catalog) {
      const loading = readTierCatalog(request);
      this.#catalog = loading;
      loading.catch(() => {
        if (this.#catalog === loading) this.#catalog = null;
      });
    }
    return this.#catalog;
  }

  async #readThread(threadId: string, request: OfficialConfigRequest): Promise<string | null> {
    try {
      const thread = result(await request("thread/read", { threadId, includeTurns: false })).thread;
      if (!isRecord(thread) || typeof thread.modelProvider !== "string") return null;
      return this.#remember(threadId, thread.modelProvider);
    } catch {
      return null;
    }
  }

  #observeThread(thread: Record<string, unknown>, effective: Record<string, unknown>): void {
    if (typeof thread.id !== "string") return;
    const provider = stringOrNull(effective.modelProvider) ?? stringOrNull(thread.modelProvider);
    if (provider) this.#remember(thread.id, provider);
  }

  #remember(threadId: string, provider: string): string {
    this.#threads.delete(threadId);
    this.#threads.set(threadId, provider);
    if (this.#threads.size > THREAD_CACHE_LIMIT) {
      const oldest = this.#threads.keys().next();
      if (!oldest.done) this.#threads.delete(oldest.value);
    }
    return provider;
  }
}
