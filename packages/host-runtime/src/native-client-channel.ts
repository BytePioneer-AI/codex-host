import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { JsonObject, JsonValue } from "@codexhost/protocol-core";
import {
  clientThreadSnapshotSchema,
  jsonValueSchema,
  type ClientInteraction,
  type ClientSnapshotOptions,
  type ClientThreadSnapshot,
} from "@codexhost/shared-contracts";

import type { ClientChannelEvents } from "./client-channel-events.js";
import { ClientChannelRequestError } from "./client-channel-error.js";
import { compactClientSnapshot } from "./client-snapshot-compaction.js";
import { nativeThreadConfiguration } from "./codex-runtime/native-thread-controls.js";
import { sendNativeQueuedMessage } from "./native-queued-steering.js";
import { submitNativeQueuedInput } from "./native-queued-input.js";
import { NativeClientItems } from "./native-client-items.js";
import { NativeAsyncQuestions } from "./native-async-questions.js";
import {
  nativeElicitationApproval,
  nativeElicitationApprovalResponse,
} from "./native-elicitation.js";

export type NativeClientReply =
  { result: JsonValue } | { error: { code: number; message: string } };

export interface NativeClientChannelDependencies {
  readonly events: ClientChannelEvents;
  readonly asyncQuestions?: NativeAsyncQuestions;
  request(method: string, params: JsonObject): Promise<NativeClientReply>;
  respond(
    requestId: string | number,
    result: JsonValue,
    error?: { code: number; message: string },
  ): Promise<void>;
  desktopConnected?(): boolean;
}

interface PendingNativeInteraction {
  readonly requestId: string;
  readonly nativeRequestId: string | number;
  readonly threadId: string;
  readonly method: string;
  readonly params: JsonObject;
  readonly kind: "approval" | "question";
  readonly interaction: ClientInteraction["interaction"];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isJsonObject = (value: unknown): value is JsonObject => isRecord(value);

const requestKey = (id: string | number): string => JSON.stringify([typeof id, id]);
const NATIVE_REQUEST_PREFIX = "codexhost:native-interaction:";

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function threadIdFromParams(params: Record<string, unknown>): string | undefined {
  const direct = stringValue(params.threadId);
  if (direct) return direct;
  const thread = isRecord(params.thread) ? stringValue(params.thread.id) : undefined;
  if (thread) return thread;
  const turn = isRecord(params.turn) ? stringValue(params.turn.threadId) : undefined;
  if (turn) return turn;
  const item = isRecord(params.item) ? stringValue(params.item.threadId) : undefined;
  return item;
}

function resultObject(reply: NativeClientReply): JsonObject | undefined {
  return "result" in reply && isJsonObject(reply.result) ? reply.result : undefined;
}

function resultThread(reply: NativeClientReply): JsonObject | undefined {
  const result = resultObject(reply);
  return result && isJsonObject(result.thread) ? result.thread : undefined;
}

function availableDecisions(params: Record<string, unknown>): string[] {
  if (!Array.isArray(params.availableDecisions)) return ["accept", "decline"];
  return params.availableDecisions.filter((value): value is string => typeof value === "string");
}

function decisionLabel(decision: string): string {
  switch (decision) {
    case "accept":
      return "Allow once";
    case "acceptForSession":
      return "Allow for session";
    case "acceptWithExecpolicyAmendment":
      return "Allow and remember";
    case "decline":
      return "Decline";
    case "cancel":
      return "Cancel";
    default:
      return decision;
  }
}

function decisionEffect(decision: string): string {
  switch (decision) {
    case "accept":
      return "allowOnce";
    case "acceptForSession":
      return "allowForSession";
    case "acceptWithExecpolicyAmendment":
      return "allowAlways";
    case "decline":
    case "cancel":
      return "deny";
    default:
      return "unknown";
  }
}

function approvalInteraction(
  method: string,
  params: JsonObject,
): Pick<PendingNativeInteraction, "kind" | "interaction"> | undefined {
  if (
    method !== "item/commandExecution/requestApproval" &&
    method !== "item/fileChange/requestApproval"
  )
    return undefined;
  const decisions = availableDecisions(params);
  const actions = decisions.map((id) => ({
    id,
    label: decisionLabel(id),
    effect: decisionEffect(id),
  }));
  const command = stringValue(params.command);
  const cwd = stringValue(params.cwd);
  const description = [command, cwd ? `Working directory: ${cwd}` : undefined]
    .filter(Boolean)
    .join("\n\n");
  const reason = stringValue(params.reason);
  return {
    kind: "approval",
    interaction: {
      type: "approval",
      title:
        reason ??
        (method === "item/commandExecution/requestApproval"
          ? "Allow command execution?"
          : "Allow file changes?"),
      ...(description ? { description } : {}),
      subject: params,
      actions,
    },
  };
}

function optionValue(value: unknown): string | undefined {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    return String(value);
  return undefined;
}

type ClientQuestion = Extract<ClientInteraction["interaction"], { type: "question" }>;
type ClientQuestionItem = ClientQuestion["questions"][number];

function nativeQuestions(params: JsonObject): ClientQuestion | undefined {
  if (!Array.isArray(params.questions)) return undefined;
  const questions: ClientQuestion["questions"] = [];
  params.questions.forEach((value, index) => {
    if (!isRecord(value)) return;
    const id = stringValue(value.id) ?? `question-${index + 1}`;
    const prompt = stringValue(value.question) ?? stringValue(value.header) ?? id;
    const options = Array.isArray(value.options)
      ? value.options.flatMap((option) => {
          if (!isRecord(option)) return [];
          const optionValueText =
            optionValue(option.value) ?? optionValue(option.label) ?? optionValue(option.name);
          if (!optionValueText) return [];
          return [
            {
              value: optionValueText,
              label: stringValue(option.label) ?? optionValueText,
              ...(stringValue(option.description)
                ? { description: stringValue(option.description) }
                : {}),
            },
          ];
        })
      : [];
    const question: ClientQuestionItem = options.length
      ? {
          type: "choice",
          id,
          prompt,
          multiple: value.multiSelect === true,
          allowOther: value.isOther === true,
          options,
        }
      : {
          type: "text",
          id,
          prompt,
          ...(value.isSecret === true ? { secret: true } : {}),
          ...(value.optional === true ? { optional: true } : {}),
        };
    questions.push(question);
  });
  return { type: "question", questions };
}

function schemaQuestions(params: JsonObject): ClientQuestion | undefined {
  const schema = isRecord(params.requestedSchema) ? params.requestedSchema : undefined;
  if (!schema || !isRecord(schema.properties)) return undefined;
  const properties = schema.properties;
  for (const value of Object.values(properties)) {
    if (!isRecord(value)) return undefined;
    if (value.type !== undefined && value.type !== "string") return undefined;
    if (Array.isArray(value.enum) && value.enum.some((entry) => typeof entry !== "string"))
      return undefined;
  }
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((value): value is string => typeof value === "string")
      : [],
  );
  const questions: ClientQuestion["questions"] = [];
  for (const [id, value] of Object.entries(properties)) {
    if (!isRecord(value)) continue;
    const prompt = stringValue(value.title) ?? stringValue(value.description) ?? id;
    const enumValues = Array.isArray(value.enum)
      ? value.enum.filter((entry): entry is string => typeof entry === "string")
      : [];
    const question: ClientQuestionItem = enumValues.length
      ? {
          type: "choice",
          id,
          prompt,
          multiple: false,
          allowOther: false,
          ...(required.has(id) ? {} : { optional: true }),
          options: enumValues.map((option) => ({ value: option, label: option })),
        }
      : {
          type: "text",
          id,
          prompt,
          ...(required.has(id) ? {} : { optional: true }),
        };
    questions.push(question);
  }
  return questions.length > 0 ? { type: "question", questions } : undefined;
}

function nativeInteraction(
  method: string,
  params: JsonObject,
): Pick<PendingNativeInteraction, "kind" | "interaction"> | undefined {
  const approval = approvalInteraction(method, params);
  if (approval) return approval;
  if (method === "item/tool/requestUserInput") {
    // The browser question card has no masked-input contract.
    if (
      Array.isArray(params.questions) &&
      params.questions.some((question) => isRecord(question) && question.isSecret === true)
    )
      return undefined;
    const interaction = nativeQuestions(params);
    return interaction ? { kind: "question", interaction } : undefined;
  }
  if (method === "mcpServer/elicitation/request") {
    if (params.mode !== undefined && params.mode !== "form") return undefined;
    const approval = nativeElicitationApproval(params);
    if (approval) return { kind: "approval", interaction: approval };
    const meta = isRecord(params._meta) ? params._meta : {};
    if (meta.codex_approval_kind === "mcp_tool_call") return undefined;
    const interaction = schemaQuestions(params);
    return interaction ? { kind: "question", interaction } : undefined;
  }
  if (method === "item/permissions/requestApproval") return undefined;
  return undefined;
}

function answersContent(value: unknown): JsonObject {
  if (!isRecord(value)) return {};
  const answers = isRecord(value.answers) ? value.answers : value;
  return Object.fromEntries(
    Object.entries(answers).flatMap(([id, answer]) => {
      if (isRecord(answer) && Array.isArray(answer.answers)) {
        return [[id, answer.answers.length === 1 ? answer.answers[0] : answer.answers]];
      }
      return [[id, answer]];
    }),
  ) as JsonObject;
}

function validMcpContent(params: JsonObject, content: JsonObject): boolean {
  const schema = isRecord(params.requestedSchema) ? params.requestedSchema : undefined;
  if (!schema || !isRecord(schema.properties)) return false;
  const properties = schema.properties;
  const required = Array.isArray(schema.required)
    ? schema.required.filter((entry): entry is string => typeof entry === "string")
    : [];
  if (required.some((key) => !Object.hasOwn(content, key))) return false;
  for (const [key, value] of Object.entries(content)) {
    const definition = properties[key];
    if (!isRecord(definition)) return false;
    if (definition.type === "string" && typeof value !== "string") return false;
    if (definition.type === "number" && typeof value !== "number") return false;
    if (definition.type === "integer" && (!Number.isInteger(value) || typeof value !== "number"))
      return false;
    if (definition.type === "boolean" && typeof value !== "boolean") return false;
    if (Array.isArray(definition.enum) && !definition.enum.some((entry) => Object.is(entry, value)))
      return false;
  }
  return true;
}

function validatedDecision(pending: PendingNativeInteraction, value: JsonValue): JsonObject {
  const allowed = availableDecisions(pending.params);
  if (!isRecord(value)) throw new Error("Native approval response must be an object");
  if (typeof value.decision === "string") {
    if (!allowed.includes(value.decision))
      throw new Error(`Native approval decision '${value.decision}' is not available`);
    return value as JsonObject;
  }
  const action = typeof value.action === "string" ? value.action : undefined;
  const content = isRecord(value.content) ? value.content : undefined;
  const actionId = content && stringValue(content.actionId);
  const decision = actionId ?? action;
  if (!decision || !allowed.includes(decision))
    throw new Error("Native approval response does not select an available decision");
  return { decision };
}

function nativeResponse(pending: PendingNativeInteraction, value: JsonValue): JsonValue {
  if (pending.method === "item/commandExecution/requestApproval") {
    return validatedDecision(pending, value);
  }
  if (pending.method === "item/fileChange/requestApproval") {
    return validatedDecision(pending, value);
  }
  if (pending.method === "mcpServer/elicitation/request" && pending.kind === "approval")
    return nativeElicitationApprovalResponse(pending.params, value);
  if (pending.method === "mcpServer/elicitation/request" && isRecord(value)) {
    if (typeof value.action === "string") return value as JsonObject;
    if (isRecord(value.answers)) {
      const content = answersContent(value);
      if (!validMcpContent(pending.params, content))
        throw new Error("Native elicitation response does not match its schema");
      return { action: "accept", content };
    }
  }
  return value;
}

function turnIdFromPage(turn: unknown): string | undefined {
  if (!isRecord(turn) || typeof turn.id !== "string") return undefined;
  return turn.status === "inProgress" ? turn.id : undefined;
}

const RESUME_BEFORE = new Set([
  "turn/start",
  "turn/steer",
  "turn/interrupt",
  "thread/queue/list",
  "thread/queue/add",
  "thread/queue/update",
  "thread/queue/delete",
  "thread/queue/reorder",
  "thread/queue/start",
]);
const CHANGED_METHODS = new Set([
  "thread/resume",
  "thread/start",
  "thread/name/set",
  "thread/archive",
  "thread/unarchive",
  "thread/queue/add",
  "thread/queue/update",
  "thread/queue/delete",
  "thread/queue/reorder",
  "thread/queue/start",
  "turn/start",
  "turn/steer",
  "turn/interrupt",
]);

/** Native Codex side of the Host client channel. It is attached to the shared
 * service's existing official session; it never creates an app-server. */
export class NativeClientChannel {
  readonly #host: NativeClientChannelDependencies;
  readonly #knownThreads = new Set<string>();
  readonly #resumedThreads = new Set<string>();
  readonly #configuration = new Map<string, ReturnType<typeof nativeThreadConfiguration>>();
  readonly #items = new NativeClientItems();
  readonly #asyncQuestions: NativeAsyncQuestions;
  readonly #ownsAsyncQuestions: boolean;
  readonly #pending = new Map<string, PendingNativeInteraction>();
  readonly #pendingNativeIds = new Map<string, string>();
  readonly #unconfirmedResponses = new Set<string>();
  readonly #interactionErrors = new Map<string, string>();
  #generationToken = 0;

  constructor(host: NativeClientChannelDependencies) {
    this.#host = host;
    this.#ownsAsyncQuestions = host.asyncQuestions === undefined;
    this.#asyncQuestions = host.asyncQuestions ?? new NativeAsyncQuestions();
  }

  noteThread(threadId: string): void {
    this.#knownThreads.add(threadId);
  }

  observeMessage(value: JsonValue): void {
    if (!isRecord(value) || typeof value.method !== "string") return;
    const params = isRecord(value.params) ? (value.params as JsonObject) : {};
    this.#items.observe(value.method, params);
    const asyncQuestionsChanged = this.#asyncQuestions.observe(value.method, params);
    const threadId = threadIdFromParams(params);
    if (threadId) {
      this.noteThread(threadId);
      if (value.method === "thread/settings/updated" && isJsonObject(params.threadSettings))
        this.#configuration.set(threadId, nativeThreadConfiguration(params.threadSettings));
      if (value.method === "thread/closed") this.#resumedThreads.delete(threadId);
      const endedTurn =
        value.method === "turn/completed" && isRecord(params.turn) ? params.turn.id : undefined;
      if (value.method === "thread/closed" || typeof endedTurn === "string") {
        for (const pending of this.#pending.values()) {
          if (
            pending.kind === "question" &&
            pending.threadId === threadId &&
            (value.method === "thread/closed" || pending.params.turnId === endedTurn)
          )
            this.#deletePending(pending.requestId);
        }
      }
      if (value.method === "turn/started") this.#interactionErrors.delete(threadId);
      this.#host.events.changed(threadId, value.method);
      if (asyncQuestionsChanged)
        this.#host.events.changed(threadId, "codexhost/thread/questions/updated");
    }
    if (value.method === "serverRequest/resolved") {
      const requestId = params.requestId;
      if (typeof requestId === "string" || typeof requestId === "number") {
        const publicId =
          this.#pendingNativeIds.get(requestKey(requestId)) ??
          (typeof requestId === "string" && this.#pending.has(requestId) ? requestId : undefined);
        if (publicId) {
          const pending = this.#pending.get(publicId);
          this.#deletePending(publicId);
          if (pending) this.#host.events.changed(pending.threadId, value.method);
        }
      }
      return;
    }
    if (typeof value.id !== "string" && typeof value.id !== "number") return;
    const interaction = nativeInteraction(value.method, params);
    if (!interaction) {
      if (this.#host.desktopConnected?.()) return;
      const message = `Web cannot answer official Codex request '${value.method}'. Open Codex Desktop to handle it.`;
      void this.#host.respond(value.id, null, { code: -32601, message }).catch(() => undefined);
      if (threadId) {
        this.#interactionErrors.set(threadId, message);
        this.#host.events.changed(threadId, "nativeInteractionError");
      }
      return;
    }
    if (!threadId) return;
    if (this.#pendingNativeIds.has(requestKey(value.id))) return;
    const publicId = `${NATIVE_REQUEST_PREFIX}${this.#generationToken}:${randomUUID()}`;
    this.#pending.set(publicId, {
      requestId: publicId,
      nativeRequestId: value.id,
      threadId,
      method: value.method,
      params,
      ...interaction,
    });
    this.#pendingNativeIds.set(requestKey(value.id), publicId);
  }

  #deletePending(publicId: string): void {
    const pending = this.#pending.get(publicId);
    if (!pending) return;
    this.#pending.delete(publicId);
    this.#pendingNativeIds.delete(requestKey(pending.nativeRequestId));
  }

  private observeResponse(method: string, params: JsonObject, reply: NativeClientReply): void {
    if ("error" in reply) return;
    const thread = resultThread(reply);
    const opensThread = ["thread/resume", "thread/start", "thread/fork"].includes(method);
    if (method === "thread/fork" && thread?.id === params.threadId) return;
    if (thread && typeof thread.id === "string") {
      this.noteThread(thread.id);
      if (opensThread) this.#resumedThreads.add(thread.id);
    }
    const threadId = threadIdFromParams(params);
    if (threadId) {
      this.noteThread(threadId);
      if (method === "thread/resume") this.#resumedThreads.add(threadId);
      if (method === "thread/archive") this.#resumedThreads.delete(threadId);
    }
    const configuredThreadId =
      typeof thread?.id === "string" ? thread.id : method === "thread/fork" ? undefined : threadId;
    if (opensThread && configuredThreadId) {
      const result = resultObject(reply);
      this.#configuration.set(configuredThreadId, nativeThreadConfiguration(result ?? {}));
      if (method === "thread/fork") this.#host.events.changed(configuredThreadId, method);
    }
    if (method === "thread/list") {
      const data = resultObject(reply)?.data;
      if (Array.isArray(data))
        for (const item of data)
          if (isRecord(item) && typeof item.id === "string") this.noteThread(item.id);
    }
  }

  async request(method: string, params: JsonObject): Promise<NativeClientReply> {
    const generation = this.#generationToken;
    const stale = (): NativeClientReply => ({
      error: {
        code: -32094,
        message:
          "Host generation changed; operation outcome may be unknown. Do not retry automatically.",
      },
    });
    const threadId = threadIdFromParams(params);
    if (method === "codexhost/thread/queue/send-now") {
      if (!threadId || typeof params.itemId !== "string" || !params.itemId)
        return { error: { code: -32602, message: "threadId and itemId are required" } };
      return sendNativeQueuedMessage(
        (method, params) =>
          generation === this.#generationToken
            ? this.request(method, params)
            : Promise.resolve(stale()),
        threadId,
        params.itemId,
      );
    }
    if (method === "codexhost/thread/inspect") {
      if (!threadId) return { error: { code: -32602, message: "threadId is required" } };
      if (!this.#configuration.has(threadId)) {
        await this.request("thread/resume", { threadId, excludeTurns: true });
      }
      return {
        result: jsonValueSchema.parse({
          owner: "codex",
          locked: false,
          ...this.#configuration.get(threadId),
          history: { fork: true, forkAcrossCwd: false, rollbackLastTurn: false },
        }),
      };
    }
    if (threadId && RESUME_BEFORE.has(method) && !this.#resumedThreads.has(threadId)) {
      const resumed = await this.#host.request("thread/resume", { threadId, excludeTurns: true });
      if (generation !== this.#generationToken) return stale();
      this.observeResponse("thread/resume", { threadId }, resumed);
      if ("error" in resumed) return resumed;
    }
    if (method === "turn/start" && params.delivery === "queue") {
      return submitNativeQueuedInput(
        (method, params) =>
          generation === this.#generationToken
            ? this.request(method, params)
            : Promise.resolve(stale()),
        params,
      );
    }
    let reply = await this.#host.request(
      method,
      method === "thread/resume" ? { ...params, excludeTurns: true } : params,
    );
    if (generation !== this.#generationToken) return stale();
    // Codex can expose the rollout path before its metadata is flushed. Retry
    // only this explicit read failure; persistent errors and writes stay intact.
    for (const delayMs of [50, 100, 200, 400]) {
      if (
        method !== "thread/read" ||
        !("error" in reply) ||
        reply.error.code !== -32603 ||
        !/^failed to read thread: thread-store internal error: failed to read session metadata ([\s\S]+): rollout at \1 is empty$/u.test(
          reply.error.message,
        )
      )
        break;
      await delay(delayMs);
      if (generation !== this.#generationToken) return stale();
      reply = await this.#host.request(method, params);
      if (generation !== this.#generationToken) return stale();
    }
    // A native Thread exists before its first user message materializes history.
    // Only that explicit initial-page response means empty history, not a failed read.
    if (
      method === "thread/turns/list" &&
      threadId &&
      (params.cursor === undefined || params.cursor === null) &&
      "error" in reply &&
      reply.error.code === -32600 &&
      reply.error.message ===
        `thread ${threadId} is not materialized yet; thread/turns/list is unavailable before first user message`
    )
      reply = { result: { data: [], nextCursor: null } };
    if (
      method === "thread/turns/list" &&
      threadId &&
      "result" in reply &&
      isJsonObject(reply.result)
    )
      reply = { result: this.#items.project(threadId, reply.result) };
    this.observeResponse(method, params, reply);
    if (threadId && CHANGED_METHODS.has(method) && !("error" in reply))
      this.#host.events.changed(threadId, method);
    return reply;
  }

  interactions(threadId: string): ClientInteraction[] {
    const prefix = `${NATIVE_REQUEST_PREFIX}${this.#generationToken}:`;
    return [...this.#pending.values()]
      .filter((pending) => pending.threadId === threadId)
      .map<ClientInteraction>((pending) => ({
        requestId: pending.requestId,
        threadId,
        kind: pending.kind,
        interaction: pending.interaction,
        request: { method: pending.method, params: pending.params },
      }))
      .concat(this.#asyncQuestions.interactions(threadId, prefix));
  }

  async snapshot(threadId: string, options: ClientSnapshotOptions): Promise<ClientThreadSnapshot> {
    const cursor = this.#host.events.cursor;
    const generation = this.#generationToken;
    const assertGeneration = () => {
      if (generation !== this.#generationToken)
        throw new ClientChannelRequestError(-32094, "Host generation changed; refresh the Thread");
    };
    try {
      let nativeSendError: string | undefined;
      if (!this.#resumedThreads.has(threadId)) {
        const resumed = await this.request("thread/resume", { threadId, excludeTurns: true });
        assertGeneration();
        if ("error" in resumed) {
          if (
            resumed.error.code === -32600 &&
            /^thread \S+ already has (?:an active writer|a live local writer)$/iu.test(
              resumed.error.message,
            )
          )
            nativeSendError = `${resumed.error.message}. 请先在另一端关闭此会话。`;
          else throw new ClientChannelRequestError(resumed.error.code, resumed.error.message);
        }
      }
      const read = await this.request("thread/read", { threadId, includeTurns: false });
      assertGeneration();
      if ("error" in read) throw new ClientChannelRequestError(read.error.code, read.error.message);
      const thread = resultThread(read);
      if (!thread || thread.id !== threadId)
        throw new Error("Native Codex did not return the requested Thread");
      if (typeof thread.modelProvider !== "string" || thread.modelProvider.length === 0)
        throw new Error("Native Codex Thread has no modelProvider");
      const turnsReply = await this.request("thread/turns/list", {
        threadId,
        limit: 5,
        sortDirection: "desc",
        itemsView: "full",
      });
      assertGeneration();
      if ("error" in turnsReply)
        throw new ClientChannelRequestError(turnsReply.error.code, turnsReply.error.message);
      const turnsResult = resultObject(turnsReply) ?? {};
      const data = Array.isArray(turnsResult.data) ? turnsResult.data : [];
      this.#asyncQuestions.observeTurns(threadId, data);
      const turnsPage = {
        data,
        nextCursor: typeof turnsResult.nextCursor === "string" ? turnsResult.nextCursor : null,
      };
      const activeTurnId = data.map(turnIdFromPage).find((id): id is string => id !== undefined);
      const configuration = this.#configuration.get(threadId);
      const nativeInteractionError = this.#interactionErrors.get(threadId);
      const snapshot = clientThreadSnapshotSchema.parse({
        cursor,
        ...(activeTurnId ? { activeTurnId } : {}),
        thread: {
          ...thread,
          turns: [],
          ...(nativeSendError ? { nativeSendError } : {}),
          ...(nativeInteractionError ? { nativeInteractionError } : {}),
        },
        turnsPage,
        // Only configuration confirmed by native resume or settings notifications is presented.
        configuration: configuration ?? {},
        interactions: this.interactions(threadId),
      });
      assertGeneration();
      return compactClientSnapshot(snapshot, options);
    } catch (error) {
      if (generation !== this.#generationToken)
        throw new ClientChannelRequestError(-32094, "Host generation changed; refresh the Thread");
      throw error;
    }
  }

  async respond(requestId: string | number, threadId: string, result: JsonValue): Promise<boolean> {
    const generation = this.#generationToken;
    const prefix = `${NATIVE_REQUEST_PREFIX}${generation}:`;
    if (typeof requestId === "string" && requestId.startsWith(`${prefix}async:`)) {
      try {
        return await this.#asyncQuestions.respond(
          requestId,
          threadId,
          result,
          prefix,
          (method, params) =>
            generation === this.#generationToken
              ? this.request(method, params)
              : Promise.resolve({
                  error: { code: -32094, message: "Host generation changed; refresh the Thread" },
                }),
        );
      } finally {
        this.#host.events.changed(threadId, "codexhost/thread/questions/updated");
      }
    }
    if (typeof requestId === "string" && this.#unconfirmedResponses.has(requestId))
      throw new Error("Native interaction delivery outcome is unknown; do not resend the response");
    const pending = typeof requestId === "string" ? this.#pending.get(requestId) : undefined;
    if (!pending) return false;
    if (pending.threadId !== threadId)
      throw new Error("Interaction does not belong to this Thread");
    const response = nativeResponse(pending, result);
    // Claim before delivery: a transport failure has an ambiguous outcome and
    // must not permit a second native writer to answer the request.
    this.#deletePending(pending.requestId);
    this.#unconfirmedResponses.add(pending.requestId);
    await this.#host.respond(pending.nativeRequestId, response);
    this.#unconfirmedResponses.delete(pending.requestId);
    this.#host.events.changed(pending.threadId, "serverRequest/resolved");
    return true;
  }

  resetGeneration(): void {
    const threads = [...this.#knownThreads];
    this.#generationToken += 1;
    this.#knownThreads.clear();
    this.#resumedThreads.clear();
    this.#pending.clear();
    this.#pendingNativeIds.clear();
    this.#unconfirmedResponses.clear();
    this.#interactionErrors.clear();
    this.#configuration.clear();
    this.#items.clear();
    if (this.#ownsAsyncQuestions) this.#asyncQuestions.clear();
    for (const threadId of threads) this.#host.events.changed(threadId, "thread/status/changed");
  }

  isNativeRequestId(value: string | number): value is string {
    return typeof value === "string" && value.startsWith(NATIVE_REQUEST_PREFIX);
  }

  isStaleRequestId(value: string | number): boolean {
    if (!this.isNativeRequestId(value)) return false;
    const prefix = `${NATIVE_REQUEST_PREFIX}${this.#generationToken}:`;
    return !value.startsWith(prefix);
  }
}
