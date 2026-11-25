import type { ClientInteraction, ClientThreadSnapshot } from "@codexhost/shared-contracts";
import type { ChHostClient } from "./ch-host-client.ts";
import type { EventHub } from "./transport.ts";

type Answer = { answers?: Array<{ id: string; selected?: string[]; custom?: string }> };
type ApprovalEffect = "allowOnce" | "allowForSession" | "allowAlways" | "deny";
type ApprovalFile = { path: string; diff?: string; kind?: "add" | "update" | "delete" };

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function nonEmptyText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function commandText(value: unknown): string | undefined {
  const direct = nonEmptyText(value);
  if (direct !== undefined) return direct;
  if (Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === "string"))
    return value.map((entry) => (/\s/u.test(entry) ? JSON.stringify(entry) : entry)).join(" ");
  return undefined;
}

function fileChangeKind(value: unknown): ApprovalFile["kind"] {
  const type = typeof value === "string" ? value : record(value).type;
  if (type === "add" || type === "create") return "add";
  if (type === "delete") return "delete";
  if (type === "update" || type === "modify" || type === "edit") return "update";
  return undefined;
}

function normalizeEffect(effect: string): ApprovalEffect {
  if (effect === "deny" || effect === "allowForSession" || effect === "allowAlways") return effect;
  return "allowOnce";
}

function findCorrelatedItem(
  snapshot: ClientThreadSnapshot | undefined,
  itemId: string | undefined,
): Record<string, unknown> | undefined {
  if (!itemId || !snapshot) return undefined;
  const turnLists = [snapshot.turnsPage?.data, snapshot.thread?.turns];
  for (const turns of turnLists) {
    if (!Array.isArray(turns)) continue;
    for (const turn of turns) {
      if (!Array.isArray(turn.items)) continue;
      for (const item of turn.items) {
        if (item.id === itemId) return item as Record<string, unknown>;
      }
    }
  }
  return undefined;
}

function extractApprovalFiles(
  params: Record<string, unknown>,
  subject: Record<string, unknown>,
  item: Record<string, unknown> | undefined,
): ApprovalFile[] {
  const rawChanges = params.changes ?? subject.changes ?? item?.changes;
  const files: ApprovalFile[] = [];
  const seen = new Set<string>();
  const pushFile = (path: string | undefined, diff?: string, kind?: ApprovalFile["kind"]) => {
    if (!path) return;
    const key = `${path}\0${diff ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    files.push({
      path,
      ...(diff ? { diff } : {}),
      ...(kind ? { kind } : {}),
    });
  };
  if (Array.isArray(rawChanges)) {
    for (const entry of rawChanges) {
      const candidate = record(entry);
      const path = nonEmptyText(candidate.path) ?? nonEmptyText(candidate.file_path);
      const diff = nonEmptyText(candidate.diff) ?? nonEmptyText(candidate.unifiedDiff);
      pushFile(path, diff, fileChangeKind(candidate.kind));
    }
  } else if (rawChanges && typeof rawChanges === "object") {
    for (const [path, entry] of Object.entries(record(rawChanges))) {
      const candidate = record(entry);
      const diff = nonEmptyText(candidate.diff) ?? nonEmptyText(candidate.unifiedDiff);
      pushFile(nonEmptyText(path), diff, fileChangeKind(candidate.kind));
    }
  }
  if (files.length === 0) {
    const fallbackPaths = [
      ...(Array.isArray(params.paths) ? params.paths.map(nonEmptyText) : []),
      ...(Array.isArray(subject.paths) ? subject.paths.map(nonEmptyText) : []),
      nonEmptyText(params.grantRoot),
    ];
    for (const path of fallbackPaths) pushFile(path);
  }
  return files;
}

/** Translate the public Host's existing Codex UI response shape, not Harness SDK
 * protocols. The Host validates native options again and arbitrates with GUI. */
function presentation(
  pending: ClientInteraction,
  snapshot?: ClientThreadSnapshot,
): {
  questions: unknown[];
  result: (answer: unknown) => Record<string, unknown>;
} {
  const interaction = pending.interaction;
  if (interaction.type === "approval") {
    const isCommandApproval = pending.request.method === "item/commandExecution/requestApproval";
    const isFileApproval = pending.request.method === "item/fileChange/requestApproval";
    const nativeApproval = isCommandApproval || isFileApproval;
    const params = record(pending.request.params);
    const subject = record(interaction.subject);
    const item = findCorrelatedItem(
      snapshot,
      nonEmptyText(params.itemId) ?? nonEmptyText(subject.itemId),
    );
    const command = isCommandApproval
      ? (commandText(params.command) ?? commandText(subject.command) ?? commandText(item?.command))
      : undefined;
    const files = isFileApproval ? extractApprovalFiles(params, subject, item) : [];
    const toolLabel = isCommandApproval ? "bash" : isFileApproval ? "files" : undefined;
    const labels = interaction.actions.map((action, index) =>
      interaction.actions.filter((other) => other.label === action.label).length > 1
        ? `${action.label} (${index + 1})`
        : action.label,
    );
    return {
      questions: [
        {
          id: "approval",
          question: interaction.title,
          ...(!nativeApproval && interaction.description
            ? { detail: interaction.description }
            : {}),
          options: labels.map((label) => ({ label })),
          multiSelect: false,
          allowOther: false,
          intent: {
            kind: "approval",
            ...(toolLabel ? { toolLabel } : {}),
            ...(command ? { command } : {}),
            ...(files.length > 0 ? { files } : {}),
            actions: interaction.actions.map((action, index) => ({
              label: labels[index] ?? action.label,
              effect: normalizeEffect(action.effect),
            })),
          },
        },
      ],
      result(value) {
        const answer = (value as Answer | undefined)?.answers?.find(
          (entry) => entry.id === "approval",
        );
        if (value == null || (answer?.selected?.length === 0 && !answer.custom)) {
          if (nativeApproval) {
            const deny =
              interaction.actions.find((action) => action.id === "decline") ??
              interaction.actions.find((action) => action.id === "cancel");
            if (!deny) throw new Error("Choose one of the native approval actions");
            return { decision: deny.id };
          }
          return { action: "decline" };
        }
        const action = interaction.actions[labels.indexOf(answer?.selected?.[0] ?? "")];
        if (!action || answer?.custom || answer?.selected?.length !== 1)
          throw new Error("Choose one of the native approval actions");
        if (nativeApproval) return { decision: action.id };
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
            allowOther: question.allowOther,
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
  private pending = new Map<string, { sessionId: string; threadId: string; cancel: () => void }>();
  private sessionVersions = new Map<string, number>();
  private sessionEpochs = new Map<string, string>();
  private clearVersion = 0;
  constructor(
    private readonly host: NonNullable<ChHostClient["realtime"]>,
    private readonly events: EventHub,
    private readonly error: (sessionId: string, message: string | null) => void,
  ) {}
  update(snapshot: ClientThreadSnapshot, sessionId = String(snapshot.thread.id)): void {
    const threadId = String(snapshot.thread.id);
    const epoch = snapshot.cursor.epoch;
    const previousEpoch = this.sessionEpochs.get(sessionId);
    if (previousEpoch !== undefined && previousEpoch !== epoch) {
      this.bumpSessionVersion(sessionId);
    }
    this.sessionEpochs.set(sessionId, epoch);
    const message = snapshot.thread.nativeInteractionError ?? snapshot.thread.nativeSendError;
    if (typeof message === "string") this.error(sessionId, message);
    else if (!snapshot.interactions.length) this.error(sessionId, null);
    const keyOf = (requestId: string | number) => JSON.stringify([sessionId, epoch, requestId]);
    const keys = new Set(snapshot.interactions.map((value) => keyOf(value.requestId)));
    for (const [key, pending] of this.pending)
      if (pending.sessionId === sessionId && !keys.has(key)) {
        this.pending.delete(key);
        pending.cancel();
      }
    for (const request of snapshot.interactions) {
      const key = keyOf(request.requestId);
      if (this.pending.has(key)) continue;
      const view = presentation(request, snapshot);
      const invocation = this.events.invoke("user-questions/request", sessionId, {
        questions: view.questions,
      });
      const pending = { sessionId, threadId, cancel: invocation.cancel };
      const clearVersion = this.clearVersion;
      const sessionVersion = this.sessionVersions.get(sessionId) ?? 0;
      const isCurrent = () =>
        this.clearVersion === clearVersion &&
        (this.sessionVersions.get(sessionId) ?? 0) === sessionVersion &&
        this.sessionEpochs.get(sessionId) === epoch;
      this.pending.set(key, pending);
      void invocation.result.then(
        async (answer) => {
          if (this.pending.get(key) !== pending || !isCurrent()) return;
          try {
            await this.host.respond({
              epoch,
              requestId: request.requestId,
              threadId,
              result: view.result(answer),
            });
            if (isCurrent()) this.error(sessionId, null);
          } catch (error) {
            if (this.pending.get(key) === pending) this.pending.delete(key);
            if (!isCurrent()) return;
            this.error(
              sessionId,
              error instanceof Error ? error.message : "Interaction response failed",
            );
            // Read-only reconciliation, never resend an answer after an unknown outcome.
            const current = await this.host.snapshot(threadId).catch(() => undefined);
            if (current && isCurrent() && current.cursor.epoch === epoch) {
              this.update(current, sessionId);
            }
          }
        },
        () => {},
      );
    }
  }
  clearSession(sessionId: string): void {
    this.bumpSessionVersion(sessionId);
    this.sessionEpochs.delete(sessionId);
    for (const [key, value] of this.pending) {
      if (value.sessionId === sessionId) {
        this.pending.delete(key);
        value.cancel();
      }
    }
  }
  clear(): void {
    this.clearVersion++;
    this.sessionVersions.clear();
    this.sessionEpochs.clear();
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const value of pending) value.cancel();
  }
  private bumpSessionVersion(sessionId: string): void {
    this.sessionVersions.set(sessionId, (this.sessionVersions.get(sessionId) ?? 0) + 1);
  }
}
