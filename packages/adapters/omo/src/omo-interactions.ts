/**
 * Mapping between OmO's `extension_ui_request` dialogs and the public Host
 * Interaction contract, plus the native answer for a Host response.
 *
 * OmO has two dialog families on the classic RPC transport:
 *
 * - Permission prompts arrive as `method: "select"` with a title such as
 *   `Permission required: write` and a `toolCallId` naming the approved call.
 *   The options are `Allow once`, `Allow always`, `Deny`, and
 *   `Deny with feedback`; choosing feedback raises one follow-up `input`
 *   dialog bound to the same `toolCallId`. They map to
 *   {@link HostApprovalInteraction}. OmO has no session-scoped or permanent
 *   approval, so the only effects offered are `allowOnce`, `allowAlways` and
 *   `deny`.
 * - Every other dialog (`select` without a permission shape, `confirm`,
 *   `input`, `editor`) maps to {@link HostQuestionInteraction}. The
 *   capability-gated `question` method is never announced by this adapter
 *   (see omo-rpc-session.ts), so the engine uses its sequential fallback
 *   instead and this module never sees it.
 *
 * The native answer keeps the Host decision and the native protocol distinct:
 * an approval action ID is validated against the interaction, then translated
 * back to the exact native option string OmO offered. Display labels are never
 * sent as protocol values.
 *
 * This module is pure: it reads one frame, builds the Host Interaction, and
 * turns one validated Host response into a native payload. Timers, pending
 * maps, and the single-close rule belong to omo-session.ts.
 */

import type {
  HarnessError,
  HostApprovalAction,
  HostApprovalEffect,
  HostApprovalInteraction,
  HostInteractionResponse,
  HostQuestion,
  HostQuestionInteraction,
} from "@codexhost/harness-adapter";
import { validateHostInteractionResponse } from "@codexhost/harness-adapter";
import type { HostInteractionId, HostItemId, HostTurnId } from "@codexhost/shared-contracts";

/** Dialog methods that block the engine until the client answers. */
export type OmoDialogMethod = "select" | "confirm" | "input" | "editor";

const OMO_DIALOG_METHODS: ReadonlySet<string> = new Set(["select", "confirm", "input", "editor"]);

/** A type-checked view of one dialog-shaped `extension_ui_request`. */
export interface OmoDialogRequest {
  readonly id: string;
  readonly method: OmoDialogMethod;
  readonly title: string;
  readonly message: string | null;
  readonly options: readonly string[];
  readonly toolCallId: string | null;
  readonly timeoutMs: number | null;
  readonly placeholder: string | null;
  readonly prefill: string | null;
}

interface OmoApprovalMapping {
  readonly actionId: string;
  readonly label: string;
  readonly effect: HostApprovalEffect;
  /** True for "Deny with feedback": the engine raises a follow-up input dialog. */
  readonly feedback: boolean;
  readonly matches: (label: string) => boolean;
}

/**
 * The permission options OmO documents, matched case-insensitively on the
 * whole label. "Deny with feedback" is tried before "Deny" so the longer label
 * wins.
 */
const OMO_APPROVAL_MAPPINGS: readonly OmoApprovalMapping[] = [
  {
    actionId: "allow-once",
    label: "Allow once",
    effect: "allowOnce",
    feedback: false,
    matches: (label) => normalizeLabel(label) === "allow once",
  },
  {
    actionId: "allow-always",
    label: "Allow always",
    effect: "allowAlways",
    feedback: false,
    matches: (label) => normalizeLabel(label) === "allow always",
  },
  {
    actionId: "deny-with-feedback",
    label: "Deny with feedback",
    effect: "deny",
    feedback: true,
    matches: (label) => normalizeLabel(label) === "deny with feedback",
  },
  {
    actionId: "deny",
    label: "Deny",
    effect: "deny",
    feedback: false,
    matches: (label) => normalizeLabel(label) === "deny",
  },
];

const OMO_APPROVAL_TITLE = /^permission required:/iu;

function normalizeLabel(label: string): string {
  return label.trim().replace(/\s+/gu, " ").toLowerCase();
}

/** One offered native option paired with the Host action that selects it. */
interface OmoApprovalChoice {
  readonly action: HostApprovalAction;
  readonly nativeValue: string;
  readonly feedback: boolean;
}

export type OmoInteractionPlan =
  | {
      readonly kind: "approval";
      readonly interaction: HostApprovalInteraction;
      readonly nativeRequestId: string;
      readonly approvalChoices: readonly OmoApprovalChoice[];
    }
  | {
      readonly kind: "question";
      readonly interaction: HostQuestionInteraction;
      readonly nativeRequestId: string;
      readonly nativeMethod: OmoDialogMethod;
    };

/** A native `extension_ui_response` payload without its request id. */
export type OmoNativeInteractionAnswer =
  { readonly value: string } | { readonly confirmed: boolean } | { readonly cancelled: true };

export type OmoInteractionAnswer =
  { readonly answer: OmoNativeInteractionAnswer } | { readonly error: HarnessError };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function stringOptionList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((option): option is string => typeof option === "string");
}

function positiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Reads one `extension_ui_request` frame as a dialog. Fire-and-forget methods
 * (`notify`, `setStatus`, `setWidget`, `setTitle`, `set_editor_text`,
 * `setSubagentCost`) and unknown methods return null, as does a frame without a
 * usable request id. The session ignores those without answering natively.
 */
export function readOmoDialogRequest(frame: unknown): OmoDialogRequest | null {
  if (!isRecord(frame) || frame.type !== "extension_ui_request") return null;
  const id = nonEmptyString(frame.id);
  const method = nonEmptyString(frame.method);
  if (!id || !method || !OMO_DIALOG_METHODS.has(method)) return null;
  const title = nonEmptyString(frame.title);
  return {
    id,
    method: method as OmoDialogMethod,
    // A dialog without a title still needs a prompt: use the message, then a
    // neutral label, rather than publishing an empty card.
    title: title ?? nonEmptyString(frame.message) ?? "OmO input",
    message: nonEmptyString(frame.message),
    options: stringOptionList(frame.options),
    toolCallId: nonEmptyString(frame.toolCallId),
    timeoutMs: positiveNumber(frame.timeout),
    placeholder: nonEmptyString(frame.placeholder),
    prefill: typeof frame.prefill === "string" ? frame.prefill : null,
  };
}

function approvalChoices(request: OmoDialogRequest): OmoApprovalChoice[] {
  const choices: OmoApprovalChoice[] = [];
  const used = new Set<string>();
  for (const mapping of OMO_APPROVAL_MAPPINGS) {
    if (used.has(mapping.actionId)) continue;
    const nativeValue = request.options.find((option) => mapping.matches(option));
    if (nativeValue === undefined) continue;
    used.add(mapping.actionId);
    choices.push({
      action: {
        id: mapping.actionId,
        label: nativeValue,
        effect: mapping.effect,
      },
      nativeValue,
      feedback: mapping.feedback,
    });
  }
  return choices;
}

/**
 * True when the request is OmO's permission prompt. The documented shape is a
 * `select` carrying a `toolCallId` with a `Permission required:` title; the
 * title alone is enough because a permission prompt is the only dialog OmO
 * binds to a tool call, and at least one recognised decision must be offered —
 * a prompt whose labels cannot be mapped is better cancelled than shown with a
 * meaningless action set.
 */
function isApprovalRequest(request: OmoDialogRequest): boolean {
  if (request.method !== "select") return false;
  if (request.toolCallId === null && !OMO_APPROVAL_TITLE.test(request.title)) return false;
  return approvalChoices(request).length > 0;
}

function expiresAt(request: OmoDialogRequest, nowMs: number): string | undefined {
  if (request.timeoutMs === null) return undefined;
  return new Date(nowMs + request.timeoutMs).toISOString();
}

function questionFor(request: OmoDialogRequest): HostQuestion | null {
  if (request.method === "select") {
    // An empty choice list cannot be answered and must not be shown as a card.
    if (request.options.length === 0) return null;
    return {
      id: "answer",
      type: "choice",
      prompt: request.title,
      options: request.options.map((option) => ({ value: option, label: option })),
      multiple: false,
      allowOther: false,
      optional: false,
    };
  }
  if (request.method === "confirm") {
    return {
      id: "answer",
      type: "choice",
      prompt: request.message ?? request.title,
      options: [
        { value: "yes", label: "Yes" },
        { value: "no", label: "No" },
      ],
      multiple: false,
      allowOther: false,
      optional: false,
    };
  }
  return {
    id: "answer",
    type: "text",
    prompt: request.title,
    multiline: request.method === "editor",
    secret: false,
    optional: false,
    ...(request.placeholder !== null ? { placeholder: request.placeholder } : {}),
    ...(request.prefill !== null ? { prefill: request.prefill } : {}),
  };
}

export interface OmoInteractionPlanInput {
  readonly turnId: HostTurnId;
  readonly interactionId: HostInteractionId;
  /** The live tool Item the dialog approves or follows up on, when known. */
  readonly itemId?: HostItemId;
  readonly nowMs: number;
}

/**
 * Builds the Host Interaction for one dialog. Returns null when the request
 * cannot be represented honestly (a `select` with no options); the session then
 * cancels the dialog natively instead of publishing an unusable card.
 */
export function planOmoInteraction(
  request: OmoDialogRequest,
  input: OmoInteractionPlanInput,
): OmoInteractionPlan | null {
  const expires = expiresAt(request, input.nowMs);
  if (isApprovalRequest(request)) {
    const choices = approvalChoices(request);
    const interaction: HostApprovalInteraction = {
      type: "approval",
      interactionId: input.interactionId,
      turnId: input.turnId,
      title: request.title,
      subject: { type: "nativeAction" },
      actions: choices.map((choice) => choice.action),
      ...(expires === undefined ? {} : { expiresAt: expires }),
    };
    return {
      kind: "approval",
      interaction,
      nativeRequestId: request.id,
      approvalChoices: choices,
    };
  }
  const question = questionFor(request);
  if (!question) return null;
  const interaction: HostQuestionInteraction = {
    type: "question",
    interactionId: input.interactionId,
    turnId: input.turnId,
    ...(input.itemId === undefined ? {} : { itemId: input.itemId }),
    title: "OmO",
    questions: [question],
    ...(expires === undefined ? {} : { expiresAt: expires }),
  };
  return {
    kind: "question",
    interaction,
    nativeRequestId: request.id,
    nativeMethod: request.method,
  };
}

/**
 * Validates a Host response against the Interaction and translates it into the
 * native dialog answer. Approval action IDs are validated by the public helper
 * first and then resolved to the exact native option string; a Question answer
 * keeps OmO's `value`/`confirmed`/`cancelled` shapes.
 */
export function answerOmoInteraction(
  plan: OmoInteractionPlan,
  response: HostInteractionResponse,
): OmoInteractionAnswer {
  const validation = validateHostInteractionResponse(plan.interaction, response);
  if (validation) return { error: validation };
  if (plan.kind === "approval") {
    if (response.type !== "approval") {
      return {
        error: {
          code: "invalidRequest",
          message: "OmO Approval requires an Approval Response",
          retryable: false,
        },
      };
    }
    const choice = plan.approvalChoices.find(({ action }) => action.id === response.actionId);
    if (!choice) {
      return {
        error: {
          code: "invalidRequest",
          message: "OmO Approval Response contains an undeclared action ID",
          retryable: false,
        },
      };
    }
    return { answer: { value: choice.nativeValue } };
  }
  if (response.type !== "question") {
    return {
      error: {
        code: "invalidRequest",
        message: "OmO Question requires a Question Response",
        retryable: false,
      },
    };
  }
  if (response.cancelled) return { answer: { cancelled: true } };
  const answers = response.answers.answer ?? [];
  const value = answers[0];
  if (value === undefined) {
    return {
      error: {
        code: "invalidRequest",
        message: "OmO Question Response has no answer",
        retryable: false,
      },
    };
  }
  if (plan.nativeMethod === "confirm") {
    return { answer: { confirmed: value === "yes" } };
  }
  return { answer: { value } };
}

/** The native frame body for one answer; the transport adds the correlation id. */
export function omoInteractionResponseFrame(
  plan: OmoInteractionPlan,
  answer: OmoNativeInteractionAnswer,
): Readonly<Record<string, unknown>> {
  return { uiRequestId: plan.nativeRequestId, ...answer };
}
