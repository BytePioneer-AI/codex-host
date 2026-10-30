/** Native CH pagination feeding a disposable, backwards-extensible Web journal. */
import type { ChHostClient } from "./ch-host-client.ts";
import type { ClientThreadSnapshot } from "@codexhost/shared-contracts";
import { ChThreadView, type ChThread, type ChTurn } from "./ch-thread-view.ts";
import { threadListTitle } from "./ch-thread-title.ts";
import { ChCommandPresentation } from "./ch-command-presentation.ts";
import type { ProjectionListener } from "./session-log.ts";
import { RpcError } from "./transport.ts";

const PAGE_TURNS = 5;
// The Web wire protocol requires non-negative, stable rendering coordinates. Start
// its memory-only window in the middle of the safe integer range so older pages
// can prepend without renumbering visible messages, tool references or anchors.
// These are NOT native Turn numbers/cursors and are never persisted or sent to CH.
const RENDER_ORIGIN = 2 ** 40;
// Completed Turns offered to the Host as already held; its page holds five.
const KNOWN_TURNS = 16;
interface TurnsPage {
  data: ChTurn[];
  nextCursor: string | null;
}

export class ChThreadHistory extends ChThreadView {
  private loaded = false;
  private readonly commands: ChCommandPresentation;
  ownerSnapshot: ClientThreadSnapshot | undefined;
  private lastHeadReadAt = 0;
  private prefetched = false;
  private refreshing: Promise<void> | undefined;
  private loadingOlder: Promise<void> | undefined;
  private readonly seenCursors = new Set<string>();
  private readonly pagination: { cursor: string | null };

  constructor(
    private readonly host: ChHostClient,
    thread: ChThread,
    harnessId: string,
    onProjection: ProjectionListener,
    origin = RENDER_ORIGIN,
    projectInput?: (content: unknown[]) => unknown[],
  ) {
    const pagination = { cursor: null as string | null };
    super(
      { ...thread, turns: [] },
      harnessId,
      onProjection,
      origin,
      origin,
      () => pagination.cursor !== null,
      projectInput,
    );
    this.pagination = pagination;
    this.commands = new ChCommandPresentation(this.log);
  }

  private async page(cursor: string | null): Promise<TurnsPage> {
    const result = await this.host.request<TurnsPage>("thread/turns/list", {
      threadId: this.thread.id,
      cursor,
      limit: PAGE_TURNS,
      sortDirection: "desc",
      itemsView: "full",
    });
    if (
      (result.nextCursor && result.nextCursor === cursor) ||
      (!result.data.length && result.nextCursor)
    )
      throw new RpcError("host/history-invalid", "CH history cursor did not advance.");
    if (new Set(result.data.map((turn) => turn.id)).size !== result.data.length)
      throw new RpcError("host/history-invalid", "CH history repeated a Turn within a page.");
    return result;
  }

  /** After a Host `reset`, the next read uses full snapshot semantics. */
  forgetKnownTurns(): void {
    for (const turn of this.thread.turns) delete turn.fingerprint;
  }

  /** Ask the Host to replace completed Turns this window already holds with
   * placeholders, then resolve each placeholder to the held copy. A placeholder
   * this window cannot satisfy falls back to one full read; an older Host that
   * ignores the option simply returns full Turns.
   */
  private async snapshot(
    realtime: NonNullable<ChHostClient["realtime"]>,
  ): Promise<ClientThreadSnapshot> {
    const held = new Map(this.thread.turns.map((turn) => [turn.id, turn]));
    const knownTurns = this.thread.turns
      .slice(-KNOWN_TURNS)
      .flatMap((turn) =>
        turn.fingerprint ? [{ id: turn.id, fingerprint: turn.fingerprint }] : [],
      );
    let snapshot = await realtime.snapshot(this.thread.id, { knownTurns });
    const unresolved = (value: ClientThreadSnapshot) =>
      value.turnsPage.data.some(
        (turn) => turn.unchanged && held.get(turn.id)?.fingerprint !== turn.fingerprint,
      );
    if (unresolved(snapshot)) {
      // `knownTurns: []` still requests fingerprints but can never match a placeholder.
      snapshot = await realtime.snapshot(this.thread.id, { knownTurns: [] });
      if (snapshot.turnsPage.data.some((turn) => turn.unchanged))
        throw new RpcError("host/history-invalid", "CH replaced a Turn it was not asked to.");
    }
    return {
      ...snapshot,
      turnsPage: {
        ...snapshot.turnsPage,
        data: snapshot.turnsPage.data.map((turn) => (turn.unchanged ? held.get(turn.id) : turn)),
      },
    } as ClientThreadSnapshot;
  }

  /** First open reads only the newest five Turns. Later opens reuse this window;
   * a metadata probe avoids rereading unchanged idle history, even after cache TTL.
   */
  refresh(force = false): Promise<void> {
    this.refreshing ??= (async () => {
      const snapshot = this.host.realtime ? await this.snapshot(this.host.realtime) : undefined;
      const { thread } = snapshot
        ? { thread: snapshot.thread }
        : await this.host.request<{ thread: ChThread }>("thread/read", {
            threadId: this.thread.id,
            includeTurns: false,
          });
      this.ensureCurrent();
      this.ownerSnapshot = snapshot;
      if (snapshot) {
        this.log.setProjection("inbox", {
          "next-turn": (snapshot.queue?.items ?? []).map((item) => ({
            id: item.id,
            role: "user",
            content: item.presentationInput ?? item.input,
            source: { kind: "user", rpcId: item.clientUserMessageId },
          })),
          "next-step": [],
        });
        this.log.setProjection("queueState", {
          pausedReason: snapshot.queue?.pausedReason ?? null,
        });
      }
      if (
        !force &&
        this.loaded &&
        Date.now() - this.lastHeadReadAt < 60_000 &&
        thread.updatedAt === this.thread.updatedAt &&
        thread.status.type !== "active" &&
        this.thread.status.type !== "active"
      ) {
        Object.assign(this.thread, { ...thread, turns: this.thread.turns });
        this.log.setProjection("title", threadListTitle(thread));
        this.commands.update(snapshot?.command, this.thread.turns);
        return;
      }
      const recent = snapshot ? snapshot.turnsPage : await this.page(null);
      const descending = [...recent.data];
      const newestKnown = this.thread.turns.at(-1)?.id;
      let cursor = recent.nextCursor;
      const seen = new Set<string>();
      // If multiple Turns arrived since last observation, fill the gap to the
      // loaded tail. Never silently skip Turns just because the head page is small.
      while (
        this.loaded &&
        newestKnown &&
        !descending.some((turn) => turn.id === newestKnown) &&
        cursor
      ) {
        if (seen.has(cursor))
          throw new RpcError("host/history-invalid", "CH history cursor did not advance.");
        seen.add(cursor);
        const more = await this.page(cursor);
        descending.push(...more.data);
        cursor = more.nextCursor;
      }
      if (new Set(descending.map((turn) => turn.id)).size !== descending.length)
        throw new RpcError("host/history-invalid", "CH history repeated a Turn across pages.");
      if (this.loaded && newestKnown && !descending.some((turn) => turn.id === newestKnown))
        throw new RpcError(
          "host/history-changed",
          "CH history was rewritten. Reload this page to reopen its current history.",
        );
      if (!this.loaded) {
        this.pagination.cursor = recent.nextCursor;
        this.update({ ...thread, turns: descending.reverse() });
        this.loaded = true;
      } else {
        if (!newestKnown) this.pagination.cursor = recent.nextCursor;
        const newTurns = newestKnown
          ? descending.slice(
              0,
              descending.findIndex((turn) => turn.id === newestKnown),
            )
          : descending;
        const incoming = new Map(descending.map((turn) => [turn.id, turn]));
        const known = new Set(this.thread.turns.map((turn) => turn.id));
        this.update({
          ...thread,
          turns: [
            ...this.thread.turns.map((turn) => incoming.get(turn.id) ?? turn),
            ...newTurns.reverse().filter((turn) => !known.has(turn.id)),
          ],
        });
      }
      this.commands.update(snapshot?.command, this.thread.turns);
      this.lastHeadReadAt = Date.now();
    })().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  /** Warm one page once per loaded window, not once per browser subscriber. */
  async prefetchOlder(): Promise<void> {
    if (this.prefetched) return;
    this.prefetched = true;
    try {
      await this.loadOlder();
    } catch (error) {
      this.prefetched = false;
      throw error;
    }
  }

  /** One older page, shared by foreground paging and bounded background prefetch.
   * Failed requests do not advance the cursor; retry remains possible.
   */
  loadOlder(): Promise<void> {
    this.loadingOlder ??= (async () => {
      const cursor = this.pagination.cursor;
      if (!cursor) return;
      const page = await this.page(cursor);
      if (page.nextCursor && this.seenCursors.has(page.nextCursor))
        throw new RpcError("host/history-invalid", "CH history cursor did not advance.");
      this.prepend([...page.data].reverse());
      this.seenCursors.add(cursor);
      this.pagination.cursor = page.nextCursor;
    })().finally(() => {
      this.loadingOlder = undefined;
    });
    return this.loadingOlder;
  }

  /** Extend only when the requested backwards boundary reaches native history. */
  async olderPage(throughSeq: number, beforeSeq: number | undefined, maxMessages?: number) {
    if (beforeSeq !== undefined && beforeSeq <= this.log.firstSeq) await this.loadOlder();
    return this.log.page(throughSeq, beforeSeq, { ...(maxMessages ? { maxMessages } : {}) });
  }
}
