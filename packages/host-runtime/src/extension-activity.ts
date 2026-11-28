import type { ClientThreadSnapshot, ExtensionActivitySnapshot } from "@codexhost/shared-contracts";
import type { ClientChannelEvents } from "./client-channel-events.js";

type Notification = ExtensionActivitySnapshot["notifications"][number];
type Session = ExtensionActivitySnapshot["sessions"][number];

export interface ExtensionActivityMetadata {
  readonly title: string;
  readonly cwd: string;
  readonly updatedAt: number;
}

export interface ExtensionActivityOptions {
  readonly events: ClientChannelEvents;
  readonly snapshot: (id: string) => Promise<ClientThreadSnapshot>;
  readonly readMetadata?: (id: string) => Promise<ExtensionActivityMetadata | null>;
  readonly describeHarness?: (id: string) => Promise<Session["harness"]>;
  readonly diagnose?: (error: unknown) => void;
  readonly retryDelaysMs?: readonly number[];
}

type Entry = {
  native: boolean;
  running: boolean;
  waiting: boolean;
  deferredCompletion: boolean;
  notifications: Notification[];
  session: Session;
};

type Version = {
  lifetime: object;
  nativeGeneration: number;
  subscriptionGeneration: number;
};

type PendingRequest = {
  version: Version;
  completed: boolean;
  startedNewTurn: boolean;
  attempts: number;
};

const LIMIT = 256;
const DEFAULT_RETRY_DELAYS_MS = [50, 150, 400] as const;
const DELETE_METHODS = /^thread\/(?:deleted|archived|closed)$/u;
const METADATA_METHODS = /^thread\/(?:name\/(?:set|updated)|metadata\/(?:update|updated))$/u;
const ACTIVITY_METHODS =
  /^(?:turn\/(?:started|completed)|thread\/(?:started|status\/changed)|.*(?:requestApproval|requestUserInput|elicitation\/request|questions\/updated|serverRequest\/resolved))$/u;

export class ExtensionActivity {
  readonly #events: ClientChannelEvents;
  readonly #snapshot: (id: string) => Promise<ClientThreadSnapshot>;
  readonly #readMetadata: ((id: string) => Promise<ExtensionActivityMetadata | null>) | undefined;
  readonly #describeHarness: (id: string) => Promise<Session["harness"]>;
  readonly #diagnose: (error: unknown) => void;
  readonly #retryDelaysMs: readonly number[];
  readonly #entries = new Map<string, Entry>();
  readonly #versions = new Map<string, Version>();
  readonly #pending = new Map<string, PendingRequest>();
  readonly #metadataPending = new Map<string, Version>();
  readonly #inFlight = new Set<string>();
  readonly #metadataInFlight = new Set<string>();
  readonly #retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  #unsubscribe: (() => void) | undefined;
  #reading = 0;
  #metadataReading = 0;
  #revision = 0;
  #nativeGeneration = 0;
  #subscriptionGeneration = 0;
  #closed = false;

  constructor(options: ExtensionActivityOptions) {
    this.#events = options.events;
    this.#snapshot = options.snapshot;
    this.#readMetadata = options.readMetadata;
    this.#describeHarness = options.describeHarness ?? (async () => undefined);
    this.#diagnose = options.diagnose ?? (() => undefined);
    this.#retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  }

  get active(): boolean {
    return this.#unsubscribe !== undefined;
  }

  start(): void {
    if (this.#closed || this.#unsubscribe) return;
    const subscriptionGeneration = ++this.#subscriptionGeneration;
    this.#unsubscribe = this.#events.subscribe((event) => {
      if (this.#closed || subscriptionGeneration !== this.#subscriptionGeneration) return;
      if (event.type !== "changed") return;
      const id = event.threadId;
      if (!id || id.length > 1024) return;
      if (DELETE_METHODS.test(event.method)) {
        this.#clearRetryTimer(id);
        this.#versions.delete(id);
        this.#pending.delete(id);
        this.#metadataPending.delete(id);
        if (this.#entries.delete(id)) this.#revision++;
        return;
      }
      if (METADATA_METHODS.test(event.method)) {
        const currentVersion = this.#versions.get(id);
        if (!currentVersion || !this.#readMetadata) return;
        this.#metadataPending.set(id, currentVersion);
        this.#drainMetadata();
        return;
      }
      if (!ACTIVITY_METHODS.test(event.method)) return;
      if (!this.#versions.has(id) && this.#versions.size >= LIMIT) {
        const oldest = [...this.#versions.keys()].find((key) => {
          const entry = this.#entries.get(key);
          return !entry?.running && !entry?.waiting;
        });
        if (oldest === undefined) return;
        this.#clearRetryTimer(oldest);
        this.#versions.delete(oldest);
        this.#pending.delete(oldest);
        this.#metadataPending.delete(oldest);
        if (this.#entries.delete(oldest)) this.#revision++;
      }
      this.#clearRetryTimer(id);
      const version: Version = {
        lifetime: this.#versions.get(id)?.lifetime ?? {},
        nativeGeneration: this.#nativeGeneration,
        subscriptionGeneration,
      };
      this.#versions.set(id, version);
      const existingPending = this.#pending.get(id);
      const isTurnStarted = event.method === "turn/started";
      const isTurnCompleted = event.method === "turn/completed";
      const completed = isTurnStarted
        ? false
        : isTurnCompleted || existingPending?.completed === true;
      const startedNewTurn =
        isTurnStarted || (existingPending?.startedNewTurn === true && !isTurnCompleted);
      this.#pending.set(id, {
        version,
        completed,
        startedNewTurn,
        attempts: 0,
      });
      this.#drain();
    });
  }

  stop(): void {
    this.#subscriptionGeneration++;
    const unsubscribe = this.#unsubscribe;
    this.#unsubscribe = undefined;
    unsubscribe?.();
    for (const timer of this.#retryTimers.values()) clearTimeout(timer);
    this.#retryTimers.clear();
    this.#pending.clear();
    this.#metadataPending.clear();
    this.#versions.clear();
    if (this.#entries.size > 0) {
      this.#entries.clear();
      this.#revision++;
    }
  }

  read(): ExtensionActivitySnapshot {
    const entries = [...this.#entries.values()];
    const sessions = entries
      .map((entry) => entry.session)
      .sort((left, right) => {
        const priority = (value: Session) =>
          value.state === "waiting"
            ? 0
            : value.state === "running"
              ? 1
              : value.state === "failed"
                ? 2
                : 3;
        return priority(left) - priority(right) || right.updatedAt - left.updatedAt;
      })
      .slice(0, 32);
    return {
      epoch: this.#events.epoch,
      revision: this.#revision,
      running: entries.filter((entry) => entry.running && !entry.waiting).length,
      waiting: entries.filter((entry) => entry.waiting).length,
      sessions,
      notifications: entries.flatMap((entry) => entry.notifications).slice(-LIMIT),
    };
  }

  resetNative(): void {
    this.#nativeGeneration++;
    for (const [id, entry] of this.#entries) {
      if (!entry.native) continue;
      this.#clearRetryTimer(id);
      this.#entries.delete(id);
      this.#versions.delete(id);
      this.#pending.delete(id);
      this.#metadataPending.delete(id);
      this.#revision++;
    }
  }

  close(): void {
    this.#closed = true;
    this.stop();
  }

  #clearRetryTimer(id: string): void {
    const timer = this.#retryTimers.get(id);
    if (!timer) return;
    clearTimeout(timer);
    this.#retryTimers.delete(id);
  }

  #drain(): void {
    while (!this.#closed && this.#unsubscribe && this.#reading < 4 && this.#pending.size) {
      const next = [...this.#pending.entries()].find(([id]) => !this.#inFlight.has(id));
      if (!next) return;
      const [id, request] = next;
      this.#pending.delete(id);
      this.#inFlight.add(id);
      this.#reading++;
      void this.#snapshot(id)
        .then(async (snapshot) => ({
          snapshot,
          harness:
            snapshot.thread.modelProvider !== "codexhost"
              ? { id: "codex", name: "Codex" }
              : await this.#describeHarness(id).catch(() => undefined),
        }))
        .then(
          ({ snapshot, harness }) => {
            if (
              this.#closed ||
              request.version.subscriptionGeneration !== this.#subscriptionGeneration
            )
              return;
            const native = snapshot.thread.modelProvider !== "codexhost";
            if (native && request.version.nativeGeneration !== this.#nativeGeneration) {
              if (this.#versions.get(id) === request.version) {
                this.#clearRetryTimer(id);
                this.#versions.delete(id);
                this.#pending.delete(id);
                this.#metadataPending.delete(id);
              }
              return;
            }
            if (this.#versions.get(id) !== request.version) {
              const pending = this.#pending.get(id);
              if (
                pending &&
                request.completed &&
                !pending.startedNewTurn &&
                pending.version.lifetime === request.version.lifetime
              )
                pending.completed = true;
              return;
            }
            const before = this.#entries.get(id);
            const running =
              Boolean(snapshot.activeTurnId) || snapshot.thread.status.type === "active";
            const waiting = snapshot.interactions.length > 0;
            const hadDeferredCompletion =
              !request.startedNewTurn &&
              !snapshot.activeTurnId &&
              before?.deferredCompletion === true;
            const completionPending = request.completed || hadDeferredCompletion;
            const deferredCompletion = completionPending && running;
            const notifications: Notification[] = [];
            const candidates: Array<{ key: string; kind: Notification["kind"] }> =
              snapshot.interactions.slice(0, 32).map((interaction) => ({
                key: JSON.stringify([id, interaction.requestId]),
                kind: interaction.kind,
              }));
            const turn = snapshot.turnsPage.data.find((item) => item.status !== "inProgress");
            if (
              completionPending &&
              !running &&
              turn &&
              (turn.status === "completed" || turn.status === "failed")
            )
              candidates.push({ key: JSON.stringify([id, turn.id]), kind: turn.status });
            else if (!running)
              candidates.push(
                ...(before?.notifications.filter(
                  (value) => value.kind === "completed" || value.kind === "failed",
                ) ?? []),
              );
            for (const candidate of candidates) {
              if (candidate.key.length > 4096) continue;
              const existing = before?.notifications.find((value) => value.key === candidate.key);
              notifications.push(
                existing ?? { ...candidate, threadId: id, revision: ++this.#revision },
              );
            }
            const entry: Entry = {
              native,
              running,
              waiting,
              deferredCompletion,
              notifications,
              session: {
                threadId: id,
                title:
                  typeof snapshot.thread.name === "string" && snapshot.thread.name.trim()
                    ? snapshot.thread.name.trim().slice(0, 240)
                    : "",
                project: projectName(snapshot.thread.cwd),
                ...(harness
                  ? { harness: { id: harness.id.slice(0, 128), name: harness.name.slice(0, 128) } }
                  : {}),
                state: sessionState(running, waiting, snapshot.turnsPage.data[0]?.status),
                updatedAt:
                  typeof snapshot.thread.updatedAt === "number" &&
                  Number.isFinite(snapshot.thread.updatedAt)
                    ? Math.max(0, snapshot.thread.updatedAt)
                    : 0,
              },
            };
            if (observableFingerprint(before) !== observableFingerprint(entry)) this.#revision++;
            this.#entries.delete(id);
            this.#entries.set(id, entry);
          },
          (error) => {
            this.#diagnose(error);
            if (
              this.#closed ||
              request.version.subscriptionGeneration !== this.#subscriptionGeneration
            )
              return;
            if (this.#versions.get(id) !== request.version) {
              const pending = this.#pending.get(id);
              if (
                pending &&
                request.completed &&
                !pending.startedNewTurn &&
                pending.version.lifetime === request.version.lifetime
              )
                pending.completed = true;
              return;
            }
            const delayMs = this.#retryDelaysMs[request.attempts];
            if (delayMs !== undefined) {
              this.#clearRetryTimer(id);
              const timer = setTimeout(() => {
                this.#retryTimers.delete(id);
                if (
                  this.#closed ||
                  !this.#unsubscribe ||
                  this.#versions.get(id) !== request.version
                )
                  return;
                this.#pending.set(id, {
                  ...request,
                  attempts: request.attempts + 1,
                });
                this.#drain();
              }, delayMs);
              timer.unref?.();
              this.#retryTimers.set(id, timer);
              return;
            }
            this.#versions.delete(id);
            this.#metadataPending.delete(id);
            if (this.#entries.delete(id)) this.#revision++;
          },
        )
        .finally(() => {
          this.#inFlight.delete(id);
          this.#reading--;
          this.#drain();
          this.#drainMetadata();
        });
    }
  }

  #drainMetadata(): void {
    const readMetadata = this.#readMetadata;
    if (!readMetadata) return;
    while (
      !this.#closed &&
      this.#unsubscribe &&
      this.#metadataReading < 4 &&
      this.#metadataPending.size
    ) {
      const next = [...this.#metadataPending.entries()].find(
        ([id]) => !this.#metadataInFlight.has(id) && !this.#inFlight.has(id),
      );
      if (!next) return;
      const [id, version] = next;
      this.#metadataPending.delete(id);
      if (!this.#entries.has(id)) continue;
      this.#metadataInFlight.add(id);
      this.#metadataReading++;
      void readMetadata(id)
        .then(
          (metadata) => {
            if (
              !metadata ||
              this.#closed ||
              version.subscriptionGeneration !== this.#subscriptionGeneration
            )
              return;
            const currentVersion = this.#versions.get(id);
            const entry = this.#entries.get(id);
            if (!entry || !currentVersion || currentVersion.lifetime !== version.lifetime) return;
            if (entry.native && version.nativeGeneration !== this.#nativeGeneration) return;
            const nextSession: Session = {
              ...entry.session,
              title: metadata.title.trim().slice(0, 240),
              project: projectName(metadata.cwd),
              updatedAt:
                Number.isFinite(metadata.updatedAt) && metadata.updatedAt >= 0
                  ? metadata.updatedAt
                  : entry.session.updatedAt,
            };
            const updated: Entry = { ...entry, session: nextSession };
            if (observableFingerprint(entry) !== observableFingerprint(updated)) {
              this.#revision++;
              this.#entries.set(id, updated);
            }
          },
          (error) => {
            this.#diagnose(error);
          },
        )
        .finally(() => {
          this.#metadataInFlight.delete(id);
          this.#metadataReading--;
          this.#drainMetadata();
        });
    }
  }
}

function observableFingerprint(entry: Entry | undefined): string {
  if (!entry) return "";
  return JSON.stringify({
    native: entry.native,
    running: entry.running,
    waiting: entry.waiting,
    notifications: entry.notifications,
    session: entry.session,
  });
}

function projectName(cwd: string): string {
  const normalized = cwd.replace(/[\\/]+$/u, "");
  const name = normalized.split(/[\\/]/u).at(-1)?.trim();
  return name ? name.slice(0, 240) : "CodexHost";
}

function sessionState(
  running: boolean,
  waiting: boolean,
  turnStatus: string | undefined,
): Session["state"] {
  if (waiting) return "waiting";
  if (running) return "running";
  if (turnStatus === "failed") return "failed";
  if (turnStatus === "completed") return "completed";
  return "idle";
}
