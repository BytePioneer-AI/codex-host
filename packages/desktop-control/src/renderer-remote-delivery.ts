import type {
  RemoteDeliveryReply,
  RemoteQueueSnapshot,
  RemoteSessionOperation,
  THREAD_QUEUE_START_IF_EMPTY_PARAM,
  THREAD_STEER_STRICT_TARGET_FIELD,
  THREAD_STEER_STRICT_TARGET_PARAM,
} from "@codexhost/shared-contracts";

/** Self-contained for the Desktop Controller expression. All writes use the selected native manager. */
export async function rendererRemoteDelivery(
  operation: Extract<RemoteSessionOperation, { kind: "delivery" | "queue" }>,
  read: (method: string, params: object) => Promise<unknown>,
  write: (method: string, params: object) => Promise<unknown>,
): Promise<RemoteDeliveryReply | RemoteQueueSnapshot> {
  const { threadId } = operation;
  const record = (value: unknown): Record<string, unknown> | undefined =>
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  const codeOf = (error: unknown) => record(error)?.jsonRpcCode ?? record(error)?.code;
  const messageOf = (error: unknown) => String(record(error)?.message ?? "");
  const queueUnavailable = (error: unknown, method: string) =>
    codeOf(error) === -32601 ||
    ((codeOf(error) === -32600 || codeOf(error) === -32602) &&
      (messageOf(error).startsWith(`Invalid request: unknown variant \`${method}\``) ||
        messageOf(error) === `${method} requires experimentalApi capability` ||
        messageOf(error) === "user message queue is unavailable"));
  const reject = (
    code: Extract<RemoteDeliveryReply, { accepted: false }>["code"],
    message: string,
  ): RemoteDeliveryReply => ({ accepted: false, code, message });
  const readQueue = async (limit: number) => {
    const page = record(await read("thread/queue/list", { threadId, cursor: null, limit }));
    if (
      !Array.isArray(page?.data) ||
      page.data.length > limit ||
      (page.nextCursor !== null &&
        (typeof page.nextCursor !== "string" || page.nextCursor.length === 0))
    )
      throw new Error("Invalid remote queue response");
    return { data: page.data as unknown[], nextCursor: page.nextCursor };
  };

  if (operation.kind === "queue") {
    let page: Awaited<ReturnType<typeof readQueue>>;
    try {
      page = await readQueue(100);
    } catch (error) {
      if (queueUnavailable(error, "thread/queue/list")) return { available: false };
      throw error;
    }
    if (page.nextCursor !== null) throw new Error("Remote queue exceeds the snapshot limit");
    const items = page.data.map((value) => {
      const item = record(value);
      if (
        typeof item?.id !== "string" ||
        typeof item.clientUserMessageId !== "string" ||
        !Array.isArray(item.input)
      )
        throw new Error("Invalid remote queue item");
      // Text previews keep attachments and large payloads out of the Controller reply.
      let preview = "";
      for (const value of item.input as unknown[]) {
        const part = record(value);
        const text =
          part?.type === "text" && typeof part.text === "string"
            ? part.text
            : typeof part?.type === "string"
              ? `[${part.type}]`
              : "";
        preview += (preview ? " " : "") + text.slice(0, 801 - preview.length);
        if (preview.length >= 801) {
          preview = preview.slice(0, 800) + "…";
          break;
        }
      }
      return { id: item.id, clientUserMessageId: item.clientUserMessageId, preview };
    });
    if (new Set(items.map((item) => item.id)).size !== items.length)
      throw new Error("Remote queue repeats a submission");
    return { available: true, items };
  }

  const readHeader = async () => {
    const result = record(await read("thread/read", { threadId, includeTurns: false }));
    const thread = record(result?.thread);
    const status = record(thread?.status)?.type;
    if (thread?.id !== threadId || typeof status !== "string")
      throw new Error("Invalid remote Thread status");
    const strictSteerField =
      "codexhostSupportsStrictSteer" satisfies typeof THREAD_STEER_STRICT_TARGET_FIELD;
    return {
      status,
      readOnly: thread.canAcceptDirectInput === false,
      // The Host reserves both markers on its external Thread projections.
      external: thread.modelProvider === "codexhost" && thread.cliVersion === "codexhost",
      strictSteer: thread[strictSteerField] === true,
    };
  };
  const readOnly = () =>
    reject("remote/send-rejected", "This remote Thread does not accept direct input.");
  let header = await readHeader();
  if (header.readOnly) return readOnly();

  const { action } = operation;
  if (action.kind === "remove") {
    try {
      const result = record(
        await write("thread/queue/delete", { threadId, queuedSubmissionId: action.itemId }),
      );
      if (result?.deleted === true) return { accepted: true };
      if (result?.deleted === false)
        return reject("session/queue-item-not-found", "Queued message is no longer pending.");
      throw new Error("Remote queue removal was not confirmed");
    } catch (error) {
      if (codeOf(error) === -32072 && messageOf(error) === "Queued message is already starting")
        return reject("session/queue-item-starting", messageOf(error));
      throw error;
    }
  }
  if (action.kind === "start") {
    const busy = () => reject("remote/turn-changed", "The remote Thread is already running.");
    if (header.status === "active") return busy();
    try {
      if (action.onlyIfHead && record((await readQueue(1)).data[0])?.id !== action.itemId)
        return { accepted: true };
      const result = record(
        await write("thread/queue/start", { threadId, queuedSubmissionId: action.itemId }),
      );
      if (typeof record(result?.turn)?.id === "string") return { accepted: true };
      throw new Error("Remote queued Turn start was not confirmed");
    } catch (error) {
      const code = codeOf(error);
      const message = messageOf(error);
      if (
        (code === -32600 && message === "thread already has an active or pending turn") ||
        (code === -32072 && message === "External Thread already has an active Turn")
      )
        return busy();
      if (
        (code === -32600 && message === `queued submission not found: ${action.itemId}`) ||
        (code === -32072 && message === "Queued message not found")
      )
        return reject("session/queue-item-not-found", "Queued message is no longer pending.");
      throw error;
    }
  }
  if (action.kind === "sendNow") {
    return reject(
      "remote/steer-unavailable",
      "Use Codex Desktop to steer an already queued remote message.",
    );
  }

  const params = {
    threadId,
    input: [{ type: "text", text: action.text, text_elements: [] }],
    clientUserMessageId: action.requestId,
  };
  if (action.kind === "steer") {
    const turnChanged = () =>
      reject("remote/turn-changed", "The selected Turn has ended or changed.");
    if (header.status !== "active") return turnChanged();
    if (header.external && !header.strictSteer)
      return reject(
        "remote/steer-unavailable",
        "This remote Host does not support steering with a confirmed Turn target.",
      );
    const strictTarget = {
      codexhostSteerStrictTarget: true,
    } satisfies Record<typeof THREAD_STEER_STRICT_TARGET_PARAM, true>;
    try {
      const result = record(
        await write("turn/steer", {
          ...params,
          expectedTurnId: action.turnId,
          ...(header.external ? strictTarget : {}),
        }),
      );
      if (result?.turnId === action.turnId) return { accepted: true };
      // An external Harness can explicitly acknowledge replacement as its native delivery.
      if (
        header.external &&
        result?.delivery === "newTurn" &&
        typeof result.turnId === "string" &&
        result.turnId
      )
        return { accepted: true };
      throw new Error("Remote steering was not confirmed");
    } catch (error) {
      const code = codeOf(error);
      const message = messageOf(error);
      if (
        (code === -32600 &&
          (message === "no active turn to steer" ||
            /^expected active turn id .+ but found /u.test(message))) ||
        (code === -32074 &&
          (message === "External steering must reference the active Turn" ||
            message === "External steering target is no longer active"))
      )
        return turnChanged();
      if (
        code === -32601 ||
        code === -32602 ||
        (code === -32600 && message.startsWith("cannot steer "))
      )
        return reject("remote/send-rejected", message);
      throw error;
    }
  }

  if (header.status === "notLoaded") {
    await read("thread/resume", { threadId, excludeTurns: true });
    header = await readHeader();
  }
  if (header.readOnly) return readOnly();
  if (header.status !== "idle" && header.status !== "active")
    return reject("remote/send-rejected", "The remote Thread could not be opened for input.");
  const unavailable = () =>
    reject("remote/queue-unavailable", "This remote Host does not support message queues.");

  let startNativeWhenEmpty = false;
  if (!header.external && header.status === "idle") {
    try {
      startNativeWhenEmpty = (await readQueue(1)).data.length === 0;
    } catch (error) {
      if (queueUnavailable(error, "thread/queue/list")) return unavailable();
      throw error;
    }
  }
  const startExternalIfEmpty = {
    codexhostQueueStartIfEmpty: true,
  } satisfies Record<typeof THREAD_QUEUE_START_IF_EMPTY_PARAM, true>;
  const addParams =
    header.external && header.status === "idle" ? { ...params, ...startExternalIfEmpty } : params;
  let result: Record<string, unknown> | undefined;
  try {
    result = record(await write("thread/queue/add", addParams));
  } catch (error) {
    if (queueUnavailable(error, "thread/queue/add")) return unavailable();
    const code = codeOf(error);
    const message = messageOf(error);
    if (
      code === -32602 ||
      (code === -32600 && message === "queue cannot contain more than 100 submissions") ||
      (code === -32072 &&
        (message === "External Thread queue is full" ||
          message === "Message ID was already used with different input"))
    )
      return reject("remote/send-rejected", message);
    throw error;
  }
  const queued = record(result?.queuedSubmission);
  if (
    typeof queued?.id !== "string" ||
    !queued.id ||
    queued.clientUserMessageId !== action.requestId
  )
    throw new Error("Remote queue admission was not confirmed");

  // Return admission before a separate native start request can time out.
  return { accepted: true, ...(startNativeWhenEmpty ? { startQueuedItemId: queued.id } : {}) };
}
