import { randomUUID } from "node:crypto";
import type { ZcodeConnection } from "./connection.js";
import type { DesktopService } from "./desktop-client.js";
import type { RpcMessage, TransportOptions } from "./transport.js";
import { record, text, snapshotSchema } from "./protocol.js";
import { ZcodeError } from "./errors.js";
import { sameWorkspaceDirectory } from "./workspace-directory.js";

const METHODS: Record<string, string> = {
  "session/create": "createSession",
  "session/resume": "resumeSession",
  "session/read": "readSession",
  "session/send": "sendPrompt",
  "session/setModel": "setModel",
  "session/setThoughtLevel": "setThoughtLevel",
  "session/setMode": "setMode",
  "session/compact": "compactSession",
  "session/goal": "goalSession",
  "session/usage": "getTaskTokenUsage",
  "session/subagents": "listSessionSubagents",
  "workspace/readPresentation": "readWorkspacePresentation",
  "v4/conversation/rowsRange": "conversationRowsRangeV4",
  "v4/conversation/fileChanges": "conversationFileChangesV4",
};
/** Translate only the existing ZCode protocol operations. Native auth remains entirely in Desktop. */
export class DesktopConnection implements ZcodeConnection {
  readonly locator: { backend: "desktop"; desktopId: string };
  onMessage: ((message: RpcMessage) => void) | undefined;
  onFault: ((error: Error) => void) | undefined;
  #subscriptions: Array<() => Promise<void>> = [];
  #owned = new Map<string, { expectedPersistence?: "deferred" }>();
  #conversationSubscriptions = new Map<string, () => Promise<void>>();
  #interactions = new Map<
    string,
    { sessionId: string; type: string; request: Record<string, unknown> }
  >();
  #removeFault: () => void;
  #closed = false;
  #closing: Promise<void> | undefined;
  constructor(
    readonly options: TransportOptions,
    readonly service: DesktopService,
  ) {
    this.locator = { backend: "desktop", desktopId: service.desktopId };
    this.#removeFault = service.onFault((error) => this.onFault?.(error));
  }
  #call(method: string, params: Record<string, unknown>) {
    return this.service.call(method, { ...params, ...this.service.workspace });
  }
  async #command(
    sessionId: string,
    type: string,
    payload: unknown,
    envelope: Record<string, unknown> = {},
  ) {
    const ack = record(
      await this.#call("sendConversationCommandV4", {
        envelope: {
          commandId: randomUUID(),
          issuedAt: Date.now(),
          ...envelope,
          clientId: this.service.clientId,
          sessionId,
          type,
          payload,
        },
      }),
    );
    if (ack.status !== "accepted")
      throw new ZcodeError(
        ack.status === "stale" ? "sessionBusy" : "nativeFailure",
        "ZCode Desktop did not accept the operation",
        ack.status === "stale",
      );
    return ack;
  }
  async request(method: string, value: unknown): Promise<unknown> {
    if (this.#closed)
      throw new ZcodeError("invalidState", "ZCode Desktop Session connection is closed");
    const params = record(value),
      sessionId = text(params.sessionId);
    if (method === "session/subscribe") {
      this.#subscriptions.push(
        await this.service.listen(
          "onDynamicSessionEvent",
          {
            ...this.service.workspace,
            sessionId,
            deliveryKind: "desktop-continuous",
            includeSnapshot: false,
          },
          (value) => this.#event(sessionId, value),
        ),
      );
      // The read also forms a ChannelClient ordering barrier after listener registration.
      await this.#call("readSession", { sessionId });
      return {};
    }
    if (method === "session/close") {
      const closed = await this.#call("closeSession", params);
      if (closed !== true)
        throw new ZcodeError("protocolError", "ZCode Desktop did not confirm Session cleanup");
      this.#owned.delete(sessionId);
      return { closed: true };
    }
    if (method === "session/events")
      return { events: await this.#call("readSessionEvents", params) };
    if (method === "session/stop") {
      await this.#command(sessionId, "stop", {});
      return {};
    }
    if (method === "v4/conversation/subscribe") {
      const dispose = await this.service.listen(
        "onDynamicConversationFrame",
        this.service.workspace,
        (frame) => this.onMessage?.({ method: "v4/conversation/frame", params: { frame } }),
      );
      try {
        const result = await this.#call("subscribeConversationV4", {
          sessionId: text(params.topic).slice("conversation/".length),
        });
        const id = text(record(record(result).ack).subscriptionId);
        if (!id)
          throw new ZcodeError("protocolError", "ZCode conversation subscription has no identity");
        this.#conversationSubscriptions.set(id, dispose);
        return result;
      } catch (error) {
        await dispose().catch(() => {});
        throw error;
      }
    }
    if (method === "v4/conversation/unsubscribe") {
      const id = text(params.subscriptionId),
        dispose = this.#conversationSubscriptions.get(id);
      try {
        return await this.#call("unsubscribeConversationV4", { subscriptionId: id });
      } finally {
        this.#conversationSubscriptions.delete(id);
        await dispose?.().catch(() => {});
      }
    }
    if (method === "v4/command") {
      const ack = await this.#command(sessionId, text(params.type), params.payload, params);
      const child = text(record(ack.result).sessionId);
      if (params.type === "forkAssistant" && child && child !== sessionId)
        this.#owned.set(child, {});
      return ack;
    }
    const native = METHODS[method];
    if (!native)
      throw new ZcodeError(
        "unsupported",
        "This operation is not available over the ZCode Desktop connection",
      );
    if (method === "session/resume") {
      // Do not repair/rewind a Session currently being executed from the native Desktop.
      try {
        const existing = snapshotSchema.parse(
          await this.#call("readSession", { sessionId, runtimePolicy: "existing-only" }),
        );
        if (existing.projection.currentTurnId || existing.session.status === "running")
          throw new ZcodeError(
            "sessionBusy",
            "ZCode Desktop is already executing this Session",
            true,
          );
      } catch (error) {
        if (!(error instanceof ZcodeError && error.code === "sessionNotFound")) throw error;
      }
    }
    const input = { ...params };
    delete input.workspace;
    delete input.clientMode;
    delete input.connectionId;
    let result: unknown;
    try {
      result = await this.#call(native, {
        ...input,
        ...(method === "session/send" ? { clientMode: "web-remote-replayable" } : {}),
      });
    } catch (error) {
      if (method === "session/create") this.service.invalidate();
      throw error;
    }
    if (method === "session/create") {
      const snapshot = record(result),
        session = record(snapshot.session),
        id = text(session.sessionId);
      // A bad/lost receipt is not permission to close an arbitrary Desktop Session.
      // Check ownership independently of the catalog so malformed settings still clean up.
      if (
        !id.trim() ||
        session.status !== "idle" ||
        !snapshotSchema.shape.projection.safeParse(snapshot.projection).success ||
        !sameWorkspaceDirectory(
          text(record(session.workspace).workspacePath),
          this.service.workspace.workspacePath,
        ) ||
        !Array.isArray(snapshot.messages) ||
        snapshot.messages.length ||
        record(snapshot.projection).currentTurnId
      ) {
        this.service.invalidate();
        throw new ZcodeError(
          "protocolError",
          "ZCode Session ownership and cleanup are unconfirmed",
        );
      }
      this.#owned.set(
        id,
        params.persistence === "deferred" ? { expectedPersistence: "deferred" } : {},
      );
    } else if (method === "session/resume") {
      const snapshot = snapshotSchema.parse(result);
      if (
        snapshot.session.sessionId !== sessionId ||
        !sameWorkspaceDirectory(
          snapshot.session.workspace.workspacePath,
          this.service.workspace.workspacePath,
        )
      )
        throw new ZcodeError("protocolError", "ZCode resumed an unexpected Session");
      if (snapshot.projection.currentTurnId || snapshot.session.status === "running")
        throw new ZcodeError(
          "sessionBusy",
          "ZCode Desktop started executing this Session during resume",
          true,
        );
      this.#owned.set(sessionId, {});
    }
    return result;
  }
  #event(sessionId: string, value: unknown) {
    if (this.#closed) return;
    const event = record(value);
    if (event.type === "session.event") {
      if (record(event.event).sessionId !== sessionId) return;
      this.onMessage?.({ method: "session/event", params: event.event });
    } else if (event.type === "state.updated") {
      if (record(event.notification).sessionId !== sessionId) return;
      this.onMessage?.({ method: "state.updated", params: event.notification });
    } else if (event.type === "permission.request" || event.type === "userInput.request") {
      const request = record(event.request),
        id = text(request.requestId);
      if (!id || request.sessionId !== sessionId) return;
      this.#interactions.set(id, { sessionId, type: event.type, request });
      this.onMessage?.({
        id,
        method:
          event.type === "permission.request"
            ? "interaction/requestPermission"
            : "interaction/requestUserInput",
        params: request,
      });
    }
  }
  async respond(id: string | number, result: unknown) {
    const pending = this.#interactions.get(String(id));
    if (!pending) throw new ZcodeError("invalidRequest", "ZCode interaction is no longer pending");
    let answer = result;
    if (pending.type === "permission.request") {
      const options = Array.isArray(pending.request.options)
        ? pending.request.options.map(record)
        : [];
      const option =
        options.find((option) => JSON.stringify(option.response) === JSON.stringify(result)) ??
        (record(result).decision === "deny"
          ? options.find((option) => record(option.response).decision === "deny")
          : undefined);
      if (!option || !text(option.optionId))
        throw new ZcodeError(
          "invalidRequest",
          "ZCode permission answer does not match a native option",
        );
      answer = { optionId: option.optionId };
    }
    await this.#command(pending.sessionId, "resolveInteraction", {
      interactionId: String(id),
      answer,
    });
    this.#interactions.delete(String(id));
  }
  reject(id: string | number) {
    const pending = this.#interactions.get(String(id));
    if (pending)
      void this.respond(
        id,
        pending.type === "permission.request" ? { decision: "deny" } : { action: "cancel" },
      ).catch(() => {});
  }
  close() {
    return (this.#closing ??= this.#close());
  }
  async #close() {
    this.#closed = true;
    this.#removeFault();
    for (const dispose of this.#subscriptions.splice(0)) await dispose().catch(() => {});
    for (const [subscriptionId, dispose] of this.#conversationSubscriptions) {
      await this.#call("unsubscribeConversationV4", { subscriptionId }).catch(() => {});
      await dispose().catch(() => {});
    }
    this.#conversationSubscriptions.clear();
    // Only Sessions created/resumed by this connection; never dispose a shared workspace or Desktop.
    for (const [sessionId, guard] of this.#owned)
      await this.#call("closeSession", { sessionId, ...guard }).catch(() => {});
    this.#owned.clear();
    this.#interactions.clear();
  }
}
