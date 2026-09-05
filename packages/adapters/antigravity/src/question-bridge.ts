import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";

import {
  validateHostQuestionResponse,
  validateHostApprovalResponse,
  type HarnessOutput,
  type HarnessResult,
  type HostQuestionInteraction,
  type HostApprovalInteraction,
  type HostToolExecutionItem,
  type InteractionClosedEvent,
  type InteractionRespondAccepted,
  type InteractionRespondCommand,
} from "@codexhost/harness-adapter";
import {
  hostInteractionIdSchema,
  hostItemIdSchema,
  jsonValueSchema,
  type HostTurnId,
} from "@codexhost/shared-contracts";
import { z } from "zod";

import { ANTIGRAVITY_QUESTION_HOOK_CLIENT } from "./question-hook-client.js";

const MAX_BYTES = 131_072;
const QUESTION_TIMEOUT_MS = 10 * 60_000;
const EXPIRED_REASON =
  "The question expired without an answer. Do not claim the user skipped or selected an option.";
const nativeQuestionSchema = z
  .object({
    question: z.string().trim().min(1).max(8_000),
    options: z.array(z.string().trim().min(1).max(1_000)).max(30),
    is_multi_select: z.boolean().default(false),
  })
  .refine(({ options }) => new Set(options).size === options.length);
const requestSchema = z.object({
  conversationId: z.string().min(1).max(128),
  stepIdx: z.number().int().nonnegative(),
  toolCall: z.object({
    name: z.literal("ask_question"),
    args: z.object({ questions: z.array(nativeQuestionSchema).min(1).max(12) }),
  }),
});
const responseSchema = z
  .object({
    type: z.literal("question"),
    answers: z.record(z.string(), z.array(z.string().max(8_000)).max(30)),
    cancelled: z.boolean().optional(),
  })
  .strict();
const approvalRequestSchema = z.object({
  conversationId: z.string().min(1).max(128),
  stepIdx: z.number().int().nonnegative(),
  toolCall: z.object({
    name: z
      .string()
      .min(1)
      .max(256)
      .refine((name) => name !== "ask_question"),
    args: jsonValueSchema,
  }),
});
const approvalResponseSchema = z.strictObject({
  type: z.literal("approval"),
  actionId: z.string(),
});

interface BridgeOptions {
  turnId: HostTurnId;
  nativeSessionId(): string | undefined;
  schedule(action: () => void): void;
  emit(output: HarnessOutput): void;
  timeoutMs?: number;
  approvals?: boolean;
  ownsApprovalSession?(nativeSessionId: string): boolean;
}

interface PendingQuestion {
  interaction: HostQuestionInteraction | HostApprovalInteraction;
  item?: HostToolExecutionItem;
  response: ServerResponse;
  timer: NodeJS.Timeout;
  expiresAt: number;
}

function deny(response: ServerResponse, reason: string, status = 200, decision = "deny"): void {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { "content-type": "application/json", connection: "close" });
  response.end(JSON.stringify({ decision, reason }));
}

export class AntigravityQuestionBridge {
  readonly directory: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly #options: BridgeOptions;
  readonly #token = randomBytes(32).toString("hex");
  readonly #server = createServer({
    maxHeaderSize: 8192,
    headersTimeout: 5000,
    requestTimeout: 5000,
  });
  readonly #pending = new Map<string, PendingQuestion>();
  readonly #seenSteps = new Set<string>();
  #stopped = false;
  #disposal: Promise<void> | null = null;
  #hookCommand = "";

  private constructor(directory: string, options: BridgeOptions) {
    this.directory = directory;
    this.#options = options;
    this.environment = {
      CODEXHOST_AGY_QUESTION_TOKEN: this.#token,
      CODEXHOST_AGY_QUESTION_TIMEOUT_MS: String(options.timeoutMs ?? QUESTION_TIMEOUT_MS),
      CODEXHOST_AGY_QUESTION_APPROVALS: options.approvals ? "1" : "0",
    };
    this.#server.on("request", (request, response) => this.#receive(request, response));
  }

  static async create(options: BridgeOptions): Promise<AntigravityQuestionBridge> {
    const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-agy-question-"));
    const bridge = new AntigravityQuestionBridge(directory, options);
    try {
      await new Promise<void>((resolve, reject) => {
        bridge.#server.once("error", reject);
        bridge.#server.listen(0, "127.0.0.1", () => {
          bridge.#server.removeListener("error", reject);
          resolve();
        });
      });
      bridge.#server.on("error", () => bridge.stop());
      const address = bridge.#server.address();
      if (!address || typeof address === "string") throw new Error("Question bridge did not bind");
      bridge.environment.CODEXHOST_AGY_QUESTION_URL = `http://127.0.0.1:${address.port}/question`;
      const client = path.join(directory, "question-hook.cjs");
      await mkdir(path.join(directory, ".agents"));
      await writeFile(client, ANTIGRAVITY_QUESTION_HOOK_CLIENT, "utf8");
      const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
      // agy's Go exec escapes literal double quotes before cmd.exe sees them.
      // Expand quoted paths inside cmd instead; this also handles spaces.
      bridge.environment.CODEXHOST_AGY_QUESTION_NODE = `"${process.execPath.replaceAll("\\", "/")}"`;
      bridge.environment.CODEXHOST_AGY_QUESTION_CLIENT = `"${client.replaceAll("\\", "/")}"`;
      const command =
        process.platform === "win32"
          ? "%CODEXHOST_AGY_QUESTION_NODE% %CODEXHOST_AGY_QUESTION_CLIENT%"
          : `${quote(process.execPath)} ${quote(client)}`;
      bridge.#hookCommand = command;
      await writeFile(
        path.join(directory, ".agents", "hooks.json"),
        JSON.stringify({
          "codexhost-question-bridge": {
            PreToolUse: [
              {
                matcher: options.approvals ? ".*" : "^ask_question$",
                hooks: [
                  {
                    type: "command",
                    command,
                    timeout: Math.ceil((options.timeoutMs ?? QUESTION_TIMEOUT_MS) / 1000) + 15,
                  },
                ],
              },
            ],
          },
        }),
        "utf8",
      );
      return bridge;
    } catch (error) {
      await bridge.dispose();
      throw error;
    }
  }

  verifyApprovalHooks(stdout: string): boolean {
    if (!this.#options.approvals) return false;
    const hookSchema = z.object({
      event: z.literal("command_result"),
      command: z.object({
        name: z.literal("hooks"),
        data: z.object({
          hooks: z.array(
            z.object({
              name: z.string(),
              enabled: z.boolean(),
              source: z.string(),
              actions: z.array(
                z.object({
                  event: z.string(),
                  matcher: z.string(),
                  command: z.string(),
                }),
              ),
            }),
          ),
        }),
      }),
    });
    for (const line of stdout.split("\n")) {
      try {
        const parsed = hookSchema.safeParse(JSON.parse(line));
        if (!parsed.success) continue;
        return parsed.data.command.data.hooks.some(
          (hook) =>
            hook.name === "codexhost-question-bridge" &&
            hook.enabled &&
            path.resolve(hook.source) === path.join(this.directory, ".agents", "hooks.json") &&
            hook.actions.some(
              (action) =>
                action.event === "PreToolUse" &&
                action.matcher === ".*" &&
                action.command === this.#hookCommand,
            ),
        );
      } catch {
        /* Non-command lines cannot confirm installation. */
      }
    }
    return false;
  }

  #receive(request: IncomingMessage, response: ServerResponse): void {
    const auth = Buffer.from(request.headers.authorization ?? "");
    const expected = Buffer.from(`Bearer ${this.#token}`);
    if (
      request.method !== "POST" ||
      request.url !== "/question" ||
      request.headers.origin ||
      auth.length !== expected.length ||
      !timingSafeEqual(auth, expected)
    ) {
      deny(response, "Invalid question bridge request", 403);
      request.resume();
      return;
    }
    let body = "";
    let tooLarge = false;
    request.setEncoding("utf8");
    request.on("error", () => response.destroy());
    request.on("data", (chunk: string) => {
      if (tooLarge) return;
      body += chunk;
      if (Buffer.byteLength(body) > MAX_BYTES) {
        tooLarge = true;
        body = "";
        deny(response, "Question request exceeds the size limit", 413);
      }
    });
    request.on("end", () => {
      if (tooLarge || response.destroyed) return;
      let parsed;
      try {
        parsed = requestSchema.safeParse(JSON.parse(body));
      } catch {
        deny(response, "Invalid question payload", 400);
        return;
      }
      if (!parsed.success) {
        if (this.#options.approvals) {
          const approval = approvalRequestSchema.safeParse(JSON.parse(body));
          if (approval.success) {
            this.#options.schedule(() => this.#approve(approval.data, response));
            return;
          }
        }
        deny(response, "Invalid question payload", 400);
        return;
      }
      const payload = parsed.data;
      this.#options.schedule(() => this.#ask(payload, response));
    });
  }

  #approve(payload: z.infer<typeof approvalRequestSchema>, response: ServerResponse): void {
    if (
      this.#stopped ||
      response.destroyed ||
      (payload.conversationId !== this.#options.nativeSessionId() &&
        !this.#options.ownsApprovalSession?.(payload.conversationId))
    ) {
      deny(response, "Tool approval does not belong to the active codexhost Turn.");
      return;
    }
    if (payload.toolCall.name === "ask_permission") {
      deny(
        response,
        "Desktop approves actual tool actions. Call the intended tool directly instead of ask_permission.",
      );
      return;
    }
    const stepKey = `${payload.conversationId}:${payload.stepIdx}`;
    if (this.#seenSteps.has(stepKey) || this.#seenSteps.size >= 128) {
      deny(response, "Duplicate or overlapping tool approval. No permission was granted.");
      return;
    }
    this.#seenSteps.add(stepKey);
    const interaction: HostApprovalInteraction = {
      type: "approval",
      interactionId: hostInteractionIdSchema.parse(randomUUID()),
      turnId: this.#options.turnId,
      title: `Antigravity: ${payload.toolCall.name}`,
      description: `Tool: ${payload.toolCall.name}\nSession: ${payload.conversationId}\nArguments:\n${JSON.stringify(payload.toolCall.args, null, 2)}`,
      subject: { type: "nativeAction" },
      actions: [
        { id: "allow-once", label: "Allow once", effect: "allowOnce" },
        { id: "deny", label: "Deny", effect: "deny" },
      ],
    };
    const pending: PendingQuestion = {
      interaction,
      response,
      expiresAt: Date.now() + (this.#options.timeoutMs ?? QUESTION_TIMEOUT_MS),
      timer: setTimeout(() => {
        this.#finish(pending, "expired", "Tool approval expired. No permission was granted.");
      }, this.#options.timeoutMs ?? QUESTION_TIMEOUT_MS),
    };
    this.#pending.set(interaction.interactionId, pending);
    response.on("close", () => {
      if (!response.writableFinished) {
        this.#finish(
          pending,
          "cancelled",
          "Tool approval connection closed. No permission was granted.",
        );
      }
    });
    this.#options.emit({ kind: "interaction", interaction });
  }

  #ask(payload: z.infer<typeof requestSchema>, response: ServerResponse): void {
    if (
      this.#stopped ||
      response.destroyed ||
      payload.conversationId !== this.#options.nativeSessionId()
    ) {
      deny(
        response,
        "This question does not belong to the active codexhost Turn. No answer was received.",
      );
      return;
    }
    const stepKey = `${payload.conversationId}:${payload.stepIdx}`;
    if (this.#pending.size || this.#seenSteps.has(stepKey) || this.#seenSteps.size >= 128) {
      deny(response, "Duplicate or overlapping question request. Do not infer a user answer.");
      return;
    }
    // The current Desktop projector has no multi-select field.
    if (payload.toolCall.args.questions.some(({ is_multi_select }) => is_multi_select)) {
      deny(
        response,
        "codexhost currently supports single-choice or text questions, not multi-select. Ask separate single-choice questions instead.",
      );
      return;
    }
    this.#seenSteps.add(stepKey);
    const item: HostToolExecutionItem = {
      type: "toolExecution",
      itemId: hostItemIdSchema.parse(randomUUID()),
      toolName: "codexhost.ask_question",
      arguments: payload.toolCall.args,
    };
    const interaction: HostQuestionInteraction = {
      type: "question",
      interactionId: hostInteractionIdSchema.parse(randomUUID()),
      turnId: this.#options.turnId,
      itemId: item.itemId,
      title: "Antigravity",
      expiresAt: new Date(
        Date.now() + (this.#options.timeoutMs ?? QUESTION_TIMEOUT_MS),
      ).toISOString(),
      questions: payload.toolCall.args.questions.map((question, index) =>
        question.options.length
          ? {
              id: `q${index + 1}`,
              type: "choice",
              prompt: question.question,
              options: question.options.map((label) => ({ value: label, label })),
              multiple: false,
              allowOther: true,
              optional: false,
            }
          : {
              id: `q${index + 1}`,
              type: "text",
              prompt: question.question,
              multiline: false,
              secret: false,
              optional: false,
            },
      ),
    };
    const pending: PendingQuestion = {
      interaction,
      item,
      response,
      expiresAt: Date.parse(interaction.expiresAt ?? ""),
      timer: setTimeout(() => {
        this.#finish(pending, "expired", EXPIRED_REASON);
      }, this.#options.timeoutMs ?? QUESTION_TIMEOUT_MS),
    };
    this.#pending.set(interaction.interactionId, pending);
    response.on("close", () => {
      if (!response.writableFinished) {
        this.#finish(pending, "cancelled", "The question connection closed without an answer.");
      }
    });
    this.#options.emit({
      kind: "event",
      event: { type: "item.started", turnId: this.#options.turnId, item },
    });
    this.#options.emit({ kind: "interaction", interaction });
  }

  respond(command: InteractionRespondCommand): HarnessResult<InteractionRespondAccepted> {
    const pending = this.#pending.get(command.interactionId);
    if (!pending) {
      return {
        ok: false,
        error: { code: "invalidState", message: "Question is no longer active", retryable: false },
      };
    }
    if (Date.now() >= pending.expiresAt) {
      this.#finish(
        pending,
        "expired",
        pending.interaction.type === "approval"
          ? "Tool approval expired. No permission was granted."
          : EXPIRED_REASON,
      );
      return {
        ok: false,
        error: { code: "invalidState", message: "Question has expired", retryable: false },
      };
    }
    if (pending.interaction.type === "approval") {
      const parsed = approvalResponseSchema.safeParse(command.response);
      if (!parsed.success) {
        return {
          ok: false,
          error: { code: "invalidRequest", message: "Invalid Approval response", retryable: false },
        };
      }
      const error = validateHostApprovalResponse(pending.interaction, parsed.data);
      if (error) return { ok: false, error };
      const allowed = parsed.data.actionId === "allow-once";
      this.#finish(
        pending,
        "responded",
        allowed ? "User approved this tool call once." : "User denied this tool call.",
        allowed ? "allow" : "deny",
      );
      return { ok: true, value: { accepted: true } };
    }
    const parsed = responseSchema.safeParse(command.response);
    if (!parsed.success) {
      return {
        ok: false,
        error: { code: "invalidRequest", message: "Invalid Question response", retryable: false },
      };
    }
    const error = validateHostQuestionResponse(pending.interaction, {
      type: "question",
      answers: parsed.data.answers,
      ...(parsed.data.cancelled ? { cancelled: true } : {}),
    });
    if (error) return { ok: false, error };
    const result = parsed.data.cancelled
      ? { status: "cancelled", answers: {} }
      : {
          status: "answered",
          answers: pending.interaction.questions.map((question) => ({
            question: question.prompt,
            answers: parsed.data.answers[question.id] ?? [],
          })),
        };
    const reason =
      "codexhost handled this question through the Desktop. Native ask_question is blocked only to prevent automatic skipping. " +
      "The following JSON contains the actual user response, not a tool permission decision: " +
      JSON.stringify(result);
    if (Buffer.byteLength(reason) > MAX_BYTES / 2) {
      return {
        ok: false,
        error: {
          code: "invalidRequest",
          message: "Question answers exceed the size limit",
          retryable: false,
        },
      };
    }
    this.#finish(pending, parsed.data.cancelled ? "cancelled" : "responded", reason);
    return { ok: true, value: { accepted: true } };
  }

  #finish(
    pending: PendingQuestion,
    reason: InteractionClosedEvent["reason"],
    text: string,
    decision = "deny",
  ): void {
    if (!this.#pending.delete(pending.interaction.interactionId)) return;
    clearTimeout(pending.timer);
    deny(pending.response, text, 200, decision);
    this.#options.emit({
      kind: "event",
      event: {
        type: "interaction.closed",
        interactionId: pending.interaction.interactionId,
        turnId: this.#options.turnId,
        reason,
      },
    });
    if (pending.item)
      this.#options.emit({
        kind: "event",
        event: {
          type: "item.completed",
          turnId: this.#options.turnId,
          snapshot: {
            item: {
              ...pending.item,
              output: { content: [{ type: "text", text }], truncated: false },
            },
            outcome:
              reason === "responded"
                ? { status: "succeeded" }
                : { status: "cancelled", reason: text },
          },
        },
      });
  }

  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    for (const pending of this.#pending.values()) {
      this.#finish(
        pending,
        "cancelled",
        pending.interaction.type === "approval"
          ? "The codexhost Turn ended before tool approval. No permission was granted."
          : "The codexhost Turn ended before an answer was received. Do not infer a user choice.",
      );
    }
  }

  dispose(): Promise<void> {
    this.stop();
    this.#disposal ??= (async () => {
      await new Promise<void>((resolve) => {
        this.#server.close(() => resolve());
        this.#server.closeAllConnections();
      });
      // Only remove the private directory returned by mkdtemp for this bridge.
      await rm(this.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    })();
    return this.#disposal;
  }
}
