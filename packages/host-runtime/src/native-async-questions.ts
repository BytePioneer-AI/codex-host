import { randomUUID } from "node:crypto";
import type { JsonObject, JsonValue } from "@codexhost/protocol-core";
import type { ClientInteraction } from "@codexhost/shared-contracts";
import { ClientChannelRequestError } from "./client-channel-error.js";
import type { NativeClientReply } from "./native-client-channel.js";

type Question = Extract<
  ClientInteraction["interaction"],
  { type: "question" }
>["questions"][number];
type Pending = { threadId: string; question: Question };
const object = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const keyOf = (threadId: string, questionId: string) => JSON.stringify([threadId, questionId]);
const publicId = (prefix: string, pending: Pending) =>
  `${prefix}async:${keyOf(pending.threadId, pending.question.id)}`;

/** Async questions are native messages, not server requests waiting for a tool result.
 * Keep only a volatile interaction projection; native history remains authoritative. */
export class NativeAsyncQuestions {
  readonly #pending = new Map<string, Pending>();
  readonly #settled = new Map<string, Set<string>>();
  readonly #unconfirmed = new Set<string>();

  #settle(threadId: string, questionId: string): void {
    let settled = this.#settled.get(threadId);
    if (!settled) this.#settled.set(threadId, (settled = new Set()));
    settled.add(questionId);
    this.#pending.delete(keyOf(threadId, questionId));
  }

  #observeItem(threadId: string, item: JsonObject): void {
    if (item.type === "userMessage" && Array.isArray(item.content)) {
      for (const part of item.content) {
        if (!object(part) || part.type !== "text" || typeof part.text !== "string") continue;
        const match =
          /^\s*<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>\s*$/u.exec(
            part.text,
          );
        const body = match?.[1];
        if (body === undefined) continue;
        try {
          const replies: unknown = JSON.parse(body);
          if (!Array.isArray(replies)) continue;
          for (const reply of replies)
            if (
              object(reply) &&
              typeof reply.questionItemId === "string" &&
              typeof reply.answer === "string"
            )
              this.#settle(threadId, reply.questionItemId);
        } catch {
          // Ordinary or malformed user text cannot resolve a structured question.
        }
      }
    }
    if (
      item.type !== "agentMessage" ||
      item.delivery !== "async" ||
      typeof item.id !== "string" ||
      !Array.isArray(item.questions)
    )
      return;
    item.questions.forEach((value, index) => {
      if (!object(value) || typeof value.title !== "string" || !value.title.trim()) return;
      if (
        value.options !== undefined &&
        (!Array.isArray(value.options) ||
          value.options.some((option) => typeof option !== "string" || !option.trim()))
      )
        return;
      const id = JSON.stringify(["request_user_input_async", item.id, index]);
      if (this.#settled.get(threadId)?.has(id)) return;
      const options = (value.options ?? []) as string[];
      const question: Question = options.length
        ? {
            id,
            prompt: value.title,
            type: "choice",
            multiple: false,
            allowOther: true,
            options: options.map((label) => ({ value: label, label })),
          }
        : { id, prompt: value.title, type: "text" };
      this.#pending.set(keyOf(threadId, id), { threadId, question });
    });
  }

  observe(method: string, params: JsonObject): boolean {
    if (typeof params.threadId !== "string") return false;
    const before = this.#pending.size;
    if (method === "thread/closed") {
      this.#settled.delete(params.threadId);
      for (const [key, pending] of this.#pending)
        if (pending.threadId === params.threadId) this.#pending.delete(key);
    } else if ((method === "item/started" || method === "item/completed") && object(params.item)) {
      this.#observeItem(params.threadId, params.item);
    }
    return this.#pending.size !== before;
  }

  observeTurns(threadId: string, turns: JsonValue[]): void {
    for (const turn of turns)
      if (object(turn) && Array.isArray(turn.items))
        for (const item of turn.items) if (object(item)) this.#observeItem(threadId, item);
  }

  interactions(threadId: string, prefix: string): ClientInteraction[] {
    return [...this.#pending.values()]
      .filter(
        (pending) =>
          pending.threadId === threadId && !this.#unconfirmed.has(publicId(prefix, pending)),
      )
      .map((pending) => ({
        requestId: publicId(prefix, pending),
        threadId,
        kind: "question",
        interaction: { type: "question", questions: [pending.question] },
        request: {
          method: "request_user_input_async",
          params: { questionItemId: pending.question.id },
        },
      }));
  }

  async respond(
    requestId: string,
    threadId: string,
    result: JsonValue,
    prefix: string,
    request: (method: string, params: JsonObject) => Promise<NativeClientReply>,
  ): Promise<boolean> {
    if (this.#unconfirmed.has(requestId))
      throw new Error("Native interaction delivery outcome is unknown; do not resend the response");
    const pending = [...this.#pending.values()].find(
      (value) => publicId(prefix, value) === requestId,
    );
    if (!pending) return false;
    if (pending.threadId !== threadId)
      throw new Error("Interaction does not belong to this Thread");
    const answers = object(result) && object(result.answers) ? result.answers : undefined;
    const answer = answers?.[pending.question.id];
    if (
      !answers ||
      Object.keys(answers).length !== 1 ||
      !object(answer) ||
      !Array.isArray(answer.answers) ||
      answer.answers.length > 1 ||
      (answer.answers.length === 1 &&
        (typeof answer.answers[0] !== "string" || !answer.answers[0].trim()))
    )
      throw new Error("Provide one answer to the native async question");

    // The Web card encodes Skip as an empty answer list. Dismiss only this
    // volatile projection; no native answer or cancellation is submitted.
    if (answer.answers.length === 0) {
      this.#settle(threadId, pending.question.id);
      return true;
    }

    // Desktop may have answered since the card was rendered. Read before claiming;
    // concurrent Web responders then compete in one synchronous claim below.
    const page = await request("thread/turns/list", {
      threadId,
      limit: 5,
      sortDirection: "desc",
      itemsView: "full",
    });
    if ("error" in page) throw new ClientChannelRequestError(page.error.code, page.error.message);
    if (!object(page.result) || !Array.isArray(page.result.data))
      throw new Error("Codex returned an invalid Turn page");
    this.observeTurns(threadId, page.result.data);
    if (
      !this.#pending.has(keyOf(threadId, pending.question.id)) ||
      this.#unconfirmed.has(requestId)
    )
      return false;
    this.#unconfirmed.add(requestId);
    const active = page.result.data.find(
      (turn) => object(turn) && turn.status === "inProgress" && typeof turn.id === "string",
    );
    const text = `<send_user_message_question_reply>\n${JSON.stringify([
      {
        questionItemId: pending.question.id,
        question: pending.question.prompt,
        answer: answer.answers[0],
      },
    ])}\n</send_user_message_question_reply>\n`;
    const sent = await request(object(active) ? "turn/steer" : "turn/start", {
      threadId,
      ...(object(active) ? { expectedTurnId: active.id } : {}),
      input: [{ type: "text", text, text_elements: [] }],
      clientUserMessageId: randomUUID(),
    });
    if ("error" in sent) {
      // Native validation refusals did not accept input; a refreshed card can be answered again.
      // Transport and generation failures retain the claim because delivery is uncertain.
      if (sent.error.code === -32600 || sent.error.code === -32602)
        this.#unconfirmed.delete(requestId);
      throw new ClientChannelRequestError(sent.error.code, sent.error.message);
    }
    if (
      !object(sent.result) ||
      (object(active)
        ? sent.result.turnId !== active.id
        : !object(sent.result.turn) || typeof sent.result.turn.id !== "string")
    )
      throw new Error("Codex did not confirm the question reply; delivery outcome is unknown");
    this.#settle(threadId, pending.question.id);
    this.#unconfirmed.delete(requestId);
    return true;
  }

  clear(): void {
    this.#pending.clear();
    this.#settled.clear();
    this.#unconfirmed.clear();
  }
}
