import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { DelegationControlError } from "./delegation-types.js";
import type { ClientEvent, ClientEventLog } from "./external-client-events.js";
import { isValidClientName } from "./external-clients.js";

const MAX_BODY_BYTES = 4_096;
const REQUEST_TIMEOUT_MS = 15_000;
const FIRST_RETRY_MS = 5_000;
const MAX_RETRY_MS = 15 * 60_000;
const RETRY_WINDOW_MS = 24 * 60 * 60_000;
const DEFAULT_TICK_MS = 2_000;
const EVENTS_PER_TICK = 20;

export interface WebhookConfig {
  adapter: string;
  url: string;
  /** Secret sent to the target; never shown or logged. */
  key: string;
}

export interface WebhookState {
  /** The last event id that is settled: delivered, or given up on. */
  delivered: number;
  attempts?: number;
  firstAttemptAt?: number;
  nextAttemptAt?: number;
  lastSuccessAt?: string;
  lastFailure?: { eventId: number; at: string; reason: string; final: boolean };
}

type Classification = "delivered" | "retry" | "drop";

/** Builds a target's request and reads its answer; one per webhook vendor. */
export interface WebhookAdapter {
  id: string;
  validate(config: WebhookConfig): void;
  request(
    client: string,
    event: ClientEvent,
    config: WebhookConfig,
  ): {
    url: string;
    headers: Record<string, string>;
    body: string;
  };
  classify(status: number): Classification;
}

/** Keeps the body small: the target shows bots only its first few KB. */
function compactBody(event: ClientEvent): string {
  const body = JSON.stringify(event);
  if (Buffer.byteLength(body) <= MAX_BODY_BYTES) return body;
  const rest: Partial<ClientEvent> = { ...event };
  delete rest.refs;
  return JSON.stringify({ ...rest, refsOmitted: true });
}

/**
 * Grok Bot webhook triggers (Cursor Automations): a static Bearer key, no
 * signature, no deduplication, and a 200 that only means "queued".
 */
export const grokBotWebhookAdapter: WebhookAdapter = {
  id: "grok-bot",
  validate(config) {
    let url: URL;
    try {
      url = new URL(config.url);
    } catch {
      throw new DelegationControlError("INVALID_ARGUMENT", "Webhook URL is invalid");
    }
    if (url.protocol !== "https:")
      throw new DelegationControlError("INVALID_ARGUMENT", "Webhook URL must use https");
    if (!config.key.trim())
      throw new DelegationControlError(
        "INVALID_ARGUMENT",
        "Grok Bot webhooks need the trigger's key",
      );
  },
  request(client, event, config) {
    return {
      url: config.url,
      headers: {
        authorization: `Bearer ${config.key}`,
        "content-type": "application/json",
        // The target does not deduplicate; the bot can, by this key.
        "idempotency-key": `${client}:${event.id}`,
      },
      body: compactBody(event),
    };
  },
  classify(status) {
    if (status >= 200 && status < 300) return "delivered";
    if (status === 429 || status >= 500) return "retry";
    return "drop";
  },
};

export const WEBHOOK_ADAPTERS: ReadonlyMap<string, WebhookAdapter> = new Map([
  [grokBotWebhookAdapter.id, grokBotWebhookAdapter],
]);

async function writePrivateJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, filePath);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function readJson<T>(filePath: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch {
    return undefined;
  }
}

/** Per-client webhook configuration and delivery state, private to the user. */
export class WebhookStore {
  readonly #directory: string;

  constructor(directory: string) {
    this.#directory = directory;
  }

  async clients(): Promise<string[]> {
    try {
      return (await readdir(this.#directory))
        .filter((name) => name.endsWith(".json") && !name.endsWith(".state.json"))
        .map((name) => name.slice(0, -".json".length))
        .filter(isValidClientName);
    } catch {
      return [];
    }
  }

  config(client: string): Promise<WebhookConfig | undefined> {
    return readJson<WebhookConfig>(this.#path(client, ".json"));
  }

  async state(client: string): Promise<WebhookState> {
    return (await readJson<WebhookState>(this.#path(client, ".state.json"))) ?? { delivered: 0 };
  }

  /** A new webhook starts after `startAfter`, so setting one up does not replay history. */
  async set(client: string, config: WebhookConfig, startAfter: number): Promise<void> {
    const adapter = WEBHOOK_ADAPTERS.get(config.adapter);
    if (!adapter)
      throw new DelegationControlError(
        "INVALID_ARGUMENT",
        `Unknown webhook adapter '${config.adapter}'; available: ${[...WEBHOOK_ADAPTERS.keys()].join(", ")}`,
      );
    adapter.validate(config);
    await writePrivateJson(this.#path(client, ".json"), { formatVersion: 1, ...config });
    await this.saveState(client, { delivered: startAfter });
  }

  async clear(client: string): Promise<void> {
    await rm(this.#path(client, ".json"), { force: true });
    await rm(this.#path(client, ".state.json"), { force: true });
  }

  async saveState(client: string, state: WebhookState): Promise<void> {
    await writePrivateJson(this.#path(client, ".state.json"), state);
  }

  #path(client: string, suffix: string): string {
    if (!isValidClientName(client))
      throw new DelegationControlError("INVALID_ARGUMENT", "Client name is invalid");
    return path.join(this.#directory, `${client}${suffix}`);
  }
}

/**
 * Pushes each client's new events, in order, through its webhook adapter.
 * The event log stays the source of truth: a failed push never changes it.
 * Retries back off from 5 s to 15 min; after 24 h an event is given up on and
 * the next one is pushed.
 */
export class WebhookDispatcher {
  readonly #store: WebhookStore;
  readonly #events: ClientEventLog;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #tickMs: number;
  readonly #diagnose: (message: string) => void;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #running: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(options: {
    store: WebhookStore;
    events: ClientEventLog;
    fetchImpl?: typeof fetch;
    now?: () => number;
    tickMs?: number;
    diagnose?: (message: string) => void;
  }) {
    this.#store = options.store;
    this.#events = options.events;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#now = options.now ?? Date.now;
    this.#tickMs = options.tickMs ?? DEFAULT_TICK_MS;
    this.#diagnose = options.diagnose ?? (() => undefined);
  }

  start(): void {
    const loop = () => {
      if (this.#closed) return;
      this.#timer = setTimeout(() => {
        void this.tick().finally(loop);
      }, this.#tickMs);
      this.#timer.unref?.();
    };
    loop();
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#timer) clearTimeout(this.#timer);
    await this.#running;
  }

  /** One pass over every configured client; passes never overlap. */
  tick(): Promise<void> {
    this.#running = this.#running
      .then(async () => {
        for (const client of await this.#store.clients()) {
          if (this.#closed) return;
          await this.#deliver(client).catch((error: unknown) =>
            this.#diagnose(
              `webhook ${client}: ${error instanceof Error ? error.message : String(error)}`,
            ),
          );
        }
      })
      .catch(() => undefined);
    return this.#running;
  }

  async #deliver(client: string): Promise<void> {
    const config = await this.#store.config(client);
    const adapter = config ? WEBHOOK_ADAPTERS.get(config.adapter) : undefined;
    if (!config || !adapter) return;
    const state = await this.#store.state(client);
    if (state.nextAttemptAt !== undefined && this.#now() < state.nextAttemptAt) return;
    const { events } = await this.#events
      .read(client, state.delivered, EVENTS_PER_TICK)
      .catch((error: unknown) => {
        // Events removed before they were pushed are skipped, not retried forever.
        if (error instanceof DelegationControlError && error.code === "CURSOR_EXPIRED") {
          const oldest = Number(error.details?.oldestEventId ?? 0);
          state.delivered = oldest > 0 ? oldest - 1 : state.delivered;
          return { events: [] as ClientEvent[] };
        }
        throw error;
      });
    for (const event of events) {
      const outcome = await this.#push(adapter, client, event, config);
      const now = this.#now();
      if (outcome.result === "delivered") {
        Object.assign(state, { delivered: event.id, lastSuccessAt: new Date(now).toISOString() });
        delete state.attempts;
        delete state.firstAttemptAt;
        delete state.nextAttemptAt;
        continue;
      }
      const firstAttemptAt = state.firstAttemptAt ?? now;
      const attempts = (state.attempts ?? 0) + 1;
      const final = outcome.result === "drop" || now - firstAttemptAt >= RETRY_WINDOW_MS;
      state.lastFailure = {
        eventId: event.id,
        at: new Date(now).toISOString(),
        reason: outcome.reason,
        final,
      };
      this.#diagnose(
        `webhook ${client}: event ${event.id} ${final ? "not delivered" : "will be retried"}: ${outcome.reason}`,
      );
      if (final) {
        state.delivered = event.id;
        delete state.attempts;
        delete state.firstAttemptAt;
        delete state.nextAttemptAt;
        continue;
      }
      Object.assign(state, {
        attempts,
        firstAttemptAt,
        nextAttemptAt: now + Math.min(FIRST_RETRY_MS * 2 ** (attempts - 1), MAX_RETRY_MS),
      });
      break;
    }
    await this.#store.saveState(client, state);
  }

  async #push(
    adapter: WebhookAdapter,
    client: string,
    event: ClientEvent,
    config: WebhookConfig,
  ): Promise<{ result: Classification; reason: string }> {
    const request = adapter.request(client, event, config);
    try {
      const response = await this.#fetch(request.url, {
        method: "POST",
        headers: request.headers,
        body: request.body,
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      await response.body?.cancel().catch(() => undefined);
      return { result: adapter.classify(response.status), reason: `HTTP ${response.status}` };
    } catch (error) {
      // The key is in the headers only; messages from fetch never contain it.
      return { result: "retry", reason: error instanceof Error ? error.message : String(error) };
    }
  }
}
