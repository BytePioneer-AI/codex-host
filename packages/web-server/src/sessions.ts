/** Web protocol gateway over the shared isolated-session implementation. */
import { IsolatedSessions, SessionRuntimeError } from "@codexhost/session-runtime";
import type { SessionNotification, SessionDataStore } from "@codexhost/session-runtime";
import type { HarnessRegistry } from "./harnesses.ts";
import { type EventHub, type RpcRegistry, type StreamRegistry } from "./transport.ts";
import type { Workspaces } from "./workspaces.ts";
export type { SessionNotification };
export { SessionRuntimeError };

export function bridgeSessionInteraction(
  events: EventHub,
  sessionId: string,
  interaction: Record<string, unknown> & { type: string },
): { result: Promise<unknown>; cancel(): void } {
  if (interaction.type === "approval") {
    const actions = interaction.actions as Array<{ id: string; label: string; effect: string }>;
    const allow =
      actions.find((action) => action.effect === "allowOnce") ??
      actions.find((action) => action.effect !== "deny");
    const deny = actions.find((action) => action.effect === "deny");
    const title = String(interaction.title ?? "Approval required");
    const description =
      typeof interaction.description === "string" ? interaction.description : undefined;
    const invocation = events.invoke("approval/request", sessionId, {
      toolName: title,
      reason: description === undefined ? title : `${title}\n\n${description}`,
      displayReason: { en: description === undefined ? title : `${title}\n\n${description}` },
    });
    const result = new Promise<unknown>((resolve, reject) => {
      invocation.result.then((value) => {
        const action = value === "allowed-once" ? allow : deny;
        if (action !== undefined) resolve({ type: "approval", actionId: action.id });
        else
          reject(
            new SessionRuntimeError(
              "session/interaction-invalid",
              "Approval does not offer a matching action",
            ),
          );
      }, reject);
    });
    return { result, cancel: invocation.cancel };
  }
  if (interaction.type === "question") {
    const questions = interaction.questions as Array<
      | {
          id: string;
          type: "choice";
          prompt: string;
          options: Array<{ value: string; label: string; description?: string }>;
          multiple: boolean;
          allowOther: boolean;
        }
      | { id: string; type: "text"; prompt: string }
    >;
    const items = questions.map((question) =>
      question.type === "choice"
        ? {
            id: question.id,
            question: question.prompt,
            ...(typeof interaction.title === "string" ? { header: interaction.title } : {}),
            options: question.options.map((option) => ({
              label: option.label,
              ...(option.description === undefined ? {} : { description: option.description }),
            })),
            multiSelect: question.multiple,
          }
        : { id: question.id, question: question.prompt },
    );
    const invocation = events.invoke("user-questions/request", sessionId, {
      questions: items,
    });
    const result = new Promise<unknown>((resolve, reject) => {
      invocation.result.then((value) => {
        const answer = value as
          { answers?: Array<{ id: string; selected: string[]; custom?: string }> } | undefined;
        const answers: Record<string, string[]> = {};
        for (const question of questions) {
          const item = answer?.answers?.find((entry) => entry.id === question.id);
          if (item === undefined) continue;
          const values =
            question.type === "choice"
              ? item.selected.map(
                  (label) =>
                    question.options.find((option) => option.label === label)?.value ?? label,
                )
              : [];
          if (item.custom !== undefined && item.custom !== "") values.push(item.custom);
          answers[question.id] = values;
        }
        resolve({ type: "question", answers });
      }, reject);
    });
    return { result, cancel: invocation.cancel };
  }
  throw new Error("Unsupported session interaction");
}

export class Sessions extends IsolatedSessions {
  constructor(
    data: SessionDataStore,
    harnesses: HarnessRegistry,
    workspaces: Workspaces,
    events: EventHub,
  ) {
    super(data, harnesses, workspaces, {
      changed: (kind, ...args) => events.emit(kind, ...args),
      interaction: (id, value) => bridgeSessionInteraction(events, id, value),
    });
  }

  register(rpc: RpcRegistry, streams: StreamRegistry): void {
    rpc.register("session/list", () => this.list());
    rpc.register("session/create", (args) => this.createRequest(args));
    rpc.register("session/modelCatalog", () => this.modelCatalog());
    rpc.register("session/selectModel", (args) => this.selectModel(args));
    rpc.register("session/prompt", (args) => this.prompt(args));
    rpc.register("session/cancel", (args) => this.cancel(args));
    rpc.register("session/updateQueue", (args) => this.updateQueue(args));
    rpc.register("session/rename", (args) => this.rename(args));
    rpc.register("session/fork", (args) => this.forkRequest(args));
    rpc.register("session/search", (args) => this.search(args));
    rpc.register("session/page", (args) => this.page(args));
    rpc.register("session/projections", (args) => this.projections(args));
    rpc.register("session/workspacePathApplications", () => ({ applications: [] }));
    rpc.register("session/openWorkspacePath", () => {
      throw new SessionRuntimeError(
        "session/open-unavailable",
        "Opening host paths is not available from the Web UI",
      );
    });
    streams.register("session/follow", (args, sink) => this.follow(args, sink));
    streams.register("session/control", (args, sink) => this.control(args, sink));
  }

  registerImport(rpc: RpcRegistry): void {
    rpc.register("codexhost/importSources", () => this.importSources());
    rpc.register("codexhost/importCandidates", (args) => this.importCandidatesRequest(args));
    rpc.register("codexhost/import", (args) => this.importNativeRequest(args));
  }

  registerCommands(rpc: RpcRegistry): void {
    rpc.register("commands/list", (args) => this.commandsList(args));
    rpc.register("commands/execute", (args) => this.commandsExecute(args));
    rpc.register("permissionPresets/catalog", (args) => this.permissionCatalogRequest(args));
  }
}
