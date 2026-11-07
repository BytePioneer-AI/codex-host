/** Session-specific adapters for Gateway-owned Remote stream lifecycles. */

import type {} from "@deepseek-ai/dsh-api-session-controller/remote";
import { RemoteError } from "@deepseek-ai/dsh-typert-protocol";
import {
  RemoteJournalStream,
  RemoteSnapshotStream,
  RemoteStreamCarrierError,
  type ClientRemote,
  type RemoteJournalChange,
  type RemoteJournalFrame,
} from "@deepseek-ai/dsh-api-gateway/client";
import type {
  SessionAddress,
  SessionAssistantStreamBaseline,
  SessionControlFrame,
  SessionFollowFrame,
  SessionHistoryRecord,
  SessionPage,
  SessionPageRequest,
  SessionProjectionBaseline,
} from "../types.ts";
import {
  historyEntries,
  historyRecordFirstSeq,
  historyRecordLastSeq,
} from "./sessions/history-records.ts";
import type { SessionEventLikeEntry, SessionLiveEventEntry } from "./contract/events.ts";
import type { SessionRemotes } from "./sessions/remotes.ts";
import { assertSessionWireEvent } from "./session-wire-event.ts";
import type { SessionJournalCache } from "./sessions/recent-views.ts";

export { SESSION_SEARCH_RESULT_LIMIT, SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS } from "../types.ts";

/** Pagination fields bound to an already-addressed Session journal. */
export type ClientSessionPageRequest = Omit<SessionPageRequest, "address" | "throughSeq">;

/** Complete generated `ctx.remote.session` namespace. */
export type SessionRemote = ClientRemote["session"];

/** Opening metadata carried only by a follow snapshot, never by loadOlder pages. */
interface SessionJournalPage extends SessionPage {
  readonly projections?: SessionProjectionBaseline;
  readonly assistantStream?: SessionAssistantStreamBaseline;
}

type SessionJournalNotification = Extract<
  SessionFollowFrame,
  { type: "assistant-stream" | "projection" }
>;

/** One complete publication from the Session journal stream. */
export type SessionJournalChange =
  | {
      readonly type: "replace" | "prepend";
      readonly page: SessionJournalPage;
      readonly entries: readonly SessionEventLikeEntry[];
      readonly hasMore: boolean;
    }
  | { readonly type: "append"; readonly entry: SessionLiveEventEntry }
  | SessionJournalNotification;

function toSessionJournalChange(
  change: RemoteJournalChange<SessionJournalPage, SessionHistoryRecord, SessionJournalNotification>,
): SessionJournalChange {
  switch (change.type) {
    case "replace":
    case "prepend":
      return { ...change, entries: historyEntries(change.entries) };
    case "append": {
      return {
        type: "append",
        entry: change.entry as unknown as SessionLiveEventEntry,
      };
    }
    case "notification":
      return change.notification;
  }
}

type SessionControlBaselineFrame = Extract<SessionControlFrame, { type: "baseline" }>;
type SessionControlDeltaFrame = Exclude<SessionControlFrame, SessionControlBaselineFrame>;

/** Gateway-owned control snapshot stream configured for Session frames. */
export type SessionControlStream = RemoteSnapshotStream<
  SessionControlBaselineFrame,
  SessionControlDeltaFrame
>;

/** Domain sinks used by the Host-wide Session control stream. */
export interface SessionControlStreamOptions {
  /** Apply a complete baseline or one later update. */
  readonly accept: (frame: SessionControlFrame) => void;
  /** Observe a retryable carrier loss before reconnection. */
  readonly carrierFailed?: (error: RemoteStreamCarrierError) => void;
  /** Publish a terminal business or protocol failure. */
  readonly failed: (error: unknown) => void;
}

/** Domain sinks used by one addressed Session event journal. */
export interface SessionEventStreamOptions {
  /** Apply one complete event-window change. */
  readonly publish: (change: SessionJournalChange) => void;
  /** Observe a retryable carrier loss before reconnection. */
  readonly carrierFailed?: (error: RemoteStreamCarrierError) => void;
  /** Publish a terminal stream, page, or protocol failure after opening. */
  readonly failed: (error: unknown) => void;
}

/**
 * Create the Host-wide Session control snapshot stream.
 * @param remote - generated Session namespace and Gateway stream factory.
 * @param options - Session state destinations.
 * @returns an unstarted stream owned by the Client Session runtime.
 */
export function createSessionControlStream(
  remote: SessionRemotes,
  options: SessionControlStreamOptions,
): SessionControlStream {
  const stream = remote.$stream<SessionControlFrame>({
    name: "session control stream",
    open: (signal) => remote.session.control(signal),
    ended: (accepted) =>
      accepted
        ? new RemoteStreamCarrierError("session control stream ended without a terminal result")
        : new Error("session control stream ended before its opening snapshot"),
    ...(options.carrierFailed === undefined ? {} : { carrierFailed: options.carrierFailed }),
  });
  return new RemoteSnapshotStream(stream, {
    name: "session control stream",
    isSnapshot: (frame): frame is SessionControlBaselineFrame => frame.type === "baseline",
    replace: options.accept,
    update: options.accept,
    failed: options.failed,
  });
}

/** Gateway-owned event journal bound to one ordinary or direct-subagent Session address. */
export class SessionEventStream extends RemoteJournalStream<
  SessionJournalPage,
  SessionHistoryRecord,
  number,
  ClientSessionPageRequest,
  SessionJournalNotification
> {
  private journal:
    | {
        epoch: string;
        cursor: number;
        records: SessionHistoryRecord[];
        hasMore: boolean;
      }
    | undefined;
  private epoch: string | undefined;

  /** Confirmed durable window, including settlements not yet visible to the assembler. */
  capture(): SessionJournalCache | undefined {
    return this.journal && { ...this.journal, records: [...this.journal.records] };
  }

  get journalEpoch(): string | undefined {
    return this.epoch;
  }

  /**
   * @param remote - generated Session namespace and Gateway stream factory.
   * @param address - durable ordinary-Session or direct-subagent address.
   * @param options - Session event-window destinations.
   */
  constructor(
    private readonly remote: SessionRemotes,
    private readonly address: SessionAddress,
    options: SessionEventStreamOptions,
    cached?: SessionJournalCache,
  ) {
    super(remote, {
      name: "session event stream",
      emptyCursor: -1,
      entries: (page) => page.records,
      hasMore: (page) => page.hasMore,
      first: historyRecordFirstSeq,
      last: historyRecordLastSeq,
      compare: (left, right) => left - right,
      follows: (left, right) => right === left + 1,
      publish: (change) => {
        if (this.epoch !== undefined) {
          if (change.type === "replace") {
            this.journal = {
              epoch: this.epoch,
              cursor: change.entries.at(-1)?.event.seq ?? -1,
              records: [...change.entries],
              hasMore: change.hasMore,
            };
          } else if (this.journal !== undefined && change.type === "append") {
            this.journal.cursor = change.entry.event.seq;
            this.journal.records.push(change.entry);
          } else if (this.journal !== undefined && change.type === "prepend") {
            this.journal.records.unshift(...change.entries);
            this.journal.hasMore = change.hasMore;
          }
        } else this.journal = undefined;
        options.publish(toSessionJournalChange(change));
      },
      ...(options.carrierFailed === undefined ? {} : { carrierFailed: options.carrierFailed }),
      failed: options.failed,
    });
    this.journal = cached && { ...cached, records: [...cached.records] };
    this.epoch = cached?.epoch;
  }

  /** @inheritdoc */
  protected override async *follow(
    request: ClientSessionPageRequest,
    signal: AbortSignal,
  ): AsyncIterable<
    RemoteJournalFrame<SessionHistoryRecord, number, SessionJournalPage, SessionJournalNotification>
  > {
    let assistantRevision: number | undefined;
    const cached = this.journal;
    for await (const frame of this.remote.session.follow(
      {
        address: this.address,
        assistantStream: true,
        ...this.repairRequest(request),
        ...(cached === undefined ? {} : { resume: { epoch: cached.epoch, cursor: cached.cursor } }),
      },
      signal,
    )) {
      if (frame.type === "snapshot") {
        for (const record of frame.records) assertSessionWireEvent(record.event);
        if (frame.assistantStream === undefined) {
          throw new RemoteError(
            "gateway/internal",
            "session assistant stream omitted its opted-in opening baseline",
            {},
          );
        }
        let records = frame.records;
        let hasMore = frame.hasMore;
        if (frame.resumedAfter !== undefined) {
          if (
            cached === undefined ||
            frame.epoch !== cached.epoch ||
            frame.resumedAfter !== cached.cursor ||
            frame.cursor !== (records.at(-1)?.event.seq ?? cached.cursor) ||
            (records.length > 0 && records[0]?.event.seq !== cached.cursor + 1)
          ) {
            throw new RemoteError("gateway/internal", "Invalid session resume baseline", {});
          }
          records = [...cached.records, ...records];
          hasMore = cached.hasMore;
        }
        const reset = frame.epoch !== undefined && frame.epoch !== this.epoch;
        this.epoch = frame.epoch;
        assistantRevision = frame.assistantStream.revision;
        yield {
          type: "opened",
          ...(reset ? { reset: true } : {}),
          cursor: frame.cursor,
          page: {
            records,
            hasMore,
            projections: frame.projections,
            assistantStream: frame.assistantStream,
          },
        };
        continue;
      }
      if (frame.type === "assistant-stream") {
        const expected = (assistantRevision ?? 0) + 1;
        if (frame.frame.revision !== expected) {
          throw new RemoteStreamCarrierError(
            `session assistant stream skipped revision ${String(expected)}`,
          );
        }
        assistantRevision = frame.frame.revision;
        yield { type: "notification", notification: frame };
        continue;
      }
      if (frame.type === "projection") {
        yield { type: "notification", notification: frame };
        continue;
      }
      assertSessionWireEvent(frame.event);
      yield { type: "entry", entry: frame };
    }
  }

  /** @inheritdoc */
  protected override async readPage(
    request: ClientSessionPageRequest,
    throughSeq: number,
    signal: AbortSignal,
  ): Promise<SessionJournalPage> {
    const result = await this.remote.session.page(
      { address: this.address, throughSeq, ...request },
      signal,
    );
    if (!result.ok) throw result.error;
    for (const record of result.value.records) assertSessionWireEvent(record.event);
    return result.value;
  }

  /** @inheritdoc */
  protected override repairRequest(request: ClientSessionPageRequest): ClientSessionPageRequest {
    return {
      ...(request.maxMessages === undefined ? {} : { maxMessages: request.maxMessages }),
      ...(request.turnWindow === undefined ? {} : { turnWindow: request.turnWindow }),
    };
  }
}
