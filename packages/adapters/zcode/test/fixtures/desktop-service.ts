import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import type { DesktopService } from "../../src/desktop-client.js";
import {
  record,
  snapshotSchema,
  text,
  type NativeSnapshot,
  type NativeEvent,
} from "../../src/protocol.js";
import { ZcodeError } from "../../src/errors.js";

export function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing Desktop fixture value");
  return value;
}

/** Synthetic service, not an official-account acceptance test. */
export function desktopService(cwd: string) {
  const saved = new Map<string, NativeSnapshot>(),
    active = new Set<string>(),
    deferred = new Set<string>();
  const events = new Map<string, NativeEvent[]>(),
    turns = new Map<string, { turn: string; user: string; request?: string }>();
  const listeners = new Set<{
    method: string;
    params: Record<string, unknown>;
    listener(value: unknown): void;
  }>();
  const faults = new Set<(error: Error) => void>();
  const emit = (id: string, value: unknown) => {
    for (const entry of listeners)
      if (entry.method === "onDynamicSessionEvent" && entry.params.sessionId === id)
        entry.listener(value);
  };
  const event = (id: string, type: string, payload: Record<string, unknown>, turnId?: string) => {
    const snapshot = required(saved.get(id));
    const value: NativeEvent = {
      eventId: randomUUID(),
      sessionId: id,
      seq: Number(snapshot.runtime.eventSeq) + 1,
      timestamp: Date.now(),
      type,
      payload,
      ...(turnId ? { turnId } : {}),
    };
    snapshot.runtime.eventSeq = value.seq;
    events.set(id, [...(events.get(id) ?? []), value]);
    emit(id, { type: "session.event", event: value });
  };
  const finish = (id: string, cancelled = false) => {
    const running = turns.get(id),
      snapshot = required(saved.get(id));
    if (!running) return;
    const messageId = randomUUID();
    if (!cancelled)
      snapshot.messages.push({
        info: {
          sessionId: id,
          messageId,
          parentMessageId: running.user,
          role: "assistant",
          finish: "stop",
          time: { created: Date.now(), completed: Date.now() },
        },
        parts: [
          {
            partId: `${messageId}:text`,
            messageId,
            sessionId: id,
            type: "text",
            text: "Desktop fixture reply.",
          },
        ],
      });
    delete snapshot.projection.currentTurnId;
    snapshot.session.status = "idle";
    turns.delete(id);
    event(id, "turn.completed", { resultType: cancelled ? "cancelled" : "success" }, running.turn);
    emit(id, {
      type: "state.updated",
      notification: { sessionId: id, reason: "prompt_completed" },
    });
  };
  const call = vi.fn(async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    if (params.workspacePath !== cwd) throw new Error("Workspace scope missing");
    if (method === "readWorkspacePresentation")
      return { workspace: { workspacePath: cwd, workspaceKey: cwd }, mode: "build" };
    if (method === "createSession") {
      if (params.sessionId !== undefined || params.importedHistory !== undefined)
        throw new Error("Do not import or choose a Session ID");
      const sessionId = randomUUID(),
        model = params.model ?? {
          providerId: "fixture-account",
          modelId: "GLM-5.3",
          options: { reasoningLevel: "high" },
        };
      const snapshot = snapshotSchema.parse({
        protocol: { name: "ZCode Protocol", version: 1 },
        session: {
          sessionId,
          workspace: { workspacePath: cwd, workspaceKey: cwd },
          title: "Fixture",
          status: "idle",
          mode: params.mode ?? "build",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          sessionKind: "interactive",
        },
        settings: {
          model: {
            current: model,
            available: [
              {
                ref: { providerId: "fixture-account", modelId: "GLM-5.3" },
                label: "GLM-5.3 (fixture)",
                reasoning: { levels: [{ value: "high", label: "High" }], defaultLevel: "high" },
              },
              {
                ref: { providerId: "fixture-account", modelId: "GLM-5.3-Flash" },
                label: "GLM-5.3-Flash (fixture)",
              },
            ],
          },
          thoughtLevel: {
            enabled: true,
            current: params.thoughtLevel ?? "high",
            available: [{ value: "high", label: "High" }],
          },
          mode: { current: params.mode ?? "build" },
        },
        projection: { status: "idle", contextUsed: 10, contextWindow: 10000 },
        messages: [],
        runtime: { eventSeq: 0 },
      });
      saved.set(sessionId, snapshot);
      active.add(sessionId);
      if (params.persistence === "deferred") deferred.add(sessionId);
      return structuredClone(snapshot);
    }
    const id = text(params.sessionId),
      snapshot = saved.get(id);
    if (method === "closeSession") {
      if (params.expectedPersistence === "deferred" && !deferred.has(id)) return false;
      active.delete(id);
      if (deferred.delete(id) || !snapshot?.messages.length) saved.delete(id);
      return true;
    }
    if (method === "sendConversationCommandV4") {
      const envelope = record(params.envelope),
        target = text(envelope.sessionId),
        payload = record(envelope.payload);
      if (envelope.clientId !== "fixture-client") throw new Error("Wrong command owner");
      if (envelope.type === "stop") finish(target, true);
      else if (envelope.type === "resolveInteraction") {
        if (record(payload.answer).optionId !== "allow-once")
          throw new Error("Native approval option was not preserved");
        event(target, "permission.resolved", { requestId: payload.interactionId });
        finish(target);
      } else throw new Error("Unsupported fixture command");
      return { status: "accepted" };
    }
    if (!snapshot || (!active.has(id) && method !== "resumeSession"))
      throw new ZcodeError("sessionNotFound", "Inactive fixture Session", false, -32004);
    if (method === "resumeSession") {
      active.add(id);
      return structuredClone(snapshot);
    }
    if (method === "readSession") return structuredClone(snapshot);
    if (method === "readSessionEvents") return structuredClone(events.get(id) ?? []);
    if (method === "getTaskTokenUsage") return { inputTokens: 5, outputTokens: 2, totalTokens: 7 };
    if (method === "setModel") {
      snapshot.settings.model.current = record(params.model) as NonNullable<
        NativeSnapshot["settings"]["model"]["current"]
      >;
      return structuredClone(snapshot);
    }
    if (method === "setThoughtLevel") {
      snapshot.settings.thoughtLevel.current = text(params.thoughtLevel);
      return structuredClone(snapshot);
    }
    if (method === "setMode") {
      snapshot.settings.mode.current = params.mode as NativeSnapshot["settings"]["mode"]["current"];
      return structuredClone(snapshot);
    }
    if (method === "sendPrompt") {
      const user = randomUUID(),
        turn = randomUUID();
      snapshot.messages.push({
        info: { sessionId: id, messageId: user, role: "user", time: { created: Date.now() } },
        parts: [
          {
            partId: `${user}:text`,
            messageId: user,
            sessionId: id,
            type: "text",
            text: text(params.content),
          },
        ],
      });
      snapshot.projection.currentTurnId = turn;
      snapshot.session.status = "running";
      deferred.delete(id);
      turns.set(id, { turn, user });
      event(
        id,
        "turn.started",
        { messageId: user, input: params.content, inputId: params.inputId },
        turn,
      );
      if (params.content === "approval")
        emit(id, {
          type: "permission.request",
          request: {
            sessionId: id,
            requestId: randomUUID(),
            toolName: "Bash",
            options: [
              { optionId: "allow-once", name: "Allow", response: { decision: "allow" } },
              { optionId: "deny", name: "Deny", response: { decision: "deny" } },
            ],
          },
        });
      else if (params.content !== "hang") setTimeout(() => finish(id), 5);
      return { accepted: true };
    }
    throw new Error(`Unexpected fixture call: ${method}`);
  });
  const service: DesktopService = {
    workspace: { workspacePath: cwd },
    deviceSid: "fixture-device",
    desktopId: "fixture-desktop",
    clientId: "fixture-client",
    call,
    listen: async (method, params, listener) => {
      const entry = { method, params, listener };
      listeners.add(entry);
      return async () => {
        listeners.delete(entry);
      };
    },
    onFault: (listener) => {
      faults.add(listener);
      return () => {
        faults.delete(listener);
      };
    },
    invalidate: () => {
      for (const listener of [...faults])
        listener(new ZcodeError("unavailable", "Fixture connection invalidated"));
    },
    close: vi.fn(async () => {
      listeners.clear();
    }),
  };
  return { service, call, active, saved, faults, listeners, finish };
}
