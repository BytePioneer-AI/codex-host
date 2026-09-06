import { isDeepStrictEqual } from "node:util";

import { ModernRemoteConnectionError } from "./remote-connection.js";
import {
  redactModernCredential,
  sanitizeModernRemoteFailure,
  type ModernRemoteResult,
} from "./wire.js";

export type ModernApprovalOutcome = "allowed-once" | "rejected" | "cancelled" | "unavailable";

export interface ModernApprovalRequest {
  readonly toolName: string;
  readonly callId?: string;
  readonly reason?: string;
}

export interface ModernQuestionOption {
  readonly label: string;
  readonly description?: string;
}

export interface ModernQuestionIntent {
  readonly kind: "plan-review";
  readonly approve: string;
}

export interface ModernQuestionItem {
  readonly id: string;
  readonly question: string;
  readonly detail?: string;
  readonly header?: string;
  readonly options?: readonly ModernQuestionOption[];
  readonly multiSelect?: boolean;
  readonly intent?: ModernQuestionIntent;
}

export interface ModernQuestionRequest {
  readonly questions: readonly ModernQuestionItem[];
}

export interface ModernQuestionAnswerItem {
  readonly id: string;
  readonly selected: readonly string[];
  readonly custom?: string;
}

export interface ModernQuestionAnswer {
  readonly answers: readonly ModernQuestionAnswerItem[];
}

interface ModernEventDeliveryBase {
  readonly eventId: string;
  readonly sessionId: string;
}

export interface ModernApprovalDelivery extends ModernEventDeliveryBase {
  readonly type: "approval";
  readonly request: ModernApprovalRequest;
  respond(outcome: ModernApprovalOutcome): Promise<void>;
}

export interface ModernQuestionDelivery extends ModernEventDeliveryBase {
  readonly type: "question";
  readonly request: ModernQuestionRequest;
  respond(answer: ModernQuestionAnswer): Promise<void>;
  reject(): Promise<void>;
}

export type ModernEventDelivery = ModernApprovalDelivery | ModernQuestionDelivery;

export interface ModernEventSink {
  onDelivery(delivery: ModernEventDelivery): void;
  onCancel(eventId: string): void;
  /** Best-effort `session/cancel`, invoked before an unrecoverable fault is published. */
  cancelNative(): void | Promise<void>;
  onFault(error: ModernEventGatewayError): void;
}

export interface ModernEventRemote {
  call<T>(
    endpoint: string,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<ModernRemoteResult<T>>;
  openStream<T>(
    endpoint: string,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): AsyncIterable<T>;
}

export type ModernEventGatewayErrorCode =
  "closed" | "protocolError" | "remoteError" | "resourceLimit" | "unavailable";

export class ModernEventGatewayError extends Error {
  readonly nativeCode?: string;

  constructor(
    readonly code: ModernEventGatewayErrorCode,
    message: string,
    nativeCode?: string,
  ) {
    super(redactModernCredential(message));
    this.name = "ModernEventGatewayError";
    if (nativeCode !== undefined) this.nativeCode = redactModernCredential(nativeCode);
  }
}

export interface ModernEventGatewayOptions {
  readonly maxSinks?: number;
  readonly maxPendingEvents?: number;
  readonly maxRetiredEvents?: number;
  readonly onGenerationLost?: (error: ModernEventGatewayError) => void;
  readonly onFailureDeclared?: (error: ModernEventGatewayError) => void;
  readonly onFault?: (error: ModernEventGatewayError) => void;
}

interface ResolvedOptions {
  readonly maxSinks: number;
  readonly maxPendingEvents: number;
  readonly maxRetiredEvents: number;
  readonly onGenerationLost?: (error: ModernEventGatewayError) => void;
  readonly onFailureDeclared?: (error: ModernEventGatewayError) => void;
  readonly onFault?: (error: ModernEventGatewayError) => void;
}

type RemoteEventOutcome =
  | { readonly kind: "next" }
  | { readonly kind: "result"; readonly value: unknown }
  | {
      readonly kind: "rejected";
      readonly error: { readonly name: string; readonly message: string; readonly code?: string };
    };

type ParsedWaterfall = {
  readonly type: "waterfall";
  readonly event: string;
  readonly eventId: string;
  readonly agentId: string;
  readonly request: Readonly<Record<string, unknown>>;
};

type ParsedFrame =
  | { readonly type: "emit" }
  | { readonly type: "cancel"; readonly eventId: string }
  | ParsedWaterfall;

interface PendingEvent {
  readonly event: "approval/request" | "user-questions/request";
  readonly eventId: string;
  readonly sessionId: string;
  readonly request: ModernApprovalRequest | ModernQuestionRequest;
  readonly sink: ModernEventSink;
  clientId: string | undefined;
  invalidated?: ModernEventGatewayError;
  desired?: RemoteEventOutcome;
  response?: Promise<void>;
  resolveResponse?: () => void;
  rejectResponse?: (error: Error) => void;
  released: boolean;
  sendStarted: boolean;
  settlement?: Promise<void>;
}

interface RetiredEvent {
  readonly kind: "claimed" | "next";
  clientId: string | undefined;
}

interface EventGeneration {
  readonly clientId: string;
  readonly controller: AbortController;
  readonly iterator: AsyncIterator<unknown>;
  readonly returnStream: () => Promise<void>;
  pump?: Promise<void>;
}

interface OpeningGeneration {
  readonly controller: AbortController;
  readonly returnStream: () => Promise<void>;
}

const APPROVAL_EVENT = "approval/request";
const QUESTION_EVENT = "user-questions/request";
const DEFAULT_MAX_SINKS = 1_024;
const DEFAULT_MAX_PENDING_EVENTS = 4_096;
const DEFAULT_MAX_RETIRED_EVENTS = 8_192;
const EVENT_READY_TIMEOUT_MS = 10_000;
const MAX_COLLECTION_ITEMS = 4_096;
const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 100_000;
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const MAX_ID_LENGTH = 1_024;
const MAX_EVENT_NAME_LENGTH = 256;
const MAX_STRING_LENGTH = 256 * 1024;
const NATIVE_CANCEL_WAIT_MS = 1_000;
const QUESTION_CANCELLED = {
  kind: "rejected",
  error: {
    name: "UserQuestionError",
    code: "ASK_CANCELLED",
    message: "The user cancelled the DeepSeek Harness question",
  },
} as const satisfies RemoteEventOutcome;
const MALFORMED_APPROVAL = {
  kind: "rejected",
  error: {
    name: "TypeError",
    code: "DSH_EVENT_INVALID",
    message: "DeepSeek Harness sent an invalid approval request",
  },
} as const satisfies RemoteEventOutcome;
const MALFORMED_QUESTION = {
  kind: "rejected",
  error: {
    name: "TypeError",
    code: "DSH_EVENT_INVALID",
    message: "DeepSeek Harness sent an invalid user question request",
  },
} as const satisfies RemoteEventOutcome;

/** Adapter-owned Modern waterfall gateway. One instance serves every loaded Modern Session. */
export class ModernEventGateway {
  readonly #lifetime = new AbortController();
  readonly #options: ResolvedOptions;
  readonly #pending = new Map<string, PendingEvent>();
  readonly #remote: ModernEventRemote;
  readonly #retired = new Map<string, RetiredEvent>();
  readonly #sinks = new Map<string, ModernEventSink>();
  readonly #sinkCancellations = new WeakMap<ModernEventSink, Promise<void>>();
  #closePromise: Promise<void> | undefined;
  #closing = false;
  #failPromise: Promise<void> | undefined;
  #fault: ModernEventGatewayError | undefined;
  #generation: EventGeneration | undefined;
  #hostHome: string | undefined;
  #opening: OpeningGeneration | undefined;
  #startPromise: Promise<void> | undefined;
  #transition: Promise<void> = Promise.resolve();

  constructor(remote: ModernEventRemote, options: ModernEventGatewayOptions = {}) {
    this.#remote = remote;
    this.#options = {
      maxSinks: positiveInteger(options.maxSinks ?? DEFAULT_MAX_SINKS, "maxSinks"),
      maxPendingEvents: positiveInteger(
        options.maxPendingEvents ?? DEFAULT_MAX_PENDING_EVENTS,
        "maxPendingEvents",
      ),
      maxRetiredEvents: positiveInteger(
        options.maxRetiredEvents ?? DEFAULT_MAX_RETIRED_EVENTS,
        "maxRetiredEvents",
      ),
      ...(options.onGenerationLost ? { onGenerationLost: options.onGenerationLost } : {}),
      ...(options.onFailureDeclared ? { onFailureDeclared: options.onFailureDeclared } : {}),
      ...(options.onFault ? { onFault: options.onFault } : {}),
    };
  }

  /** Attach one loaded Session. The returned disposer detaches only this exact sink. */
  attach(sessionId: string, sink: ModernEventSink): () => Promise<void> {
    this.#assertUsable();
    assertIdentifier(sessionId, "sessionId");
    if (this.#sinks.has(sessionId)) {
      throw new TypeError("A DeepSeek Harness event sink is already attached for this Session");
    }
    if (this.#sinks.size >= this.#options.maxSinks) {
      throw gatewayError("resourceLimit", "DeepSeek Harness event sink limit was exceeded");
    }
    this.#sinks.set(sessionId, sink);
    let disposed = false;
    return async () => {
      if (disposed) return;
      disposed = true;
      await this.detach(sessionId, sink);
    };
  }

  /** Release every current delivery to the next DSH Client before detaching a Session. */
  async detach(sessionId: string, expectedSink?: ModernEventSink): Promise<void> {
    const sink = this.#sinks.get(sessionId);
    if (!sink || (expectedSink && sink !== expectedSink)) return;
    this.#sinks.delete(sessionId);
    const released = [...this.#pending.values()].filter(
      (pending) => pending.sessionId === sessionId,
    );
    const tasks: Promise<void>[] = [];
    for (const pending of released) {
      pending.released = true;
      pending.resolveResponse?.();
      if (!pending.sendStarted) {
        pending.desired = { kind: "next" };
        this.#beginSettlement(pending);
      }
      if (pending.settlement) tasks.push(pending.settlement.catch(() => undefined));
    }
    await Promise.all(tasks);
    for (const pending of released) this.#notifyCancel(pending.sink, pending.eventId);
  }

  /** Establish the first `$events` generation. */
  start(): Promise<void> {
    if (this.#generation) return Promise.resolve();
    if (this.#startPromise) return this.#startPromise;
    const starting = this.replace();
    this.#startPromise = starting;
    void starting.then(
      () => {
        if (this.#startPromise === starting) this.#startPromise = undefined;
      },
      () => {
        if (this.#startPromise === starting) this.#startPromise = undefined;
      },
    );
    return starting;
  }

  /** Replace a lost generation. Pending eventIds remain bound to their existing local delivery. */
  replace(): Promise<void> {
    const replacement = this.#transition
      .then(() => this.#replaceGeneration())
      .catch(async (error: unknown) => {
        const failure = normalizeError(
          error,
          "DeepSeek Harness event generation replacement failed",
        );
        if (failure.code === "protocolError" || failure.code === "resourceLimit") {
          await this.fail(failure);
        }
        throw failure;
      });
    this.#transition = replacement.catch(() => undefined);
    return replacement;
  }

  /** Declare recovery exhausted: cancel native Sessions best-effort, then fault their sinks. */
  fail(reason: unknown): Promise<void> {
    const error = normalizeError(reason, "DeepSeek Harness event gateway failed");
    if (this.#failPromise) return this.#failPromise;
    if (this.#closing) return Promise.resolve();
    this.#fault = error;
    try {
      this.#options.onFailureDeclared?.(error);
    } catch {
      // Adapter admission bookkeeping cannot delay native cancellation.
    }
    this.#failPromise = this.#failAll(error);
    return this.#failPromise;
  }

  /** Delegate current deliveries, end the stream, and detach every sink. */
  close(): Promise<void> {
    this.#closePromise ??= this.#performClose();
    return this.#closePromise;
  }

  async #replaceGeneration(): Promise<void> {
    this.#assertUsable();
    const previous = this.#generation;
    if (previous) {
      this.#retireGeneration(previous);
      previous.controller.abort();
      await Promise.allSettled([previous.returnStream(), previous.pump]);
    }
    this.#assertUsable();
    const controller = new AbortController();
    const signal = AbortSignal.any([this.#lifetime.signal, controller.signal]);
    let iterator: AsyncIterator<unknown>;
    try {
      iterator = this.#remote.openStream<unknown>("$events", {}, signal)[Symbol.asyncIterator]();
    } catch (error) {
      throw normalizeError(error, "DeepSeek Harness event stream could not open");
    }
    const returnStream = onceAsync(async () => {
      await iterator.return?.();
    });
    const openingGeneration = { controller, returnStream };
    this.#opening = openingGeneration;
    let opening: { readonly clientId: string; readonly home: string };
    let readyTimer: NodeJS.Timeout | undefined;
    let removeOpeningAbort = (): void => undefined;
    try {
      const firstItem = iterator.next();
      const interrupted = new Promise<never>((_resolve, reject) => {
        const onAbort = (): void => {
          try {
            this.#assertUsable();
          } catch (error) {
            reject(error);
            return;
          }
          reject(
            gatewayError("unavailable", "DeepSeek Harness event stream opening was interrupted"),
          );
        };
        signal.addEventListener("abort", onAbort, { once: true });
        removeOpeningAbort = () => signal.removeEventListener("abort", onAbort);
        if (signal.aborted) onAbort();
      });
      const timedOut = new Promise<never>((_resolve, reject) => {
        readyTimer = setTimeout(() => {
          reject(
            gatewayError(
              "unavailable",
              "DeepSeek Harness event stream did not become ready in time",
            ),
          );
          controller.abort();
        }, EVENT_READY_TIMEOUT_MS);
      });
      const first = await Promise.race([firstItem, interrupted, timedOut]);
      if (first.done)
        throw gatewayError("unavailable", "DeepSeek Harness event stream ended before ready");
      opening = parseReady(first.value);
      if (this.#hostHome !== undefined && opening.home !== this.#hostHome) {
        throw gatewayError("protocolError", "DeepSeek Harness replacement changed its Host home");
      }
      this.#assertUsable();
    } catch (error) {
      controller.abort();
      await Promise.allSettled([returnStream()]);
      throw normalizeError(error, "DeepSeek Harness event stream did not become ready");
    } finally {
      removeOpeningAbort();
      if (readyTimer) clearTimeout(readyTimer);
      if (this.#opening === openingGeneration) this.#opening = undefined;
    }
    const generation: EventGeneration = {
      clientId: opening.clientId,
      controller,
      iterator,
      returnStream,
    };
    this.#hostHome ??= opening.home;
    this.#generation = generation;
    generation.pump = this.#pump(generation);
  }

  async #pump(generation: EventGeneration): Promise<void> {
    let failure: ModernEventGatewayError | undefined;
    try {
      while (!generation.controller.signal.aborted && !this.#closing && !this.#fault) {
        const item = await generation.iterator.next();
        if (item.done) {
          throw gatewayError("unavailable", "DeepSeek Harness event stream ended unexpectedly");
        }
        await this.#handleFrame(item.value, generation);
      }
    } catch (error) {
      if (!generation.controller.signal.aborted && !this.#closing && !this.#fault) {
        failure = normalizeError(error, "DeepSeek Harness event stream failed");
      }
    } finally {
      this.#retireGeneration(generation);
      generation.controller.abort();
      await Promise.allSettled([generation.returnStream()]);
    }
    if (!failure) return;
    if (failure.code === "protocolError" || failure.code === "resourceLimit") {
      await this.fail(failure);
      return;
    }
    this.#reportGenerationLost(failure);
  }

  async #handleFrame(value: unknown, generation: EventGeneration): Promise<void> {
    const attached = attachedKnownInvocation(value, this.#sinks);
    if (attached) {
      let frame: ParsedWaterfall;
      let request: ModernApprovalRequest | ModernQuestionRequest;
      try {
        frame = parseWaterfall(value);
        request =
          frame.event === APPROVAL_EVENT
            ? parseApprovalRequest(frame.request)
            : parseQuestionRequest(frame.request);
      } catch {
        await this.#rejectMalformed(attached, generation);
        return;
      }
      await this.#claim(frame, request, generation);
      return;
    }

    const frame = parseFrame(value);
    if (frame.type === "emit") return;
    if (frame.type === "cancel") {
      this.#cancel(frame.eventId);
      return;
    }
    await this.#delegate(frame.eventId, generation.clientId);
  }

  async #claim(
    frame: ParsedWaterfall,
    request: ModernApprovalRequest | ModernQuestionRequest,
    generation: EventGeneration,
  ): Promise<void> {
    const existing = this.#pending.get(frame.eventId);
    if (existing) {
      if (
        existing.event !== frame.event ||
        existing.sessionId !== frame.agentId ||
        !isDeepStrictEqual(existing.request, request)
      ) {
        throw gatewayError("protocolError", "DeepSeek Harness replay changed a pending event");
      }
      existing.clientId = generation.clientId;
      if (existing.desired && !existing.sendStarted) this.#beginSettlement(existing);
      return;
    }

    const retired = this.#retired.get(frame.eventId);
    if (retired) {
      if (retired.kind === "next" && retired.clientId !== generation.clientId) {
        await this.#delegate(frame.eventId, generation.clientId);
      }
      return;
    }
    if (this.#pending.size >= this.#options.maxPendingEvents) {
      throw gatewayError("resourceLimit", "DeepSeek Harness pending event limit was exceeded");
    }
    const sink = this.#sinks.get(frame.agentId);
    if (!sink) {
      await this.#delegate(frame.eventId, generation.clientId);
      return;
    }
    const pending: PendingEvent = {
      event: frame.event as PendingEvent["event"],
      eventId: frame.eventId,
      sessionId: frame.agentId,
      request,
      sink,
      clientId: generation.clientId,
      released: false,
      sendStarted: false,
    };
    this.#pending.set(frame.eventId, pending);
    const delivery = this.#delivery(pending);
    try {
      sink.onDelivery(delivery);
    } catch {
      this.#pending.delete(frame.eventId);
      if (pending.sendStarted) {
        this.#rememberRetired(frame.eventId, {
          kind: "claimed",
          clientId: generation.clientId,
        });
      } else {
        this.#rememberRetired(frame.eventId, {
          kind: "next",
          clientId: generation.clientId,
        });
        await this.#sendResult(generation.clientId, frame.eventId, { kind: "next" }).catch(
          () => undefined,
        );
      }
      await this.#faultSink(
        frame.agentId,
        gatewayError("unavailable", "DeepSeek Harness event sink rejected a delivery"),
      );
    }
  }

  #delivery(pending: PendingEvent): ModernEventDelivery {
    if (pending.event === APPROVAL_EVENT) {
      return {
        type: "approval",
        eventId: pending.eventId,
        sessionId: pending.sessionId,
        request: pending.request as ModernApprovalRequest,
        respond: (outcome) => {
          if (!isApprovalOutcome(outcome)) {
            return Promise.reject(new TypeError("Invalid DeepSeek Harness approval outcome"));
          }
          return this.#respond(pending, { kind: "result", value: outcome });
        },
      };
    }
    return {
      type: "question",
      eventId: pending.eventId,
      sessionId: pending.sessionId,
      request: pending.request as ModernQuestionRequest,
      respond: (answer) => {
        try {
          return this.#respond(pending, {
            kind: "result",
            value: parseQuestionAnswer(answer),
          });
        } catch (error) {
          return Promise.reject(error);
        }
      },
      reject: () => this.#respond(pending, QUESTION_CANCELLED),
    };
  }

  #respond(pending: PendingEvent, outcome: RemoteEventOutcome): Promise<void> {
    if (pending.invalidated) return Promise.reject(pending.invalidated);
    if (this.#pending.get(pending.eventId) !== pending || pending.released) {
      return Promise.resolve();
    }
    if (pending.response) return pending.response;
    const deferred = Promise.withResolvers<undefined>();
    pending.response = deferred.promise;
    pending.resolveResponse = () => deferred.resolve(undefined);
    pending.rejectResponse = deferred.reject;
    pending.desired = outcome;
    if (pending.clientId !== undefined) this.#beginSettlement(pending);
    return pending.response;
  }

  #beginSettlement(pending: PendingEvent): Promise<void> | undefined {
    if (pending.sendStarted || !pending.desired || pending.clientId === undefined) return undefined;
    pending.sendStarted = true;
    const clientId = pending.clientId;
    const outcome = pending.desired;
    const settlement = this.#sendResult(clientId, pending.eventId, outcome).then(
      () => {
        if (this.#pending.get(pending.eventId) === pending) {
          this.#pending.delete(pending.eventId);
          this.#rememberRetired(pending.eventId, {
            kind: outcome.kind === "next" ? "next" : "claimed",
            clientId,
          });
        }
        pending.resolveResponse?.();
      },
      async (error: unknown) => {
        const failure = normalizeError(error, "DeepSeek Harness event result failed");
        if (this.#pending.get(pending.eventId) === pending) {
          if (failure.code === "unavailable" || failure.code === "remoteError") {
            pending.sendStarted = false;
            if (pending.released) pending.desired = { kind: "next" };
            if (pending.clientId === clientId) {
              const generation = this.#generation;
              if (this.#closing && pending.released) {
                if (outcome.kind !== "next") {
                  return this.#beginSettlement(pending);
                }
                this.#pending.delete(pending.eventId);
              } else if (generation?.clientId === clientId) {
                this.#loseGeneration(generation, failure);
              } else {
                pending.clientId = undefined;
              }
            } else if (pending.clientId !== undefined) {
              return this.#beginSettlement(pending);
            } else if (this.#closing && pending.released) {
              this.#pending.delete(pending.eventId);
            }
            return;
          }
          pending.invalidated = failure;
          this.#pending.delete(pending.eventId);
          this.#rememberRetired(pending.eventId, { kind: "claimed", clientId });
          if (pending.released) await this.#cancelSinkOnce(pending.sink);
          else await this.#faultSink(pending.sessionId, failure);
        }
        pending.rejectResponse?.(failure);
      },
    );
    pending.settlement = settlement;
    void settlement.catch(() => undefined);
    return settlement;
  }

  async #delegate(eventId: string, clientId: string): Promise<void> {
    const previous = this.#retired.get(eventId);
    if (previous?.kind === "claimed" || previous?.clientId === clientId) return;
    this.#rememberRetired(eventId, { kind: "next", clientId });
    await this.#sendResult(clientId, eventId, { kind: "next" });
  }

  #cancel(eventId: string): void {
    const pending = this.#pending.get(eventId);
    if (!pending) return;
    this.#pending.delete(eventId);
    this.#rememberRetired(eventId, { kind: "claimed", clientId: pending.clientId });
    pending.resolveResponse?.();
    if (!pending.released) this.#notifyCancel(pending.sink, eventId);
  }

  async #rejectMalformed(
    identity: {
      readonly event: "approval/request" | "user-questions/request";
      readonly eventId: string;
      readonly agentId: string;
    },
    generation: EventGeneration,
  ): Promise<void> {
    await this.#sendResult(
      generation.clientId,
      identity.eventId,
      malformedOutcome(identity.event),
    ).catch(() => undefined);
    this.#rememberRetired(identity.eventId, {
      kind: "claimed",
      clientId: generation.clientId,
    });
    await this.#faultSink(
      identity.agentId,
      gatewayError("protocolError", malformedOutcome(identity.event).error.message),
    );
  }

  async #sendResult(clientId: string, eventId: string, outcome: RemoteEventOutcome): Promise<void> {
    let result: ModernRemoteResult<unknown>;
    try {
      result = await this.#remote.call<unknown>(
        "$events/result",
        { clientId, eventId, outcome },
        this.#lifetime.signal,
      );
    } catch (error) {
      throw normalizeError(error, "DeepSeek Harness event result transport failed");
    }
    if (result.ok) {
      if (result.value !== undefined) {
        throw gatewayError(
          "protocolError",
          "DeepSeek Harness event result returned an unexpected value",
        );
      }
      return;
    }
    const failure = sanitizeModernRemoteFailure(result.error);
    throw new ModernEventGatewayError("remoteError", failure.message, failure.code);
  }

  async #faultSink(sessionId: string, error: ModernEventGatewayError): Promise<void> {
    const sink = this.#sinks.get(sessionId);
    if (!sink) return;
    this.#sinks.delete(sessionId);
    for (const pending of [...this.#pending.values()]) {
      if (pending.sessionId !== sessionId) continue;
      pending.invalidated = error;
      this.#pending.delete(pending.eventId);
      this.#rememberRetired(pending.eventId, { kind: "claimed", clientId: pending.clientId });
      pending.rejectResponse?.(error);
    }
    await this.#cancelSinkOnce(sink);
    try {
      sink.onFault(error);
    } catch {
      // A Session fault observer cannot affect other Sessions.
    }
  }

  async #failAll(error: ModernEventGatewayError): Promise<void> {
    const opening = this.#opening;
    opening?.controller.abort();
    const openingReturn = opening?.returnStream();
    const generation = this.#generation;
    if (generation) {
      this.#retireGeneration(generation);
      generation.controller.abort();
    }
    this.#lifetime.abort(error);
    const sinks = [...this.#sinks.entries()];
    const cancellationSinks = new Map(sinks);
    this.#sinks.clear();
    for (const pending of this.#pending.values()) {
      pending.invalidated = error;
      this.#rememberRetired(pending.eventId, { kind: "claimed", clientId: pending.clientId });
      pending.rejectResponse?.(error);
      if (!cancellationSinks.has(pending.sessionId)) {
        cancellationSinks.set(pending.sessionId, pending.sink);
      }
    }
    this.#pending.clear();
    await Promise.all([
      ...[...cancellationSinks.values()].map((sink) => this.#cancelSinkOnce(sink)),
      ...(openingReturn ? [openingReturn.catch(() => undefined)] : []),
    ]);
    for (const [, sink] of sinks) {
      try {
        sink.onFault(error);
      } catch {
        // Fault delivery is isolated per Session.
      }
    }
    try {
      this.#options.onFault?.(error);
    } catch {
      // Adapter fault bookkeeping cannot affect completed Session convergence.
    }
  }

  async #performClose(): Promise<void> {
    if (this.#closing) return;
    this.#closing = true;
    await Promise.all(
      [...this.#sinks].map(async ([sessionId, sink]) => this.detach(sessionId, sink)),
    );
    await Promise.allSettled(
      [...this.#pending.values()].flatMap((pending) =>
        pending.settlement ? [pending.settlement] : [],
      ),
    );
    const opening = this.#opening;
    opening?.controller.abort();
    const generation = this.#generation;
    if (generation) this.#retireGeneration(generation);
    generation?.controller.abort();
    this.#lifetime.abort();
    await Promise.allSettled([
      opening?.returnStream(),
      generation?.returnStream(),
      generation?.pump,
      this.#transition,
    ]);
    const lateGeneration = this.#generation;
    if (lateGeneration) {
      this.#retireGeneration(lateGeneration);
      lateGeneration.controller.abort();
      await Promise.allSettled([lateGeneration.returnStream(), lateGeneration.pump]);
    }
    for (const pending of this.#pending.values()) pending.resolveResponse?.();
    this.#pending.clear();
  }

  #loseGeneration(generation: EventGeneration, error: ModernEventGatewayError): void {
    if (this.#generation !== generation || this.#closing || this.#fault) return;
    this.#retireGeneration(generation);
    generation.controller.abort();
    void Promise.allSettled([generation.returnStream(), generation.pump]).then(() => {
      this.#reportGenerationLost(error);
    });
  }

  #retireGeneration(generation: EventGeneration): void {
    if (this.#generation !== generation) return;
    this.#generation = undefined;
    for (const pending of this.#pending.values()) {
      if (pending.clientId === generation.clientId) pending.clientId = undefined;
    }
  }

  #rememberRetired(eventId: string, event: RetiredEvent): void {
    this.#retired.delete(eventId);
    this.#retired.set(eventId, event);
    while (this.#retired.size > this.#options.maxRetiredEvents) {
      const oldest = this.#retired.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#retired.delete(oldest);
    }
  }

  #notifyCancel(sink: ModernEventSink, eventId: string): void {
    try {
      sink.onCancel(eventId);
    } catch {
      // Cancellation is already authoritative on the wire.
    }
  }

  #cancelSinkOnce(sink: ModernEventSink): Promise<void> {
    let cancellation = this.#sinkCancellations.get(sink);
    if (!cancellation) {
      cancellation = bestEffortCancel(sink);
      this.#sinkCancellations.set(sink, cancellation);
    }
    return cancellation;
  }

  #reportGenerationLost(error: ModernEventGatewayError): void {
    if (this.#closing || this.#fault) return;
    try {
      this.#options.onGenerationLost?.(error);
    } catch {
      // The Adapter's recovery observer cannot corrupt retained interactions.
    }
  }

  #assertUsable(): void {
    if (this.#fault) throw this.#fault;
    if (this.#closing) throw gatewayError("closed", "DeepSeek Harness event gateway is closed");
  }
}

function parseReady(value: unknown): { readonly clientId: string; readonly home: string } {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ["type", "clientId", "host"]) ||
    value.type !== "ready" ||
    !validIdentifier(value.clientId) ||
    !isPlainRecord(value.host) ||
    !hasExactKeys(value.host, ["home"]) ||
    !boundedString(value.host.home)
  ) {
    throw gatewayError("protocolError", "DeepSeek Harness event stream did not begin with ready");
  }
  return { clientId: value.clientId, home: value.host.home };
}

function parseFrame(value: unknown): ParsedFrame {
  if (!isPlainRecord(value)) throw invalidFrame();
  if (
    value.type === "cancel" &&
    hasExactKeys(value, ["type", "eventId"]) &&
    validIdentifier(value.eventId)
  ) {
    return { type: "cancel", eventId: value.eventId };
  }
  if (
    value.type === "emit" &&
    hasExactKeys(value, ["type", "event", "args"]) &&
    validEventName(value.event) &&
    Array.isArray(value.args)
  ) {
    assertBoundedJson(value.args);
    return { type: "emit" };
  }
  if (value.type === "waterfall") return parseWaterfall(value);
  throw invalidFrame();
}

function parseWaterfall(value: unknown): ParsedWaterfall {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ["type", "event", "eventId", "agentId", "request"]) ||
    value.type !== "waterfall" ||
    !validEventName(value.event) ||
    !validIdentifier(value.eventId) ||
    !validIdentifier(value.agentId) ||
    !isPlainRecord(value.request) ||
    Object.hasOwn(value.request, "agent") ||
    Object.hasOwn(value.request, "signal")
  ) {
    throw invalidFrame();
  }
  assertBoundedJson(value.request);
  return {
    type: "waterfall",
    event: value.event,
    eventId: value.eventId,
    agentId: value.agentId,
    request: value.request,
  };
}

function attachedKnownInvocation(
  value: unknown,
  sinks: ReadonlyMap<string, ModernEventSink>,
):
  | {
      readonly event: "approval/request" | "user-questions/request";
      readonly eventId: string;
      readonly agentId: string;
    }
  | undefined {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ["type", "event", "eventId", "agentId", "request"]) ||
    value.type !== "waterfall" ||
    (value.event !== APPROVAL_EVENT && value.event !== QUESTION_EVENT) ||
    !validIdentifier(value.eventId) ||
    !validIdentifier(value.agentId) ||
    !sinks.has(value.agentId)
  ) {
    return undefined;
  }
  return { event: value.event, eventId: value.eventId, agentId: value.agentId };
}

function parseApprovalRequest(value: Readonly<Record<string, unknown>>): ModernApprovalRequest {
  if (
    !hasOnlyKeys(value, ["toolName"], ["callId", "reason"]) ||
    !nonBlankString(value.toolName) ||
    (Object.hasOwn(value, "callId") && !nonBlankString(value.callId)) ||
    (Object.hasOwn(value, "reason") && !boundedString(value.reason))
  ) {
    throw invalidFrame();
  }
  return {
    toolName: value.toolName,
    ...(typeof value.callId === "string" ? { callId: value.callId } : {}),
    ...(typeof value.reason === "string" ? { reason: value.reason } : {}),
  };
}

function parseQuestionRequest(value: Readonly<Record<string, unknown>>): ModernQuestionRequest {
  if (!hasExactKeys(value, ["questions"]) || !Array.isArray(value.questions)) {
    throw invalidFrame();
  }
  assertCollection(value.questions);
  if (value.questions.length === 0) throw invalidFrame();
  const questions = value.questions.map(parseQuestionItem);
  if (new Set(questions.map(({ id }) => id)).size !== questions.length) throw invalidFrame();
  return { questions };
}

function parseQuestionItem(value: unknown): ModernQuestionItem {
  if (
    !isPlainRecord(value) ||
    !hasOnlyKeys(
      value,
      ["id", "question"],
      ["detail", "header", "options", "multiSelect", "intent"],
    ) ||
    !nonBlankString(value.id) ||
    !nonBlankString(value.question) ||
    (Object.hasOwn(value, "detail") && !boundedString(value.detail)) ||
    (Object.hasOwn(value, "header") && !boundedString(value.header)) ||
    (Object.hasOwn(value, "multiSelect") && typeof value.multiSelect !== "boolean")
  ) {
    throw invalidFrame();
  }
  let options: readonly ModernQuestionOption[] | undefined;
  if (Object.hasOwn(value, "options")) {
    if (!Array.isArray(value.options)) throw invalidFrame();
    assertCollection(value.options);
    options = value.options.map(parseQuestionOption);
    if (new Set(options.map(({ label }) => label)).size !== options.length) throw invalidFrame();
  }
  let intent: ModernQuestionIntent | undefined;
  if (Object.hasOwn(value, "intent")) intent = parseQuestionIntent(value.intent);
  if (
    intent &&
    (typeof value.detail !== "string" || !options?.some(({ label }) => label === intent.approve))
  ) {
    throw invalidFrame();
  }
  return {
    id: value.id,
    question: value.question,
    ...(typeof value.detail === "string" ? { detail: value.detail } : {}),
    ...(typeof value.header === "string" ? { header: value.header } : {}),
    ...(options ? { options } : {}),
    ...(typeof value.multiSelect === "boolean" ? { multiSelect: value.multiSelect } : {}),
    ...(intent ? { intent } : {}),
  };
}

function parseQuestionOption(value: unknown): ModernQuestionOption {
  if (
    !isPlainRecord(value) ||
    !hasOnlyKeys(value, ["label"], ["description"]) ||
    !nonBlankString(value.label) ||
    (Object.hasOwn(value, "description") && !boundedString(value.description))
  ) {
    throw invalidFrame();
  }
  return {
    label: value.label,
    ...(typeof value.description === "string" ? { description: value.description } : {}),
  };
}

function parseQuestionIntent(value: unknown): ModernQuestionIntent {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ["kind", "approve"]) ||
    value.kind !== "plan-review" ||
    !nonBlankString(value.approve)
  ) {
    throw invalidFrame();
  }
  return { kind: "plan-review", approve: value.approve };
}

function parseQuestionAnswer(value: unknown): ModernQuestionAnswer {
  if (!isPlainRecord(value) || !hasExactKeys(value, ["answers"]) || !Array.isArray(value.answers)) {
    throw new TypeError("Invalid DeepSeek Harness question answer");
  }
  assertCollection(value.answers);
  const answers = value.answers.map((answer) => {
    if (
      !isPlainRecord(answer) ||
      !hasOnlyKeys(answer, ["id", "selected"], ["custom"]) ||
      !nonBlankString(answer.id) ||
      !Array.isArray(answer.selected) ||
      (Object.hasOwn(answer, "custom") && !boundedString(answer.custom))
    ) {
      throw new TypeError("Invalid DeepSeek Harness question answer");
    }
    assertCollection(answer.selected);
    if (!answer.selected.every(nonBlankString)) {
      throw new TypeError("Invalid DeepSeek Harness question answer");
    }
    return {
      id: answer.id,
      selected: [...answer.selected] as string[],
      ...(typeof answer.custom === "string" ? { custom: answer.custom } : {}),
    };
  });
  assertBoundedJson({ answers });
  return { answers };
}

function assertBoundedJson(value: unknown): void {
  let nodes = 0;
  let bytes = 0;
  const ancestors = new Set<object>();
  const visit = (candidate: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) {
      throw gatewayError("resourceLimit", "DeepSeek Harness event JSON exceeded its bound");
    }
    if (candidate === null || typeof candidate === "boolean") return;
    if (typeof candidate === "number") {
      if (Number.isFinite(candidate) && !Object.is(candidate, -0)) return;
      throw invalidFrame();
    }
    if (typeof candidate === "string") {
      if (!boundedString(candidate))
        throw gatewayError("resourceLimit", "DeepSeek Harness event string exceeded its bound");
      bytes += Buffer.byteLength(candidate);
      if (bytes > MAX_JSON_BYTES) {
        throw gatewayError("resourceLimit", "DeepSeek Harness event JSON exceeded its bound");
      }
      return;
    }
    if (typeof candidate !== "object" || candidate === null || ancestors.has(candidate)) {
      throw invalidFrame();
    }
    ancestors.add(candidate);
    if (Array.isArray(candidate)) {
      if (Object.getPrototypeOf(candidate) !== Array.prototype) throw invalidFrame();
      assertCollection(candidate);
      const keys = Reflect.ownKeys(candidate);
      if (
        keys.length !== candidate.length + 1 ||
        !keys.every(
          (key) =>
            key === "length" ||
            (typeof key === "string" &&
              /^(?:0|[1-9]\d*)$/u.test(key) &&
              Number(key) < candidate.length),
        )
      ) {
        throw invalidFrame();
      }
      for (let index = 0; index < candidate.length; index += 1) {
        if (!Object.hasOwn(candidate, index)) throw invalidFrame();
        visit(candidate[index], depth + 1);
      }
    } else {
      if (!isPlainRecord(candidate)) throw invalidFrame();
      const keys = Reflect.ownKeys(candidate);
      if (keys.length > MAX_COLLECTION_ITEMS) {
        throw gatewayError("resourceLimit", "DeepSeek Harness event object exceeded its bound");
      }
      for (const key of keys) {
        if (typeof key !== "string") throw invalidFrame();
        const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
        if (descriptor?.enumerable !== true || !("value" in descriptor)) throw invalidFrame();
        bytes += Buffer.byteLength(key);
        if (bytes > MAX_JSON_BYTES) {
          throw gatewayError("resourceLimit", "DeepSeek Harness event JSON exceeded its bound");
        }
        visit(descriptor.value, depth + 1);
      }
    }
    ancestors.delete(candidate);
  };
  visit(value, 0);
}

function assertCollection(value: readonly unknown[]): void {
  if (value.length > MAX_COLLECTION_ITEMS) {
    throw gatewayError("resourceLimit", "DeepSeek Harness event collection exceeded its bound");
  }
}

function malformedOutcome(event: string): typeof MALFORMED_APPROVAL | typeof MALFORMED_QUESTION {
  return event === APPROVAL_EVENT ? MALFORMED_APPROVAL : MALFORMED_QUESTION;
}

function isApprovalOutcome(value: unknown): value is ModernApprovalOutcome {
  return (
    value === "allowed-once" ||
    value === "rejected" ||
    value === "cancelled" ||
    value === "unavailable"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function hasOnlyKeys(
  value: Readonly<Record<string, unknown>>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Reflect.ownKeys(value).every((key) => typeof key === "string" && allowed.has(key))
  );
}

function validIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_ID_LENGTH &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function assertIdentifier(value: unknown, name: string): asserts value is string {
  if (!validIdentifier(value)) throw new TypeError(`${name} must be a bounded non-empty string`);
}

function validEventName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_EVENT_NAME_LENGTH &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function boundedString(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_STRING_LENGTH;
}

function nonBlankString(value: unknown): value is string {
  return boundedString(value) && value.length > 0;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function gatewayError(code: ModernEventGatewayErrorCode, message: string): ModernEventGatewayError {
  return new ModernEventGatewayError(code, message);
}

function invalidFrame(): ModernEventGatewayError {
  return gatewayError("protocolError", "DeepSeek Harness emitted an invalid event frame");
}

function normalizeError(error: unknown, fallback: string): ModernEventGatewayError {
  if (error instanceof ModernEventGatewayError) return error;
  if (error instanceof ModernRemoteConnectionError && error.code === "protocolError") {
    return new ModernEventGatewayError("protocolError", error.message, error.nativeCode);
  }
  const message = error instanceof Error ? error.message : fallback;
  return gatewayError("unavailable", redactModernCredential(message || fallback));
}

function onceAsync(operation: () => Promise<void>): () => Promise<void> {
  let result: Promise<void> | undefined;
  return () => (result ??= operation());
}

async function bestEffortCancel(sink: ModernEventSink): Promise<void> {
  let cancel: Promise<unknown>;
  try {
    cancel = Promise.resolve(sink.cancelNative());
  } catch {
    return;
  }
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, NATIVE_CANCEL_WAIT_MS);
  });
  await Promise.race([cancel.catch(() => undefined), timeout]);
  if (timer) clearTimeout(timer);
}
