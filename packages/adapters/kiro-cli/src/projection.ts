import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import type {
  HostApprovalAction,
  HostApprovalInteraction,
  HostChoiceQuestion,
  HostCommandExecutionItem,
  HostQuestionInteraction,
  HostQuestionResponse,
  HostSubagentDelegationItem,
  HostSubagentState,
  HostTextQuestion,
  HostToolExecutionItem,
  HostToolOutput,
} from "@codexhost/harness-adapter";
import {
  hostInteractionIdSchema,
  hostItemIdSchema,
  type HostItemId,
  type HostTurnId,
  type JsonValue,
} from "@codexhost/shared-contracts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface KiroUserInputParams {
  sessionId: string;
  toolCallId?: string | undefined;
  question: string;
  options?: Array<{ title: string; description?: string | undefined }> | undefined;
}

export interface KiroUserInputResult {
  action: "answered" | "dismissed";
  answer?: string | undefined;
}

export interface ProjectedQuestion {
  interaction: HostQuestionInteraction;
  resolve(response: HostQuestionResponse): KiroUserInputResult;
}

export function projectKiroUserInput(
  interactionId: string,
  turnId: HostTurnId,
  params: KiroUserInputParams,
  itemId?: HostItemId,
): ProjectedQuestion {
  const hostInteractionId = hostInteractionIdSchema.parse(interactionId);
  const options = params.options;

  if (Array.isArray(options) && options.length > 0) {
    const choiceOptions = options.map((opt, index) => ({
      value: `opt-${index}`,
      label: opt.title,
      ...(opt.description ? { description: opt.description } : {}),
    }));

    const choiceQuestion: HostChoiceQuestion = {
      id: "q-0",
      type: "choice",
      prompt: params.question,
      options: choiceOptions,
      multiple: false,
      allowOther: false,
      optional: false,
    };

    const interaction: HostQuestionInteraction = {
      type: "question",
      interactionId: hostInteractionId,
      turnId,
      ...(itemId ? { itemId } : {}),
      title: "Question",
      questions: [choiceQuestion],
    };

    return {
      interaction,
      resolve: (response: HostQuestionResponse): KiroUserInputResult => {
        if (response.cancelled) {
          return { action: "dismissed" };
        }
        const answers = response.answers["q-0"];
        if (!answers || answers.length === 0) {
          return { action: "dismissed" };
        }
        const selectedValue = answers[0];
        const match = choiceOptions.find((opt) => opt.value === selectedValue);
        if (!match) {
          return { action: "dismissed" };
        }
        return { action: "answered", answer: match.label };
      },
    };
  }

  // Text question
  const textQuestion: HostTextQuestion = {
    id: "q-0",
    type: "text",
    prompt: params.question,
    multiline: false,
    secret: false,
    optional: false,
  };

  const interaction: HostQuestionInteraction = {
    type: "question",
    interactionId: hostInteractionId,
    turnId,
    ...(itemId ? { itemId } : {}),
    title: "Question",
    questions: [textQuestion],
  };

  return {
    interaction,
    resolve: (response: HostQuestionResponse): KiroUserInputResult => {
      if (response.cancelled) {
        return { action: "dismissed" };
      }
      const answers = response.answers["q-0"];
      if (!answers || answers.length === 0) {
        return { action: "dismissed" };
      }
      return { action: "answered", answer: answers[0] ?? "" };
    },
  };
}

export interface ProjectedApproval {
  interaction: HostApprovalInteraction;
  resolve(actionId: string, cancelled?: boolean): RequestPermissionResponse;
}

function consentResources(
  consent: Record<string, unknown>,
): Array<{ label: string; resource: string }> {
  if (!["shell", "exec", "shell:exec"].includes(String(consent.capability))) {
    return [{ label: "Entire tool (*)", resource: "*" }];
  }
  const resource = consent.triggeringResource ?? consent.resource;
  if (typeof resource !== "string" || !resource.trim() || resource.trim() === "*") {
    return [];
  }
  const resources = new Map<string, string>([[resource, `Exact command: ${resource}`]]);
  // Only suggest prefixes for simple commands; Kiro remains the policy parser and enforcer.
  const words = resource.trim().split(/\s+/u);
  const program = words[0];
  if (
    program &&
    /^[A-Za-z0-9_. -]+$/u.test(resource) &&
    words.length > 1 &&
    !["sudo", "doas", "env"].includes(program)
  ) {
    if (words.length > 2 && /^[A-Za-z][A-Za-z0-9_-]*$/u.test(words[1] ?? "")) {
      resources.set(`${program} ${words[1]} *`, `Command prefix: ${program} ${words[1]} *`);
    }
    resources.set(`${program} *`, `Program prefix: ${program} *`);
  }
  return [...resources].map(([resource, label]) => ({ label, resource }));
}

export function projectKiroPermission(
  interactionId: string,
  turnId: HostTurnId,
  request: RequestPermissionRequest,
): ProjectedApproval {
  const hostInteractionId = hostInteractionIdSchema.parse(interactionId);
  const options = request.options;
  const actions: HostApprovalAction[] = [];
  const scopedActions: HostApprovalAction[] = [];
  const responses = new Map<string, RequestPermissionResponse>();
  let description: string | undefined;
  const rawRequest = request as Record<string, unknown>;
  const meta = isRecord(rawRequest._meta)
    ? (rawRequest._meta as Record<string, unknown>)
    : undefined;
  const kiroMeta = meta && isRecord(meta.kiro) ? (meta.kiro as Record<string, unknown>) : undefined;

  if (kiroMeta && kiroMeta.type === "turn_approval") {
    description = "Review modified files for this turn";
  }
  const consent = kiroMeta && isRecord(kiroMeta.consent) ? kiroMeta.consent : undefined;
  const resources = consent ? consentResources(consent) : [];
  for (const option of options) {
    if (option.kind === "allow_once" || option.kind === "reject_once") {
      actions.push({
        id: option.optionId,
        label: option.name || option.optionId,
        effect: option.kind === "allow_once" ? "allowOnce" : "deny",
      });
      responses.set(option.optionId, {
        outcome: { outcome: "selected", optionId: option.optionId },
      });
    } else if (
      option.kind === "allow_always" &&
      consent &&
      typeof consent.capability === "string" &&
      consent.capability.trim() &&
      consent.persistableConsent !== false &&
      consent.askType !== "explicit"
    ) {
      for (const scope of ["session", "workspace"] as const) {
        if (
          scope === "workspace" &&
          (typeof consent.workspaceRoot !== "string" || !consent.workspaceRoot.trim())
        ) {
          continue;
        }
        const choices = scope === "session" ? resources.slice(0, 1) : resources;
        for (const [index, choice] of choices.entries()) {
          const id = `kiro-consent:${JSON.stringify([option.optionId, scope, index])}`;
          const scopeLabel = scope === "session" ? "this session" : "save for workspace";
          scopedActions.push({
            id,
            label: `Allow (${scopeLabel}) - ${choice.label}`,
            effect: scope === "session" ? "allowForSession" : "allowAlways",
          });
          responses.set(id, {
            outcome: { outcome: "selected", optionId: option.optionId },
            _meta: {
              kiro: {
                consent: {
                  capability: consent.capability,
                  scope,
                  resource: choice.resource,
                  ...(typeof consent.workspaceRoot === "string"
                    ? { workspaceRoot: consent.workspaceRoot }
                    : {}),
                },
              },
            },
          });
        }
      }
    }
  }
  // Keep policy administration out of a single tool approval.
  actions.push(...scopedActions);
  if (responses.size !== actions.length)
    throw new Error("Kiro returned duplicate approval action IDs");

  const interaction: HostApprovalInteraction = {
    type: "approval",
    interactionId: hostInteractionId,
    turnId,
    title: (request as { title?: string }).title || request.toolCall.title || "Permission Request",
    ...(description ? { description } : {}),
    subject: { type: "nativeAction" },
    actions,
  };

  return {
    interaction,
    resolve: (actionId: string, cancelled?: boolean): RequestPermissionResponse => {
      if (cancelled) {
        return { outcome: { outcome: "cancelled" } };
      }
      return responses.get(actionId) ?? { outcome: { outcome: "cancelled" } };
    },
  };
}

export type ProjectedToolItem =
  | HostToolExecutionItem
  | HostCommandExecutionItem
  | HostSubagentDelegationItem;

export function projectKiroToolCall(
  itemId: string,
  toolCall: {
    toolCallId: string;
    title?: string | null | undefined;
    name?: string | null | undefined;
    kind?: string | null | undefined;
    status?: string | null | undefined;
    rawInput?: unknown;
    rawOutput?: unknown;
    metadata?: Record<string, unknown> | undefined;
  },
): ProjectedToolItem {
  const hostItemId = hostItemIdSchema.parse(itemId);
  const meta = toolCall.metadata;
  const kiroMeta = meta && isRecord(meta.kiro) ? (meta.kiro as Record<string, unknown>) : undefined;

  // Subagent delegation
  if (kiroMeta && kiroMeta.kind === "agent-subtask") {
    const subtaskId = typeof kiroMeta.agentSubtaskId === "string" ? kiroMeta.agentSubtaskId : toolCall.toolCallId;
    const input = isRecord(toolCall.rawInput) ? toolCall.rawInput : {};
    const subagentState: HostSubagentState = {
      subagentId: subtaskId,
      description: typeof input.prompt === "string" ? input.prompt : "Subagent task",
      background: false,
      status: toolCall.status === "completed" ? "completed" : toolCall.status === "failed" ? "failed" : "running",
      ...(typeof input.name === "string" ? { role: input.name } : {}),
      ...(typeof toolCall.rawOutput === "string" ? { resultSummary: toolCall.rawOutput } : {}),
    };
    const subagentItem: HostSubagentDelegationItem = {
      type: "subagentDelegation",
      itemId: hostItemId,
      operation: "spawn",
      subagents: [subagentState],
    };
    return subagentItem;
  }

  // Command execution
  if (toolCall.kind === "execute" || (typeof toolCall.name === "string" && toolCall.name.toLowerCase().includes("execute"))) {
    let command = "execute";
    if (isRecord(toolCall.rawInput) && typeof toolCall.rawInput.command === "string") {
      command = toolCall.rawInput.command;
    }
    let exitCode: number | null | undefined;
    let output: string | undefined;
    if (isRecord(toolCall.rawOutput)) {
      if (typeof toolCall.rawOutput.exitCode === "number") {
        exitCode = toolCall.rawOutput.exitCode;
      }
      if (typeof toolCall.rawOutput.output === "string") {
        output = toolCall.rawOutput.output;
      }
    } else if (typeof toolCall.rawOutput === "string") {
      output = toolCall.rawOutput;
    }

    const commandItem: HostCommandExecutionItem = {
      type: "commandExecution",
      itemId: hostItemId,
      command,
      ...(exitCode !== undefined ? { exitCode } : {}),
      ...(output !== undefined ? { output } : {}),
    };
    return commandItem;
  }

  // General Tool Execution
  const output: HostToolOutput | undefined =
    toolCall.rawOutput !== undefined
      ? {
          content: [
            {
              type: "text",
              text:
                typeof toolCall.rawOutput === "string"
                  ? toolCall.rawOutput
                  : JSON.stringify(toolCall.rawOutput),
            },
          ],
        }
      : undefined;

  const toolItem: HostToolExecutionItem = {
    type: "toolExecution",
    itemId: hostItemId,
    toolName: toolCall.name || toolCall.title || "tool",
    arguments: (isRecord(toolCall.rawInput) ? toolCall.rawInput : {}) as JsonValue,
    ...(output !== undefined ? { output } : {}),
  };
  return toolItem;
}
