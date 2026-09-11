import { isDeepStrictEqual } from "node:util";

import {
  HarnessOutputChannel,
  type HarnessOutput,
  type HarnessResult,
  type HarnessSession,
  type HostEvent,
  type HostItemSnapshot,
  type HostThreadSnapshot,
} from "@codexhost/harness-adapter";
import type { HostItemId, HostTurnId } from "@codexhost/shared-contracts";

import { isRecord } from "../projection.js";
import type { DeepSeekModernProfile } from "../profiles/profile.js";
import {
  ModernJournalError,
  type ModernJournalEvent,
  type ModernJournalHeader,
  type ModernJournalRemote,
} from "./journal.js";
import {
  decodeModernSubagentId,
  encodeModernSubagentId,
  isModernSubagentTool,
  MODERN_SUBAGENT_MAX_CHILDREN,
  MODERN_SUBAGENT_MAX_DEPTH,
  modernSubagentState,
  parseModernSubagentCatalog,
  projectModernSubagents,
  type ModernSubagentEntry,
  type ModernSubagentFacts,
  type ModernSubagentPath,
} from "./subagent-projection.js";

export {
  decodeModernSubagentId,
  encodeModernSubagentId,
  type ModernSubagentPath,
} from "./subagent-projection.js";

export interface ModernSubagentObservation {
  session: HarnessSession;
  header: ModernJournalHeader;
  events: readonly ModernJournalEvent[];
  inheritedEventCount: number;
}

export interface ModernSubagentsOptions {
  rootSessionId: string;
  cwd: string;
  remote: ModernJournalRemote;
  profile: DeepSeekModernProfile;
  rootJournal(): Pick<ModernSubagentObservation, "events" | "inheritedEventCount">;
  openObservation(path: ModernSubagentPath): Promise<ModernSubagentObservation>;
  emit?(event: HostEvent): void;
}

interface Child {
  facts: ModernSubagentFacts;
  observation: ModernSubagentObservation;
  pump?: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
  failed: boolean;
  openedThroughSeq: number;
  revision: number;
  projectedRevision: number;
  projectedEventCount: number;
  projectedActivity: ModernSubagentEntry["activity"];
}

/** One parent-owned observer; opening and closing it never starts or cancels native work. */
export class ModernSubagents {
  readonly #options: ModernSubagentsOptions;
  readonly #children = new Map<string, Child>();
  readonly #controller = new AbortController();
  #emit: (event: HostEvent) => void;
  #refreshing: Promise<void> | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;
  #closed = false;
  #closing: Promise<void> | undefined;
  readonly #opening = new Map<string, Promise<Child | undefined>>();
  readonly #independent = new Set<string>();

  constructor(options: ModernSubagentsOptions) {
    this.#options = options;
    this.#emit = options.emit ?? (() => {});
  }

  setEmitter(emit: (event: HostEvent) => void): void {
    this.#emit = emit;
  }

  observedPaths(): { path: ModernSubagentPath; status: ModernSubagentFacts["state"]["status"] }[] {
    return [...this.#children.values()].map((child) => ({
      path: child.facts.path,
      status: child.facts.state.status,
    }));
  }

  refresh(afterCurrent = false): Promise<void> {
    if (this.#closed) return Promise.resolve();
    // A tool receipt must not reuse a directory cut requested before child creation.
    if (afterCurrent && this.#refreshing)
      return this.#refreshing.catch(() => {}).then(() => this.refresh());
    if (!this.#timer) {
      this.#timer = setInterval(() => {
        void this.refresh().catch(() => {});
      }, 1000);
      this.#timer.unref();
    }
    return (this.#refreshing ??= this.#refresh().finally(() => {
      this.#refreshing = undefined;
    }));
  }

  async #list(parentId: string): Promise<ModernSubagentEntry[]> {
    const result = await this.#options.remote.call<unknown>(
      "subagents/list",
      { parentSessionId: parentId },
      this.#controller.signal,
    );
    if (!result.ok)
      throw new ModernJournalError("unavailable", "DeepSeek subagent catalog is unavailable");
    return parseModernSubagentCatalog(result.value);
  }

  async #refresh(): Promise<void> {
    const parents: ModernSubagentPath[] = [[]];
    let count = 0;
    for (const path of parents) {
      if (this.#closed) return;
      const parentId = path.at(-1)?.childSessionId ?? this.#options.rootSessionId;
      const entries = await this.#list(parentId);
      for (const entry of entries) {
        if (this.#closed) return;
        if (++count > MODERN_SUBAGENT_MAX_CHILDREN)
          throw new ModernJournalError(
            "limitExceeded",
            "DeepSeek subagent tree exceeded its child limit",
          );
        if (
          path.some((ancestor) => ancestor.childSessionId === entry.id) ||
          entry.id === this.#options.rootSessionId
        )
          throw new ModernJournalError(
            "protocolError",
            "DeepSeek subagent ancestry contains a cycle",
          );
        const childPath = [...path, { childSessionId: entry.id, mode: entry.mode }];
        if (childPath.length > MODERN_SUBAGENT_MAX_DEPTH)
          throw new ModernJournalError(
            "limitExceeded",
            "DeepSeek subagent ancestry exceeded its depth limit",
          );
        try {
          const child = await this.#ensure(childPath, entry);
          if (child) await this.#update(child);
          if (child && entry.hasChildren) parents.push(childPath);
        } catch {
          // A failed observation is not a child outcome. A later refresh retries it.
        }
      }
    }
  }

  async #ensure(path: ModernSubagentPath, entry: ModernSubagentEntry): Promise<Child | undefined> {
    const id = encodeModernSubagentId(this.#options.rootSessionId, path);
    const previous = this.#children.get(id);
    if (previous && !previous.failed) {
      previous.facts.entry = entry;
      return previous;
    }
    const opening = this.#opening.get(id);
    if (opening) return opening;
    const next = this.#open(path, entry, previous).finally(() => {
      this.#opening.delete(id);
    });
    this.#opening.set(id, next);
    return next;
  }

  async #open(
    path: ModernSubagentPath,
    entry: ModernSubagentEntry,
    previous: Child | undefined,
  ): Promise<Child | undefined> {
    const id = encodeModernSubagentId(this.#options.rootSessionId, path);
    if (!previous && this.#children.size >= MODERN_SUBAGENT_MAX_CHILDREN)
      throw new ModernJournalError(
        "limitExceeded",
        "DeepSeek subagent observation exceeded its child limit",
      );
    if (previous) await this.#dispose(previous);
    const observation = await this.#options.openObservation(path);
    try {
      if (this.#closed) {
        await observation.session.close();
        return undefined;
      }
      const parentId = path.at(-2)?.childSessionId ?? this.#options.rootSessionId;
      const descriptor = observation.events
        .slice(observation.inheritedEventCount)
        .findLast((event) => event.type === "subagent/descriptor")?.data;
      if (
        observation.header.id !== entry.id ||
        observation.header.parentSession !== parentId ||
        observation.header.origin !== "subagent" ||
        observation.header.cwd !== this.#options.cwd ||
        observation.header.version !== this.#options.profile.sessionFormatVersion ||
        !isRecord(descriptor) ||
        descriptor.version !== 3 ||
        descriptor.mode !== entry.mode
      ) {
        throw new ModernJournalError(
          "protocolError",
          "DeepSeek subagent does not match its verified parent address",
        );
      }
      const snapshot = await observation.session.readSnapshot();
      if (!snapshot.ok)
        throw new ModernJournalError("unavailable", "DeepSeek subagent history is unavailable");
      const seed = {
        entry,
        path,
        header: observation.header,
        events: observation.events,
        inheritedEventCount: observation.inheritedEventCount,
        snapshot: snapshot.value,
      };
      const child: Child = {
        observation,
        facts: { ...seed, state: modernSubagentState(this.#options.rootSessionId, seed) },
        failed: false,
        openedThroughSeq: observation.events.at(-1)?.seq ?? -1,
        revision: 0,
        projectedRevision: 0,
        projectedEventCount: observation.events.length,
        projectedActivity: entry.activity,
      };
      this.#children.set(id, child);
      child.pump = this.#pump(child);
      this.#notify(child, true);
      return child;
    } catch (error) {
      await observation.session.close();
      throw error;
    }
  }

  async #pump(child: Child): Promise<void> {
    try {
      for await (const output of child.observation.session.outputs) {
        if (this.#closed) return;
        if (output.kind !== "event") continue;
        child.revision++;
        if (output.event.type === "session.faulted") {
          child.failed = true;
          return;
        }
        const edge = child.facts.events.findLast(
          (event) => event.type === "turn/start" || event.type === "turn/end",
        );
        if (
          output.event.type === "turn.started" ||
          output.event.type === "turn.autonomous.started"
        ) {
          if (edge?.type === "turn/start" && edge.seq > child.openedThroughSeq)
            child.facts.entry.activity = "running";
        }
        if (output.event.type === "turn.completed") {
          if (edge?.type === "turn/end") child.facts.entry.activity = "inactive";
          await this.#update(child);
        } else if (!child.timer) {
          child.timer = setTimeout(() => {
            delete child.timer;
            void this.#update(child).catch(() => {
              child.failed = true;
            });
          }, 100);
          child.timer.unref();
        }
      }
      if (!this.#closed) child.failed = true;
    } catch {
      child.failed = true;
    }
  }

  async #update(child: Child): Promise<void> {
    if (this.#closed || child.failed) return;
    const revision = child.revision;
    const eventCount = child.facts.events.length;
    if (
      revision === child.projectedRevision &&
      eventCount === child.projectedEventCount &&
      child.projectedActivity === child.facts.entry.activity
    )
      return;
    const snapshot = await child.observation.session.readSnapshot();
    if (!snapshot.ok) return;
    if (this.#closed) return;
    child.projectedRevision = revision;
    child.projectedEventCount = eventCount;
    child.projectedActivity = child.facts.entry.activity;
    const changed = !isDeepStrictEqual(child.facts.snapshot, snapshot.value);
    child.facts.snapshot = snapshot.value;
    const state = modernSubagentState(this.#options.rootSessionId, child.facts);
    const stateChanged = !isDeepStrictEqual(child.facts.state, state);
    child.facts.state = state;
    if (stateChanged) this.#notify(child, false);
    if (changed)
      this.#emit({
        type: "subagent.transcript.changed",
        nativeSubagentId: state.nativeSubagentId,
      });
  }

  #notify(child: Child, transcript: boolean): void {
    if (this.#closed) return;
    const { nativeSubagentId, status, resultSummary } = child.facts.state;
    this.#emit({
      type: "subagent.state.changed",
      nativeSubagentId,
      status,
      ...(resultSummary ? { resultSummary } : {}),
    });
    if (transcript) this.#emit({ type: "subagent.transcript.changed", nativeSubagentId });
  }

  project(snapshot: HostThreadSnapshot, path: ModernSubagentPath = []): HostThreadSnapshot {
    const key = encodeModernSubagentId(this.#options.rootSessionId, path);
    const journal = path.length
      ? this.#children.get(key)?.observation
      : this.#options.rootJournal();
    if (!journal) return snapshot;
    const children = [...this.#children.values()]
      .map((child) => child.facts)
      .filter(
        (child) =>
          child.path.length === path.length + 1 &&
          encodeModernSubagentId(this.#options.rootSessionId, child.path.slice(0, -1)) === key,
      );
    const projected = projectModernSubagents({
      snapshot,
      parentId: path.at(-1)?.childSessionId ?? this.#options.rootSessionId,
      events: journal.events,
      inheritedEventCount: journal.inheritedEventCount,
      children,
      independentChildren: this.#independent,
    });
    for (const turn of projected.turns)
      for (const { item } of turn.items) {
        if (item.type === "subagentDelegation" && String(item.itemId).includes(":subagent:")) {
          for (const child of item.subagents)
            if (child.nativeSubagentId) this.#independent.add(child.nativeSubagentId);
        }
      }
    return projected;
  }

  async readSnapshot(handle: string): Promise<HarnessResult<HostThreadSnapshot>> {
    try {
      if (this.#closed)
        throw new ModernJournalError("unavailable", "DeepSeek subagent observer is closed");
      const path = decodeModernSubagentId(handle, this.#options.rootSessionId);
      await this.#refreshing;
      let child: Child | undefined;
      for (const [depth, entry] of path.entries()) {
        const parentId = path[depth - 1]?.childSessionId ?? this.#options.rootSessionId;
        const listed = (await this.#list(parentId)).find(
          (candidate) => candidate.id === entry.childSessionId && candidate.mode === entry.mode,
        );
        if (!listed)
          throw new ModernJournalError(
            "protocolError",
            "DeepSeek subagent does not belong to the supplied parent",
          );
        child = await this.#ensure(path.slice(0, depth + 1), listed);
      }
      if (!child)
        throw new ModernJournalError("unavailable", "DeepSeek subagent history is unavailable");
      await this.#update(child);
      if (child.failed)
        throw new ModernJournalError("unavailable", "DeepSeek subagent observation is unavailable");
      await this.refresh();
      return { ok: true, value: this.project(child.facts.snapshot, path) };
    } catch (error) {
      return {
        ok: false,
        error: {
          code:
            error instanceof ModernJournalError && error.code === "protocolError"
              ? "protocolError"
              : "unavailable",
          message:
            error instanceof ModernJournalError
              ? error.message
              : "DeepSeek subagent history is unavailable",
          retryable: !(error instanceof ModernJournalError && error.code === "protocolError"),
        },
      };
    }
  }

  async #dispose(child: Child): Promise<void> {
    clearTimeout(child.timer);
    await child.observation.session.close();
    await child.pump;
  }

  close(): Promise<void> {
    return (this.#closing ??= (async () => {
      this.#closed = true;
      this.#controller.abort();
      clearInterval(this.#timer);
      await this.#refreshing?.catch(() => {});
      await Promise.allSettled([...this.#opening.values()]);
      await Promise.allSettled([...this.#children.values()].map((child) => this.#dispose(child)));
      this.#children.clear();
    })());
  }
}

/** Preserve Item types: unresolved native calls are buffered until a verified child or tool result exists. */
export function withModernSubagents(
  session: HarnessSession,
  monitor: ModernSubagents,
  liveSnapshot: () => Promise<HarnessResult<HostThreadSnapshot>> = () => session.readSnapshot(),
): HarnessSession {
  const channel = new HarnessOutputChannel<HarnessOutput>();
  const pending = new Map<
    HostItemId,
    { start: Extract<HostEvent, { type: "item.started" }>; updates: HarnessOutput[] }
  >();
  const activeCards = new Map<HostItemId, HostItemSnapshot>();
  let activeTurn: HostTurnId | undefined;
  let closed = false;
  let closing: Promise<void> | undefined;
  let queue = Promise.resolve();
  const emit = (event: HostEvent): void => {
    channel.emit({ kind: "event", event });
  };
  const schedule = (work: () => Promise<void>, fallback: () => void): void => {
    queue = queue.then(work).catch(() => {
      if (!closed) fallback();
    });
  };
  const forward = (output: HarnessOutput): void => {
    if (output.kind === "event" && output.event.type === "item.completed") {
      const event = output.event;
      const buffered = pending.get(event.snapshot.item.itemId);
      if (buffered) {
        emit(buffered.start);
        for (const update of buffered.updates) channel.emit(update);
        pending.delete(event.snapshot.item.itemId);
      }
      const card = activeCards.get(event.snapshot.item.itemId);
      emit(card ? { ...event, snapshot: { ...event.snapshot, item: card.item } } : event);
      return;
    }
    if (output.kind === "event" && output.event.type === "turn.completed") activeTurn = undefined;
    channel.emit(output);
  };
  const projected = async (): Promise<Map<HostItemId, HostItemSnapshot>> => {
    const snapshot = await liveSnapshot();
    return new Map(
      snapshot.ok
        ? (monitor.project(snapshot.value).turns.at(-1)?.items ?? []).map(
            (item) => [item.item.itemId, item] as const,
          )
        : [],
    );
  };
  const flush = async (): Promise<void> => {
    if (closed || !activeTurn) return;
    const items = await projected();
    for (const [id, buffered] of pending) {
      const item = items.get(id);
      if (item?.item.type !== "subagentDelegation") continue;
      emit({ ...buffered.start, item: item.item });
      pending.delete(id);
      activeCards.set(id, item);
    }
    for (const [id, snapshot] of items) {
      if (snapshot.item.type !== "subagentDelegation" || activeCards.has(id) || pending.has(id))
        continue;
      // Only independent catalog cards use this stable suffix; never replay old tool Items.
      if (!String(id).includes(":subagent:")) continue;
      emit({ type: "item.started", turnId: activeTurn, item: snapshot.item });
      emit({ type: "item.completed", turnId: activeTurn, snapshot });
      activeCards.set(id, snapshot);
    }
  };
  monitor.setEmitter((event) =>
    schedule(
      async () => {
        await flush();
        if (!closed) emit(event);
      },
      () => emit(event),
    ),
  );
  const pump = (async () => {
    try {
      for await (const output of session.outputs) {
        schedule(
          async () => {
            if (closed) return;
            if (output.kind !== "event") {
              channel.emit(output);
              return;
            }
            const event = output.event;
            if (event.type === "turn.started" || event.type === "turn.autonomous.started") {
              activeTurn = event.turnId;
              activeCards.clear();
            }
            if (
              event.type === "item.started" &&
              event.item.type === "toolExecution" &&
              isModernSubagentTool(event.item)
            ) {
              pending.set(event.item.itemId, { start: event, updates: [] });
              void monitor.refresh().catch(() => {});
              return;
            }
            if (event.type === "item.updated" && pending.has(event.itemId)) {
              pending.get(event.itemId)?.updates.push(output);
              return;
            }
            if (event.type === "item.updated" && activeCards.has(event.itemId)) return;
            if (event.type === "item.completed") {
              if (pending.has(event.snapshot.item.itemId))
                await monitor.refresh(true).catch(() => {});
              await flush();
              const mapped = activeCards.get(event.snapshot.item.itemId);
              const latest = mapped
                ? (await projected()).get(event.snapshot.item.itemId)?.item
                : undefined;
              if (latest?.type === "subagentDelegation")
                activeCards.set(event.snapshot.item.itemId, { ...event.snapshot, item: latest });
              forward(output);
              return;
            }
            if (event.type === "turn.completed") {
              await monitor.refresh(true).catch(() => {});
              await flush();
              activeTurn = undefined;
            }
            emit(event);
          },
          () => forward(output),
        );
      }
    } finally {
      await queue;
      await monitor.close();
      channel.end();
    }
  })().catch(() => {
    channel.end();
  });
  const wrapped: HarnessSession = {
    harnessId: session.harnessId,
    capabilities: session.capabilities,
    initialState: session.initialState,
    initialUsage: session.initialUsage,
    outputs: channel.outputs,
    ...(session.commands ? { commands: session.commands } : {}),
    ...(session.refreshUsage ? { refreshUsage: session.refreshUsage.bind(session) } : {}),
    async readSnapshot() {
      await monitor.refresh().catch(() => {});
      const result = await session.readSnapshot();
      return result.ok ? { ok: true, value: monitor.project(result.value) } : result;
    },
    execute: session.execute.bind(session),
    close() {
      return (closing ??= (async () => {
        await monitor.close();
        await session.close();
        await pump;
        await queue;
        closed = true;
        channel.end();
      })());
    },
  };
  return wrapped;
}
