import { threadOwnershipListResultSchema } from "@codexhost/shared-contracts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

type RendererMethod = (...args: unknown[]) => unknown;
interface SteeringManager {
  sendRequest: RendererMethod;
  steerTurn: RendererMethod;
  startTurn: RendererMethod;
  getTurnCoordinator: RendererMethod;
  getStreamRole?: RendererMethod;
}

function isManager(value: unknown): value is SteeringManager {
  return (
    isRecord(value) &&
    ["sendRequest", "steerTurn", "startTurn", "getTurnCoordinator"].every(
      (key) => typeof value[key] === "function",
    )
  );
}

function submissionHost(manager: SteeringManager): {
  getActiveTurnId(threadId: string): unknown;
  hasPendingTurnStart(threadId: string): unknown;
} {
  const coordinator = manager.getTurnCoordinator();
  const options = isRecord(coordinator) ? coordinator.options : null;
  const host = isRecord(options) ? options.submissionHost : null;
  if (
    !isRecord(host) ||
    typeof host.getActiveTurnId !== "function" ||
    typeof host.hasPendingTurnStart !== "function"
  ) {
    throw new Error("Desktop turn submission binding is unavailable");
  }
  return {
    getActiveTurnId: (threadId) => (host.getActiveTurnId as RendererMethod).call(host, threadId),
    hasPendingTurnStart: (threadId) =>
      (host.hasPendingTurnStart as RendererMethod).call(host, threadId),
  };
}

type SteeringMethodName = "sendRequest" | "steerTurn";

function installSteeringMethods(
  manager: SteeringManager,
  replacements: Record<SteeringMethodName, RendererMethod>,
): (name: SteeringMethodName) => void {
  const originalPrototype: object | null = Object.getPrototypeOf(manager);
  const overrides: object = Object.create(originalPrototype);
  const names = ["sendRequest", "steerTurn"] as const;
  const descriptors = new Map(
    names.map((name) => [name, Object.getOwnPropertyDescriptor(manager, name)]),
  );
  for (const name of names) {
    const own = descriptors.get(name);
    // Desktop's RpcTarget forbids own properties over RPC, including functions.
    // Override inherited methods on a private prototype, never on the instance
    // or the shared class prototype. Plain-object targets retain their own shape.
    Object.defineProperty(own ? manager : overrides, name, {
      configurable: own?.configurable ?? true,
      enumerable: own?.enumerable ?? false,
      writable: true,
      value: replacements[name],
    });
  }
  if (names.some((name) => !descriptors.get(name))) {
    Object.setPrototypeOf(manager, overrides);
  }
  return (name) => {
    const own = descriptors.get(name);
    const holder = own ? manager : overrides;
    if (Reflect.get(holder, name) === replacements[name]) {
      if (own) Object.defineProperty(manager, name, own);
      else Reflect.deleteProperty(overrides, name);
    }
    if (
      Object.getPrototypeOf(manager) === overrides &&
      names.every((key) => !Object.hasOwn(overrides, key))
    ) {
      Object.setPrototypeOf(manager, originalPrototype);
    }
  };
}

const INTERRUPTED_QUEUE_REASON = "Interrupted before the steer was accepted.";

async function preserveQueuedFollowUps(
  manager: SteeringManager,
  threadId: string,
): Promise<() => void> {
  const coordinator = manager.getTurnCoordinator();
  if (
    !isRecord(coordinator) ||
    typeof coordinator.loadMessages !== "function" ||
    typeof coordinator.readMessages !== "function" ||
    typeof coordinator.mutate !== "function"
  ) {
    throw new Error("Desktop follow-up queue binding is unavailable");
  }
  await coordinator.loadMessages.call(coordinator, threadId);
  const messages: unknown = coordinator.readMessages.call(coordinator, threadId);
  if (!Array.isArray(messages)) throw new Error("Desktop follow-up queue is unavailable");
  const alreadyPaused = new Set(
    messages
      .filter((message) => isRecord(message) && message.pausedReason != null)
      .map((message) => (message as Record<string, unknown>).id),
  );
  return () => {
    // A real interrupted terminal pauses Desktop's queue. Resume only pauses introduced
    // by this replacement, including messages queued while cancellation was pending.
    (coordinator.mutate as RendererMethod).call(coordinator, threadId, (current: unknown) => {
      if (!Array.isArray(current)) return current;
      return current.map((message) => {
        if (
          !isRecord(message) ||
          alreadyPaused.has(message.id) ||
          message.pausedReason !== INTERRUPTED_QUEUE_REASON
        )
          return message;
        const resumed = { ...message };
        delete resumed.pausedReason;
        return resumed;
      });
    });
  };
}

/**
 * Use Desktop's normal start presentation BEFORE it creates an old-Turn steering Item.
 * Only this operation's outgoing start RPC becomes steer; Host owns stop/wait/start.
 * Official Threads retain the original steer implementation and response semantics.
 */
export function installRendererExternalSteering(target: unknown): (() => void) | null {
  if (!isManager(target)) return null;
  const manager = target;
  const originalSteer = manager.steerTurn;
  const originalSend = manager.sendRequest;
  const routes = new Map<string, { threadId: string; expectedTurnId: string }>();
  const pending = new Map<
    string,
    { messageId: string; fingerprint: string; promise: Promise<unknown> }
  >();
  let disposed = false;

  const send: RendererMethod = function (method, params, options) {
    const messageId = isRecord(params) ? params.clientUserMessageId : null;
    const route =
      typeof messageId === "string" && isRecord(params)
        ? routes.get(`${params.threadId}\u0000${messageId}`)
        : undefined;
    if (
      method !== "turn/start" ||
      !isRecord(params) ||
      !route ||
      route.threadId !== params.threadId
    ) {
      return originalSend.call(manager, method, params, options);
    }
    if (disposed) return Promise.reject(new Error("External steering binding was disposed"));
    return Promise.resolve(
      originalSend.call(
        manager,
        "turn/steer",
        {
          threadId: route.threadId,
          expectedTurnId: route.expectedTurnId,
          clientUserMessageId: messageId,
          input: params.input,
          additionalContext: params.additionalContext,
          responsesapiClientMetadata: params.responsesapiClientMetadata,
        },
        options,
      ),
    ).then((response) => {
      if (!isRecord(response) || typeof response.turnId !== "string" || !response.turnId) {
        throw new Error("External steering returned no replacement Turn identity");
      }
      return {
        turn: {
          id: response.turnId,
          status: "inProgress",
          items: [],
          error: null,
          startedAt: null,
          completedAt: null,
          durationMs: null,
          itemsView: "full",
        },
      };
    });
  };

  const steer: RendererMethod = async function (...args) {
    const [
      threadId,
      input,
      restoreMessage,
      serviceTier,
      attachments,
      clientUserMessageId,
      additionalContext,
      toolOutput,
      onMessageAdded,
    ] = args;
    if (typeof threadId !== "string") return originalSteer.apply(manager, args);
    const role = manager.getStreamRole?.(threadId);
    // Let Desktop forward to the owning window; its manager performs the replacement.
    if (isRecord(role) && role.role === "follower") return originalSteer.apply(manager, args);
    let host: ReturnType<typeof submissionHost> | null = null;
    let expectedTurnId: unknown;
    try {
      host = submissionHost(manager);
      expectedTurnId = host.getActiveTurnId(threadId);
    } catch {
      // Official steering must not depend on our additional presentation binding.
    }
    const ownership = threadOwnershipListResultSchema.parse(
      await originalSend.call(manager, "codexhost/thread/ownership/list", {
        threadIds: [threadId],
      }),
    );
    const owner = ownership.threads.find((thread) => thread.threadId === threadId)?.owner;
    if (!owner) throw new Error("Thread ownership could not be resolved for steering");
    if (disposed) throw new Error("External steering binding was disposed");
    if (owner === "codex") return originalSteer.apply(manager, args);
    if (!host) throw new Error("Desktop turn submission binding is unavailable");
    const currentRole = manager.getStreamRole?.(threadId);
    if (isRecord(currentRole) && currentRole.role === "follower")
      return originalSteer.apply(manager, args);
    if (
      !Array.isArray(input) ||
      input.length === 0 ||
      input.some(
        (item) => !isRecord(item) || item.type !== "text" || typeof item.text !== "string",
      ) ||
      !input.some((item) => isRecord(item) && typeof item.text === "string" && item.text.trim())
    ) {
      throw new Error("External steering requires non-empty text input");
    }
    if (toolOutput != null) throw new Error("External steering cannot replace a tool response");
    if (!isRecord(restoreMessage) || !isRecord(restoreMessage.context)) {
      throw new Error("Desktop steering message context is unavailable");
    }
    const messageId =
      typeof clientUserMessageId === "string" && clientUserMessageId
        ? clientUserMessageId
        : typeof restoreMessage.id === "string" && restoreMessage.id
          ? restoreMessage.id
          : crypto.randomUUID();
    const fingerprint = JSON.stringify(input);
    const existing = pending.get(threadId);
    if (existing) {
      if (existing.messageId === messageId && existing.fingerprint === fingerprint)
        return existing.promise;
      throw new Error("This Thread is already changing direction");
    }
    if (expectedTurnId != null && (typeof expectedTurnId !== "string" || !expectedTurnId)) {
      throw new Error("Desktop active Turn identity is invalid");
    }
    if (expectedTurnId == null && host.hasPendingTurnStart(threadId)) {
      throw new Error("Previous Turn submission has not been confirmed yet");
    }
    const context = restoreMessage.context;
    const routeKey = `${threadId}\u0000${messageId}`;
    if (typeof expectedTurnId === "string") routes.set(routeKey, { threadId, expectedTurnId });
    const promise = Promise.resolve()
      .then(async () => {
        if (disposed) throw new Error("External steering binding was disposed");
        const resumeQueue = await preserveQueuedFollowUps(manager, threadId);
        if (disposed) throw new Error("External steering binding was disposed");
        const response = await manager.startTurn(
          threadId,
          {
            request: {
              threadId,
              input,
              clientUserMessageId: messageId,
              additionalContext,
              responsesapiClientMetadata: restoreMessage.responsesapiClientMetadata,
              cwd: restoreMessage.cwd,
              serviceTier,
              model: null,
              effort: null,
              collaborationMode: context.collaborationMode ?? null,
            },
            context: {
              attachments: attachments ?? [],
              commentAttachments: context.commentAttachments ?? [],
              mcpAppModelContextAttachments: context.mcpAppModelContextAttachments,
              useAppServerPermissionDefault: true,
            },
          },
          onMessageAdded,
        );
        if (
          !isRecord(response) ||
          !isRecord(response.turn) ||
          typeof response.turn.id !== "string"
        ) {
          throw new Error("Desktop returned no replacement Turn identity");
        }
        try {
          resumeQueue();
        } catch {
          // Never turn an accepted input into a failed delivery (and invite a retry).
          console.error("codexhost could not restore follow-up queue state after steering");
        }
        return { turnId: response.turn.id };
      })
      .finally(() => {
        routes.delete(routeKey);
        pending.delete(threadId);
      });
    pending.set(threadId, { messageId, fingerprint, promise });
    return promise;
  };

  const restoreMethod = installSteeringMethods(manager, { sendRequest: send, steerTurn: steer });
  return () => {
    disposed = true;
    restoreMethod("steerTurn");
    // In-flight starts must fail closed, not accidentally become ordinary start RPCs.
    if (pending.size === 0) {
      restoreMethod("sendRequest");
    } else {
      void Promise.allSettled([...pending.values()].map(({ promise }) => promise)).then(() => {
        restoreMethod("sendRequest");
      });
    }
  };
}
