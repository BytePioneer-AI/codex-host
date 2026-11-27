import type { ClientThreadSnapshot, ExtensionActivitySnapshot } from "@codexhost/shared-contracts";
import type { ClientChannelEvents } from "./client-channel-events.js";

type Notification = ExtensionActivitySnapshot["notifications"][number];
type Session = ExtensionActivitySnapshot["sessions"][number];
type Entry = {
  native: boolean;
  running: boolean;
  waiting: boolean;
  notifications: Notification[];
  session: Session;
};
type Version = { lifetime: object; nativeGeneration: number };
const LIMIT = 256;
const METHODS =
  /^(?:turn\/(?:started|completed)|thread\/(?:started|status\/changed|name\/(?:set|updated)|metadata\/(?:update|updated))|.*(?:requestApproval|requestUserInput|elicitation\/request|questions\/updated|serverRequest\/resolved))$/u;

export class ExtensionActivity {
  readonly #entries = new Map<string, Entry>();
  readonly #versions = new Map<string, Version>();
  readonly #pending = new Map<string, { completed: boolean; version: Version }>();
  readonly #inFlight = new Set<string>();
  readonly #stop: () => void;
  #reading = 0;
  #revision = 0;
  #nativeGeneration = 0;
  #closed = false;

  constructor(
    private readonly events: ClientChannelEvents,
    private readonly snapshot: (id: string) => Promise<ClientThreadSnapshot>,
    private readonly diagnose: (error: unknown) => void = () => undefined,
    private readonly describeHarness: (id: string) => Promise<Session["harness"]> = async () =>
      undefined,
  ) {
    this.#stop = events.subscribe((event) => {
      if (event.type !== "changed") return;
      const id = event.threadId;
      if (!id || id.length > 1024) return;
      if (/^thread\/(?:deleted|archived|closed)$/u.test(event.method)) {
        this.#versions.delete(id);
        this.#pending.delete(id);
        if (this.#entries.delete(id)) this.#revision++;
        return;
      }
      if (!METHODS.test(event.method)) return;
      if (!this.#versions.has(id) && this.#versions.size >= LIMIT) {
        const oldest = [...this.#versions.keys()].find((key) => {
          const entry = this.#entries.get(key);
          return !entry?.running && !entry?.waiting;
        });
        if (oldest === undefined) return;
        this.#versions.delete(oldest);
        this.#pending.delete(oldest);
        if (this.#entries.delete(oldest)) this.#revision++;
      }
      const version = {
        lifetime: this.#versions.get(id)?.lifetime ?? {},
        nativeGeneration: this.#nativeGeneration,
      };
      this.#versions.set(id, version);
      this.#pending.set(id, {
        version,
        completed: event.method === "turn/completed" || this.#pending.get(id)?.completed === true,
      });
      this.#drain();
    });
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
      epoch: this.events.epoch,
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
      this.#entries.delete(id);
      this.#versions.delete(id);
      this.#pending.delete(id);
      this.#revision++;
    }
  }

  close(): void {
    this.#closed = true;
    this.#stop();
    this.#pending.clear();
    this.#versions.clear();
    this.#entries.clear();
  }

  #drain(): void {
    while (!this.#closed && this.#reading < 4 && this.#pending.size) {
      const next = [...this.#pending.entries()].find(([id]) => !this.#inFlight.has(id));
      if (!next) return;
      const [id, request] = next;
      this.#pending.delete(id);
      this.#inFlight.add(id);
      this.#reading++;
      void this.snapshot(id)
        .then(async (snapshot) => ({
          snapshot,
          harness:
            snapshot.thread.modelProvider !== "codexhost"
              ? { id: "codex", name: "Codex" }
              : await this.describeHarness(id).catch(() => undefined),
        }))
        .then(
          ({ snapshot, harness }) => {
            if (this.#closed) return;
            const native = snapshot.thread.modelProvider !== "codexhost";
            if (native && request.version.nativeGeneration !== this.#nativeGeneration) {
              if (this.#versions.get(id) === request.version) {
                this.#versions.delete(id);
                this.#pending.delete(id);
              }
              return;
            }
            if (this.#versions.get(id) !== request.version) {
              const pending = this.#pending.get(id);
              if (
                pending &&
                request.completed &&
                pending.version.lifetime === request.version.lifetime
              )
                pending.completed = true;
              return;
            }
            const before = this.#entries.get(id);
            const notifications: Notification[] = [];
            const candidates: Array<{ key: string; kind: Notification["kind"] }> =
              snapshot.interactions.slice(0, 32).map((interaction) => ({
                key: JSON.stringify([id, interaction.requestId]),
                kind: interaction.kind,
              }));
            const turn = snapshot.turnsPage.data.find((turn) => turn.status !== "inProgress");
            if (
              request.completed &&
              turn &&
              (turn.status === "completed" || turn.status === "failed")
            )
              candidates.push({ key: JSON.stringify([id, turn.id]), kind: turn.status });
            else if (!snapshot.activeTurnId)
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
            const entry = {
              native,
              running: Boolean(snapshot.activeTurnId),
              waiting: snapshot.interactions.length > 0,
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
                state: sessionState(
                  Boolean(snapshot.activeTurnId),
                  snapshot.interactions.length > 0,
                  snapshot.turnsPage.data[0]?.status,
                ),
                updatedAt:
                  typeof snapshot.thread.updatedAt === "number" &&
                  Number.isFinite(snapshot.thread.updatedAt)
                    ? Math.max(0, snapshot.thread.updatedAt)
                    : 0,
              } satisfies Session,
            };
            if (JSON.stringify(before) !== JSON.stringify(entry)) this.#revision++;
            this.#entries.delete(id);
            this.#entries.set(id, entry);
          },
          (error) => {
            if (this.#versions.get(id) === request.version) {
              if (this.#entries.delete(id)) this.#revision++;
            }
            this.diagnose(error);
          },
        )
        .finally(() => {
          this.#inFlight.delete(id);
          this.#reading--;
          this.#drain();
        });
    }
  }
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
