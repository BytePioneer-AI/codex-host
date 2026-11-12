import { EventEmitter } from "node:events";
import { mkdir, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { DelegationControlError, type ThreadWatchOutcome } from "./delegation-types.js";
import { isValidClientName } from "./external-clients.js";

export const DEFAULT_EVENT_RETENTION_DAYS = 7;
export const EVENT_RETENTION_DAYS_ENV = "CODEXHOST_CLIENT_EVENT_RETENTION_DAYS";
const DAY_MS = 24 * 60 * 60_000;
const SEGMENT = /^(\d{4}-\d{2}-\d{2})\.jsonl$/u;

/** What an external client learns when a watched Thread stops: state and links, never content. */
export interface ClientEvent {
  /** Increases within a client's log; use it as the cursor. */
  id: number;
  time: string;
  type: "watch";
  threadId: string;
  outcome: ThreadWatchOutcome;
  turnId?: string;
  harnessId?: string;
  deepLink: string;
  refs?: string[];
  /** Why the outcome was decided, for example that a Host Runtime restart cut the work off. */
  note?: string;
}

export type NewClientEvent = Omit<ClientEvent, "id" | "time">;

export interface ClientEventPage {
  events: ClientEvent[];
  /** Pass back as `after` to continue; unchanged when nothing new arrived. */
  cursor: number;
}

export function eventRetentionDays(environment: NodeJS.ProcessEnv): number {
  const value = environment[EVENT_RETENTION_DAYS_ENV]?.trim();
  if (!value) return DEFAULT_EVENT_RETENTION_DAYS;
  const days = /^[0-9]+$/u.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(days) || days < 1)
    throw new Error(`${EVENT_RETENTION_DAYS_ENV} must be a positive number of days`);
  return days;
}

function dayOf(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}

function parseEvent(line: string): ClientEvent | undefined {
  try {
    const value = JSON.parse(line) as Partial<ClientEvent>;
    return Number.isSafeInteger(value.id) && typeof value.threadId === "string"
      ? (value as ClientEvent)
      : undefined;
  } catch {
    // A line cut short by a crash is skipped.
    return undefined;
  }
}

/**
 * Append-only event logs, one directory per client with one file per UTC day.
 * Whole days past the retention period are deleted; a cursor older than the
 * deleted range is reported as expired instead of silently skipping events.
 * Event ids are derived from the clock (microseconds) and never repeat within
 * a process, so a Runtime started later continues above earlier ids.
 */
export class ClientEventLog {
  readonly #directory: string;
  readonly #retentionMs: number;
  readonly #now: () => number;
  readonly #signals = new EventEmitter();
  readonly #lastIds = new Map<string, number>();

  constructor(options: { directory: string; retentionDays: number; now?: () => number }) {
    this.#directory = options.directory;
    this.#retentionMs = options.retentionDays * DAY_MS;
    this.#now = options.now ?? Date.now;
    this.#signals.setMaxListeners(0);
  }

  async append(client: string, events: readonly NewClientEvent[]): Promise<ClientEvent[]> {
    if (events.length === 0) return [];
    const directory = this.#clientDirectory(client);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const now = this.#now();
    let last = this.#lastIds.get(client) ?? (await this.#lastId(client));
    const written = events.map((event) => {
      last = Math.max(now * 1_000, last + 1);
      return { id: last, time: new Date(now).toISOString(), ...event };
    });
    const file = path.join(directory, `${dayOf(now)}.jsonl`);
    const text = written.map((event) => `${JSON.stringify(event)}\n`).join("");
    const handle = await open(file, "a+", 0o600);
    try {
      // A line cut short by a crash must not swallow the next event.
      const { size } = await handle.stat();
      let separator = "";
      if (size > 0) {
        const last = Buffer.alloc(1);
        await handle.read(last, 0, 1, size - 1);
        if (last.toString("utf8") !== "\n") separator = "\n";
      }
      await handle.appendFile(`${separator}${text}`);
      // Durable before it counts as delivered.
      await handle.sync();
    } finally {
      await handle.close();
    }
    this.#lastIds.set(client, last);
    await this.#prune(client);
    this.#signals.emit(client);
    return written;
  }

  /** Events after the cursor, oldest first. `after` 0 reads from the oldest retained event. */
  async read(client: string, after: number, limit = 100): Promise<ClientEventPage> {
    await this.#prune(client);
    const pruned = await this.#prunedThrough(client);
    if (after > 0 && after < pruned) {
      const [oldest] = (await this.#all(client)).slice(0, 1);
      throw new DelegationControlError(
        "CURSOR_EXPIRED",
        "The cursor is older than the retained events",
        {
          oldestEventId: oldest?.id ?? null,
        },
      );
    }
    const events = (await this.#all(client)).filter((event) => event.id > after).slice(0, limit);
    return { events, cursor: events.at(-1)?.id ?? after };
  }

  /** The newest event id, or 0; a new webhook starts after it rather than replaying history. */
  async lastEventId(client: string): Promise<number> {
    return this.#lastId(client);
  }

  /** Resolves when the client's log gains an event, or after the timeout. */
  waitForEvent(client: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.#signals.off(client, done);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      this.#signals.on(client, done);
      signal?.addEventListener("abort", done, { once: true });
    });
  }

  async #all(client: string): Promise<ClientEvent[]> {
    const events: ClientEvent[] = [];
    for (const name of await this.#segments(client)) {
      const text = await readFile(path.join(this.#clientDirectory(client), name), "utf8").catch(
        () => "",
      );
      for (const line of text.split("\n")) {
        const event = line ? parseEvent(line) : undefined;
        if (event) events.push(event);
      }
    }
    return events.sort((left, right) => left.id - right.id);
  }

  async #lastId(client: string): Promise<number> {
    return (await this.#all(client)).at(-1)?.id ?? Math.max(0, await this.#prunedThrough(client));
  }

  async #segments(client: string): Promise<string[]> {
    try {
      return (await readdir(this.#clientDirectory(client)))
        .filter((name) => SEGMENT.test(name))
        .sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async #prune(client: string): Promise<void> {
    const cutoff = dayOf(this.#now() - this.#retentionMs);
    const expired = (await this.#segments(client)).filter((name) => name.slice(0, 10) < cutoff);
    if (expired.length === 0) return;
    let pruned = await this.#prunedThrough(client);
    for (const name of expired) {
      const file = path.join(this.#clientDirectory(client), name);
      const text = await readFile(file, "utf8").catch(() => "");
      for (const line of text.split("\n")) {
        const event = line ? parseEvent(line) : undefined;
        if (event) pruned = Math.max(pruned, event.id);
      }
      await rm(file, { force: true });
    }
    await writeFile(this.#prunedPath(client), `${JSON.stringify({ through: pruned })}\n`, {
      mode: 0o600,
    });
  }

  async #prunedThrough(client: string): Promise<number> {
    try {
      const value = JSON.parse(await readFile(this.#prunedPath(client), "utf8")) as {
        through?: unknown;
      };
      return Number.isSafeInteger(value.through) ? (value.through as number) : 0;
    } catch {
      return 0;
    }
  }

  #prunedPath(client: string): string {
    return path.join(this.#clientDirectory(client), "pruned.json");
  }

  #clientDirectory(client: string): string {
    // Registered names are restricted to [a-z0-9-]; anything else could leave the directory.
    if (!isValidClientName(client))
      throw new DelegationControlError("INVALID_ARGUMENT", "Client name is invalid");
    return path.join(this.#directory, client);
  }
}
