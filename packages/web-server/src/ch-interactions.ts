import type { ClientInteraction, ClientThreadSnapshot } from "@codexhost/shared-contracts";
import type { ChHostClient } from "./ch-host-client.ts";
import type { EventHub } from "./transport.ts";

type Answer = { answers?: Array<{ id: string; selected?: string[]; custom?: string }> };
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
/** Translate the public Host's existing Codex UI response shape, not Harness SDK
 * protocols. The Host validates native options again and arbitrates with GUI. */
function presentation(pending: ClientInteraction): {
  questions: unknown[];
  result: (answer: unknown) => Record<string, unknown>;
} {
  const interaction = pending.interaction;
  if (interaction.type === "approval") {
    const labels = interaction.actions.map((action, index) =>
      interaction.actions.filter((other) => other.label === action.label).length > 1
        ? `${action.label} (${index + 1})`
        : action.label,
    );
    return {
      questions: [
        {
          id: "approval",
          header: interaction.title,
          question: [
            interaction.title,
            interaction.description,
            interaction.subject ? JSON.stringify(interaction.subject, null, 2) : undefined,
          ]
            .filter(Boolean)
            .join("\n\n"),
          options: labels.map((label) => ({ label })),
          multiSelect: false,
        },
      ],
      result(value) {
        const answer = (value as Answer | undefined)?.answers?.find(
          (entry) => entry.id === "approval",
        );
        if (value == null || (answer?.selected?.length === 0 && !answer.custom))
          return { action: "decline" };
        const action = interaction.actions[labels.indexOf(answer?.selected?.[0] ?? "")];
        if (!action || answer?.custom || answer?.selected?.length !== 1)
          throw new Error("Choose one of the native approval actions");
        const params = record(pending.request.params);
        if ("actionId" in record(record(params.requestedSchema).properties))
          return { action: "accept", content: { actionId: action.id } };
        if (action.effect === "deny") return { action: "decline" };
        if (action.effect === "allowOnce") return { action: "accept", content: {} };
        if (action.effect === "allowForSession" || action.effect === "allowAlways")
          return {
            action: "accept",
            content: {},
            _meta: { persist: action.effect === "allowAlways" ? "always" : "session" },
          };
        throw new Error("Host approval action is unsupported by this client version");
      },
    };
  }
  return {
    questions: interaction.questions.map((question) => ({
      id: question.id,
      question: question.prompt,
      ...(interaction.title ? { header: interaction.title } : {}),
      ...(question.type === "choice"
        ? {
            options: question.options.map((option) => ({
              label: option.label,
              description: option.description ?? "",
            })),
            multiSelect: question.multiple,
          }
        : {}),
    })),
    result(value) {
      const answers: Record<string, { answers: string[] }> = {};
      for (const answer of (value as Answer | undefined)?.answers ?? []) {
        const question = interaction.questions.find((question) => question.id === answer.id);
        if (!question) throw new Error("Unknown native question");
        if (question.type === "choice" && answer.custom && !question.allowOther)
          throw new Error("This native question only accepts its listed choices");
        answers[answer.id] = {
          answers: [...(answer.selected ?? []), ...(answer.custom ? [answer.custom] : [])],
        };
      }
      return { answers };
    },
  };
}

export class ChInteractions {
  private pending = new Map<string, { threadId: string; cancel: () => void }>();
  constructor(
    private readonly host: NonNullable<ChHostClient["realtime"]>,
    private readonly events: EventHub,
    private readonly error: (id: string, message: string | null) => void,
  ) {}
  update(snapshot: ClientThreadSnapshot): void {
    const threadId = String(snapshot.thread.id);
    if (!snapshot.interactions.length) this.error(threadId, null);
    const keys = new Set(
      snapshot.interactions.map((value) => `${snapshot.cursor.epoch}:${value.requestId}`),
    );
    for (const [key, pending] of this.pending)
      if (pending.threadId === threadId && !keys.has(key)) {
        this.pending.delete(key);
        pending.cancel();
      }
    for (const request of snapshot.interactions) {
      const key = `${snapshot.cursor.epoch}:${request.requestId}`;
      if (this.pending.has(key)) continue;
      const view = presentation(request);
      const invocation = this.events.invoke("user-questions/request", threadId, {
        questions: view.questions,
      });
      const pending = { threadId, cancel: invocation.cancel };
      this.pending.set(key, pending);
      void invocation.result.then(
        async (answer) => {
          if (this.pending.get(key) !== pending) return;
          try {
            await this.host.respond({
              epoch: snapshot.cursor.epoch,
              requestId: request.requestId,
              threadId,
              result: view.result(answer),
            });
            this.error(threadId, null);
          } catch (error) {
            this.error(
              threadId,
              error instanceof Error ? error.message : "Interaction response failed",
            );
            // Read-only reconciliation, never resend an answer after an unknown outcome.
            this.pending.delete(key);
            const current = await this.host.snapshot(threadId).catch(() => undefined);
            if (current) this.update(current);
          }
        },
        () => {},
      );
    }
  }
  clear(): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const value of pending) value.cancel();
  }
}
