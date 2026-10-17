import { randomUUID } from "node:crypto";
import type { JsonObject } from "@codexhost/protocol-core";
import type { ExternalVoiceCall, ExternalVoiceCallFactory } from "./external-voice-gateway.js";

interface VoiceSession {
  controller: AbortController;
  call?: ExternalVoiceCall;
  creation?: Promise<ExternalVoiceCall>;
  seen: Set<string>;
  initializationTimeout?: ReturnType<typeof setTimeout>;
  stopping?: Promise<void>;
}

function object(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const voices = new Set([
  "juniper",
  "maple",
  "spruce",
  "ember",
  "vale",
  "breeze",
  "arbor",
  "sol",
  "cove",
]);

/** External-only native call lifecycle. Native Codex requests never enter this owner. */
export class ExternalVoice {
  readonly #sessions = new Map<string, VoiceSession>();
  constructor(
    readonly options: {
      createCall: ExternalVoiceCallFactory;
      notify(method: string, params: JsonObject): Promise<void>;
      runTask(threadId: string, text: string, signal: AbortSignal): Promise<string>;
      diagnose(): void;
    },
  ) {}

  has(threadId: string): boolean {
    return this.#sessions.has(threadId);
  }

  async start(threadId: string, params: JsonObject): Promise<void> {
    if (this.has(threadId)) throw new Error("This chat already has a voice call");
    if (
      !object(params.transport) ||
      params.transport.type !== "webrtc" ||
      typeof params.transport.sdp !== "string" ||
      !params.transport.sdp.startsWith("v=0") ||
      params.transport.sdp.length > 256_000 ||
      params.outputModality !== "audio"
    ) {
      throw new Error("External voice requires the native WebRTC audio call transport");
    }
    if (params.voice != null && (typeof params.voice !== "string" || !voices.has(params.voice))) {
      throw new Error("Selected voice is unavailable for the external live-call protocol");
    }
    const session: VoiceSession = { controller: new AbortController(), seen: new Set() };
    this.#sessions.set(threadId, session);
    const requireActive = (): void => {
      if (session.controller.signal.aborted || this.#sessions.get(threadId) !== session)
        throw new Error("External voice start cancelled");
    };
    try {
      session.creation = this.options.createCall({
        sdp: params.transport.sdp,
        ...(typeof params.voice === "string" ? { voice: params.voice } : {}),
        signal: session.controller.signal,
        onEvent: (event) => {
          void this.#event(threadId, session, event).catch(() => this.#fail(threadId, session));
        },
        onError: () => {
          void this.#fail(threadId, session);
        },
      });
      session.call = await session.creation;
      if (session.controller.signal.aborted) {
        await session.call.close();
        throw new Error("External voice start cancelled");
      }
      requireActive();
      await this.options.notify("thread/realtime/started", {
        threadId,
        realtimeSessionId: randomUUID(),
        version: "v3",
      });
      requireActive();
      await this.options.notify("thread/realtime/sdp", { threadId, sdp: session.call.sdp });
      requireActive();
      session.initializationTimeout = setTimeout(() => {
        void this.#fail(threadId, session);
      }, 20_000);
      session.initializationTimeout.unref();
      void session.call.connect().catch(() => this.#fail(threadId, session));
    } catch {
      await this.#fail(threadId, session);
      throw new Error("External voice could not start");
    }
  }

  async stop(threadId: string, reason = "requested"): Promise<void> {
    const session = this.#sessions.get(threadId);
    if (!session) return;
    if (session.stopping) return session.stopping;
    session.controller.abort();
    clearTimeout(session.initializationTimeout);
    session.stopping = (async () => {
      let failed = false;
      try {
        const call = session.call ?? (await session.creation?.catch(() => undefined));
        await call?.close();
      } catch {
        failed = true;
        this.options.diagnose();
      } finally {
        if (this.#sessions.get(threadId) === session) this.#sessions.delete(threadId);
        await this.options.notify("thread/realtime/closed", {
          threadId,
          reason: failed ? "cleanup_unconfirmed" : reason,
        });
      }
      if (failed) throw new Error("External voice cleanup was not confirmed");
    })();
    return session.stopping;
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.#sessions.keys()].map((id) => this.stop(id)));
  }

  async #fail(threadId: string, session: VoiceSession): Promise<void> {
    if (session.controller.signal.aborted || this.#sessions.get(threadId) !== session) return;
    try {
      await this.options.notify("thread/realtime/error", {
        threadId,
        message: "External voice connection failed. Retry the call explicitly.",
      });
    } catch {
      this.options.diagnose();
    } finally {
      await this.stop(threadId, "error").catch(() => undefined);
    }
  }

  async #event(threadId: string, session: VoiceSession, event: JsonObject): Promise<void> {
    if (session.controller.signal.aborted || this.#sessions.get(threadId) !== session) return;
    if (event.type === "error") {
      await this.#fail(threadId, session);
      return;
    }
    if (
      (event.type === "session.started" || event.type === "session.updated") &&
      object(event.session) &&
      typeof event.session.id === "string"
    ) {
      clearTimeout(session.initializationTimeout);
      return;
    }
    if (event.type === "input_transcript.added" || event.type === "output_transcript.added") {
      if (object(event.item) && typeof event.item.text === "string") {
        await this.options.notify("thread/realtime/transcript/delta", {
          threadId,
          role: event.type === "input_transcript.added" ? "user" : "assistant",
          delta: event.item.text,
        });
      }
      return;
    }
    if (event.type === "turn.done" && object(event.turn)) {
      if (
        ["user", "assistant"].includes(String(event.turn.role)) &&
        typeof event.turn.transcript === "string"
      ) {
        await this.options.notify("thread/realtime/transcript/done", {
          threadId,
          role: String(event.turn.role),
          text: event.turn.transcript,
        });
      }
      return;
    }
    if (event.type !== "delegation.created" || !object(event.item)) return;
    const item = event.item;
    if (
      item.type !== "delegation" ||
      item.target !== "client" ||
      typeof item.id !== "string" ||
      !item.id ||
      item.id.length > 256
    )
      return;
    if (session.seen.has(item.id)) return;
    if (session.seen.size >= 512) {
      await this.#fail(threadId, session);
      return;
    }
    session.seen.add(item.id);
    const text = Array.isArray(item.content)
      ? item.content
          .filter(object)
          .filter((part) => part.type === "input_text" && typeof part.text === "string")
          .map((part) => part.text)
          .join("")
          .trim()
      : "";
    if (!text || text.length > 32_000)
      throw new Error("External voice delegation has no valid task text");
    let result: string;
    try {
      result = await this.options.runTask(threadId, text, session.controller.signal);
    } catch {
      result =
        "The selected agent could not complete this request. No completion is confirmed. Check the chat for its current task status.";
    }
    if (session.controller.signal.aborted || this.#sessions.get(threadId) !== session) return;
    // Conservative Unicode chunks stay below the protocol's context append limit.
    const characters = [...result].slice(0, 8_000);
    const call = session.call;
    if (!call) return;
    for (let offset = 0; offset < characters.length; offset += 120) {
      call.send({
        type: "delegation.context.append",
        delegation_item_id: item.id,
        channel: "speakable",
        content: [{ type: "input_text", text: characters.slice(offset, offset + 120).join("") }],
      });
    }
  }
}
