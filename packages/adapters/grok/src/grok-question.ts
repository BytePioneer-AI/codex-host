import type { HostQuestionInteraction, HostQuestionResponse } from "@codexhost/harness-adapter";

export const GROK_ASK_USER_QUESTION_METHODS = [
  "_x.ai/ask_user_question",
  "x.ai/ask_user_question",
] as const;

export const GROK_EXIT_PLAN_MODE_METHODS = ["_x.ai/exit_plan_mode", "x.ai/exit_plan_mode"] as const;

/** Advertise Grok's native question RPCs. Do not set ACP elicitation.form; that drops ask_user_question. */
export const GROK_ACP_CLIENT_CAPABILITIES = {
  _meta: {
    "x.ai/ask_user_question": true,
    "x.ai/exit_plan_mode": true,
  },
} as const;

export interface GrokQuestionOption {
  label: string;
  description?: string;
}

export interface GrokNativeQuestion {
  question: string;
  header?: string;
  options: GrokQuestionOption[];
  multiSelect: boolean;
}

export interface GrokQuestionRequest {
  sessionId?: string;
  questions: GrokNativeQuestion[];
  timeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const field = value[key];
    if (typeof field === "string" && field.length > 0) return field;
  }
  return undefined;
}

function optionalTimeoutMs(value: Record<string, unknown>): number | undefined {
  for (const key of ["timeoutMs", "timeout_ms", "timeoutSecs", "timeout_secs"]) {
    const field = value[key];
    if (typeof field === "number" && Number.isFinite(field) && field > 0) {
      return key.endsWith("secs") || key.endsWith("Secs") ? field * 1000 : field;
    }
  }
  return undefined;
}

export function isGrokAskUserQuestionMethod(method: string): boolean {
  return (GROK_ASK_USER_QUESTION_METHODS as readonly string[]).includes(method);
}

export function isGrokExitPlanModeMethod(method: string): boolean {
  return (GROK_EXIT_PLAN_MODE_METHODS as readonly string[]).includes(method);
}

function questionsPayload(params: Record<string, unknown>): unknown {
  if (Array.isArray(params.questions)) return params.questions;
  if (isRecord(params.input) && Array.isArray(params.input.questions))
    return params.input.questions;
  if (isRecord(params.askUserQuestion) && Array.isArray(params.askUserQuestion.questions)) {
    return params.askUserQuestion.questions;
  }
  return undefined;
}

function parseOption(value: unknown, labels: Set<string>): GrokQuestionOption | null {
  if (!isRecord(value)) return null;
  const label = stringField(value, "label");
  if (!label || labels.has(label)) return null;
  labels.add(label);
  const description = stringField(value, "description");
  const preview = stringField(value, "preview");
  const combined = [description, preview].filter((part): part is string => part !== undefined);
  return {
    label,
    ...(combined.length > 0 ? { description: combined.join("\n\n") } : {}),
  };
}

function parseQuestion(value: unknown, questions: Set<string>): GrokNativeQuestion | null {
  if (!isRecord(value)) return null;
  const question = stringField(value, "question");
  if (!question || questions.has(question)) return null;
  if (!Array.isArray(value.options) || value.options.length === 0) return null;
  const labels = new Set<string>();
  const options: GrokQuestionOption[] = [];
  for (const option of value.options) {
    const parsed = parseOption(option, labels);
    if (!parsed) return null;
    options.push(parsed);
  }
  questions.add(question);
  const header = stringField(value, "header");
  return {
    question,
    ...(header ? { header } : {}),
    options,
    multiSelect: value.multiSelect === true || value.multi_select === true,
  };
}

export function parseGrokAskUserQuestionParams(params: unknown): GrokQuestionRequest | null {
  if (!isRecord(params)) return null;
  const rawQuestions = questionsPayload(params);
  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) return null;
  const seen = new Set<string>();
  const questions: GrokNativeQuestion[] = [];
  for (const value of rawQuestions) {
    const parsed = parseQuestion(value, seen);
    if (!parsed) return null;
    questions.push(parsed);
  }
  const sessionId = stringField(params, "sessionId", "session_id");
  const timeoutMs = optionalTimeoutMs(params);
  return {
    questions,
    ...(sessionId ? { sessionId } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };
}

export function grokQuestionId(index: number): string {
  return `question-${index + 1}`;
}

export function createGrokQuestionInteraction(
  request: GrokQuestionRequest,
  interactionId: HostQuestionInteraction["interactionId"],
  turnId: HostQuestionInteraction["turnId"],
  nowMs = Date.now(),
): HostQuestionInteraction {
  const first = request.questions[0];
  const title =
    request.questions.length === 1 ? (first?.header ?? first?.question ?? "Grok") : "Grok";
  return {
    type: "question",
    interactionId,
    turnId,
    title,
    questions: request.questions.map((question, index) => ({
      id: grokQuestionId(index),
      type: "choice",
      prompt: question.question,
      options: question.options.map((option) => ({
        value: option.label,
        label: option.label,
        ...(option.description ? { description: option.description } : {}),
      })),
      multiple: question.multiSelect,
      allowOther: true,
      optional: false,
    })),
    ...(request.timeoutMs !== undefined
      ? { expiresAt: new Date(nowMs + request.timeoutMs).toISOString() }
      : {}),
  };
}

export function grokSkipInterviewResponse(): Record<string, unknown> {
  return { outcome: "skip_interview" };
}

export function grokAskUserQuestionResponse(
  request: GrokQuestionRequest,
  response: HostQuestionResponse,
): Record<string, unknown> {
  if (response.cancelled) return grokSkipInterviewResponse();
  const answers: Record<string, string | string[]> = {};
  for (const [index, question] of request.questions.entries()) {
    const selected = response.answers[grokQuestionId(index)] ?? [];
    answers[question.question] =
      question.multiSelect || selected.length !== 1 ? selected : (selected[0] ?? "");
  }
  return {
    outcome: "accepted",
    answers,
    annotations: {},
  };
}
