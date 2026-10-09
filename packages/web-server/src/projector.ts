/**
 * Projection from codexhost Harness outputs (Item-oriented) onto the DSH session journal
 * (Step-oriented).
 *
 * DSH models one model call plus the tools it requested as a Step: `step/start`, an
 * `assistant/message` holding reasoning/text/tool-call blocks, one `tool/call` + `tool/result`
 * pair per tool, then `step/end`. Harnesses report independent Items instead. The projector
 * opens a new Step whenever narration (agent message or reasoning) begins after tool work, so
 * every DSH Step reads as "think/say, then act".
 */

import { randomUUID } from "node:crypto";

import type { SessionLog, WireEvent } from "./session-log.ts";

// ---- Minimal structural copies of the codexhost Adapter contract -----------------------------

export interface HostFileChange {
  path: string;
  kind: "add" | "update" | "delete";
  unifiedDiff: string;
}

export type HostItem =
  | { type: "agentMessage"; itemId: string; text: string; phase?: string }
  | { type: "reasoning"; itemId: string; text: string }
  | { type: "contextCompaction"; itemId: string }
  | {
      type: "commandExecution";
      itemId: string;
      command: string;
      cwd?: string;
      output?: string;
      exitCode?: number | null;
      durationMs?: number;
    }
  | {
      type: "toolExecution";
      itemId: string;
      toolName: string;
      namespace?: string;
      arguments: unknown;
      output?: HostToolOutput;
      durationMs?: number;
    }
  | { type: "fileChange"; itemId: string; changes: HostFileChange[] }
  | {
      type: "subagentDelegation";
      itemId: string;
      operation: "spawn" | "send";
      prompt?: string;
      subagents: Array<{
        subagentId: string;
        description: string;
        status: string;
        resultSummary?: string;
        role?: string;
      }>;
    };

export interface HostToolOutput {
  content: Array<
    { type: "text"; text: string } | { type: "image"; mimeType: string; base64Data: string }
  >;
  truncated?: boolean;
}

export type HostItemUpdate =
  | { type: "text.append"; text: string }
  | { type: "output.append"; text: string }
  | { type: "output.replace"; output: HostToolOutput }
  | { type: "fileChanges.replace"; changes: HostFileChange[] }
  | {
      type: "subagents.replace";
      subagents: Array<{
        subagentId: string;
        description: string;
        status: string;
        resultSummary?: string;
      }>;
    };

export interface HarnessErrorShape {
  code: string;
  message: string;
}

export type HostItemOutcome =
  | { status: "succeeded" }
  | { status: "failed"; error: HarnessErrorShape }
  | { status: "cancelled"; reason?: string };

export type TurnOutcomeShape =
  | { status: "succeeded" }
  | { status: "failed"; error: HarnessErrorShape }
  | { status: "cancelled"; reason?: string }
  | { status: "unknown"; reason: string };

// ---- Projection ------------------------------------------------------------------------------

type BlockKind = "reasoning" | "text";

interface NarrationBlock {
  itemId: string;
  kind: BlockKind;
  index: number;
  text: string;
  ended: boolean;
}

interface ToolState {
  callId: string;
  name: string;
  args: unknown;
  callSeq: number;
  item: HostItem;
  output: string;
}

const NARRATION = new Set(["agentMessage", "reasoning"]);

/** Cap one tool result's text so a runaway command output cannot bloat the journal. */
export const MAX_TOOL_TEXT = 100_000;

export function capText(text: string, limit = MAX_TOOL_TEXT): string {
  if (text.length <= limit) return text;
  const head = Math.floor(limit * 0.7);
  const tail = limit - head;
  return `${text.slice(0, head)}\n\n[… ${String(text.length - limit)} characters truncated …]\n\n${text.slice(-tail)}`;
}

/** Convert one unified diff into the before/after texts DSH diff cards draw. */
export function diffTexts(change: HostFileChange): {
  path: string;
  oldText: string | null;
  newText: string;
} {
  const oldLines: string[] = [];
  const newLines: string[] = [];
  for (const line of change.unifiedDiff.split("\n")) {
    if (
      line.startsWith("---") ||
      line.startsWith("+++") ||
      line.startsWith("@@") ||
      line.startsWith("diff ") ||
      line.startsWith("index ") ||
      line.startsWith("\\")
    )
      continue;
    if (line.startsWith("+")) newLines.push(line.slice(1));
    else if (line.startsWith("-")) oldLines.push(line.slice(1));
    else if (line.startsWith(" ")) {
      oldLines.push(line.slice(1));
      newLines.push(line.slice(1));
    }
  }
  return {
    path: change.path,
    oldText: change.kind === "add" ? null : oldLines.join("\n"),
    newText: change.kind === "delete" ? "" : newLines.join("\n"),
  };
}

const TOOL_ALIASES: Record<string, string> = {
  read: "read",
  write: "write",
  edit: "edit",
  multiedit: "edit",
  grep: "grep",
  glob: "glob",
  bash: "bash",
  shell: "bash",
  webfetch: "web_fetch",
  web_fetch: "web_fetch",
  websearch: "web_search",
  web_search: "web_search",
  todowrite: "todo_write",
  todo_write: "todo_write",
  askuserquestion: "ask_user_question",
};

/**
 * Map a Harness-native tool call onto the DSH tool view with the same meaning, when the argument
 * shapes agree (Claude Code and Pi file/shell/search tools); unknown tools keep their own name.
 */
export function normalizeTool(name: string, args: unknown): { name: string; args: unknown } {
  const alias = TOOL_ALIASES[name.toLowerCase()];
  if (alias === undefined || typeof args !== "object" || args === null || Array.isArray(args))
    return { name, args };
  const record = { ...(args as Record<string, unknown>) };
  if (
    (alias === "read" || alias === "write" || alias === "edit") &&
    record.file_path === undefined &&
    typeof record.path === "string"
  ) {
    record.file_path = record.path;
  }
  if (alias === "edit") {
    if (record.old_string === undefined && typeof record.oldText === "string")
      record.old_string = record.oldText;
    if (record.new_string === undefined && typeof record.newText === "string")
      record.new_string = record.newText;
    const edits = record.edits;
    if (record.old_string === undefined && Array.isArray(edits) && edits.length > 0) {
      const first = edits[0] as Record<string, unknown>;
      record.old_string = first.old_string ?? first.oldText;
      record.new_string = first.new_string ?? first.newText;
    }
  }
  if (alias === "web_search" && record.queries === undefined && typeof record.query === "string")
    record.queries = [record.query];
  if (alias === "ask_user_question" && Array.isArray(record.questions)) {
    // DSH's question card pairs answers with questions by id; Claude Code questions carry none.
    record.questions = (record.questions as Array<Record<string, unknown>>).map(
      (question, index) => ({
        ...question,
        id: typeof question.id === "string" ? question.id : `q${String(index)}`,
        ...(typeof question.multiSelect === "boolean"
          ? { multi_select: question.multiSelect }
          : {}),
      }),
    );
  }
  return { name: alias, args: record };
}

/** Result metadata DSH settled diff cards read for an edit-family call. */
function editMeta(name: string, args: unknown): unknown {
  if (name !== "edit" || typeof args !== "object" || args === null) return undefined;
  const record = args as Record<string, unknown>;
  if (typeof record.file_path !== "string" || typeof record.new_string !== "string")
    return undefined;
  return {
    diffs: [
      {
        path: record.file_path,
        oldText:
          typeof record.old_string === "string" && record.old_string !== ""
            ? record.old_string
            : null,
        newText: record.new_string,
      },
    ],
  };
}

/** Name and argument JSON a DSH tool view recognizes for one Harness Item. */
function toolCallOf(item: HostItem, cwd: string | undefined): { name: string; args: unknown } {
  switch (item.type) {
    case "commandExecution":
      return {
        name: "bash",
        args: {
          command: item.command,
          ...(item.cwd !== undefined && item.cwd !== cwd ? { workdir: item.cwd } : {}),
        },
      };
    case "fileChange": {
      const first = item.changes[0];
      if (item.changes.length === 1 && first !== undefined) {
        const texts = diffTexts(first);
        return first.kind === "add"
          ? { name: "write", args: { file_path: first.path, content: texts.newText } }
          : {
              name: "edit",
              args: {
                file_path: first.path,
                old_string: texts.oldText ?? "",
                new_string: texts.newText,
              },
            };
      }
      return {
        name: "edit",
        args: {
          file_path: first?.path ?? "",
          changes: item.changes.map((change) => ({ path: change.path, kind: change.kind })),
        },
      };
    }
    case "toolExecution":
      return item.namespace === undefined
        ? normalizeTool(item.toolName, item.arguments ?? {})
        : { name: `${item.namespace}__${item.toolName}`, args: item.arguments ?? {} };
    case "subagentDelegation":
      return {
        name: "subagent",
        args: {
          operation: item.operation,
          ...(item.prompt === undefined ? {} : { prompt: item.prompt }),
          description: item.subagents.map((subagent) => subagent.description).join(", "),
        },
      };
    case "contextCompaction":
      return { name: "compact_context", args: {} };
    default:
      return { name: (item as { type: string }).type, args: {} };
  }
}

/**
 * Claude Code reports answers as `"<question>"="<answer>", ...`; DSH's card reads
 * `{ answers: [{ id, selected }] }` keyed by the question ids synthesized in {@link normalizeTool}.
 */
function askAnswersJson(args: unknown, text: string): string | undefined {
  const questions = (args as { questions?: Array<{ id: string; question?: string }> } | undefined)
    ?.questions;
  if (!Array.isArray(questions)) return undefined;
  const pairs = new Map<string, string>();
  for (const match of text.matchAll(/"((?:[^"\\]|\\.)*)"="((?:[^"\\]|\\.)*)"/gu))
    pairs.set(match[1] as string, match[2] as string);
  if (pairs.size === 0) return undefined;
  return JSON.stringify({
    answers: questions.map((question) => {
      const answer = pairs.get(question.question ?? "");
      return {
        id: question.id,
        selected: answer === undefined || answer === "" ? [] : answer.split(", "),
      };
    }),
  });
}

function toolResultText(
  tool: ToolState,
  item: HostItem,
): { text: string; images: HostToolOutput["content"] } {
  switch (item.type) {
    case "commandExecution": {
      const output = item.output ?? tool.output;
      const code = item.exitCode;
      return {
        text:
          code !== undefined && code !== null && code !== 0
            ? `${output}\n[exit code: ${String(code)}]`
            : output,
        images: [],
      };
    }
    case "toolExecution": {
      const content = item.output?.content ?? [];
      const text =
        content
          .filter((part) => part.type === "text")
          .map((part) => (part as { text: string }).text)
          .join("\n") || tool.output;
      const answers =
        tool.name === "ask_user_question" ? askAnswersJson(tool.args, text) : undefined;
      return { text: answers ?? text, images: content.filter((part) => part.type === "image") };
    }
    case "fileChange":
      return {
        text: item.changes.map((change) => `${change.kind} ${change.path}`).join("\n"),
        images: [],
      };
    case "subagentDelegation":
      return {
        text: item.subagents
          .map(
            (subagent) =>
              `${subagent.description}: ${subagent.status}${subagent.resultSummary === undefined ? "" : `\n${subagent.resultSummary}`}`,
          )
          .join("\n\n"),
        images: [],
      };
    case "contextCompaction":
      return { text: "Context compacted.", images: [] };
    default:
      return { text: tool.output, images: [] };
  }
}

export interface TurnProjectorOptions {
  /** Emit assistant-stream presentation frames (false while importing history). */
  live: boolean;
  /** Running tool output (accumulated text) for live terminal cards; `undefined` once the tool settles. */
  onToolOutput?: (callId: string, output: string | undefined) => void;
  cwd?: string;
  model?: { provider: string; model: string };
}

/** Projects one Turn's Harness events into the Session journal. */
export class TurnProjector {
  private step = 0;
  private stepOpen = false;
  private stepHasTools = false;
  private messageCommitted = false;
  private blocks: NarrationBlock[] = [];
  private blockByItem = new Map<string, NarrationBlock>();
  /** Narration Items seen in this Turn: their kind and the text already projected. */
  private readonly narration = new Map<string, { kind: BlockKind; text: string }>();
  private readonly tools = new Map<string, ToolState>();
  /** Output that arrived before its tool's `item.started` (Harnesses may race the two). */
  private readonly earlyOutput = new Map<string, string>();
  private finished = false;
  readonly turn: number;

  constructor(
    private readonly log: SessionLog,
    private readonly options: TurnProjectorOptions,
  ) {
    this.turn = log.events.filter((event) => event.type === "turn/start").length + 1;
  }

  /** Open the Turn with the user's prompt. */
  begin(content: unknown[], requestId: string | undefined): void {
    this.log.append("turn/start", { turn: this.turn });
    this.openStep();
    this.log.append(
      "user/message",
      {
        role: "user",
        content,
        source: requestId === undefined ? { kind: "user" } : { kind: "user", rpcId: requestId },
        id: randomUUID(),
      },
      { surfaceOp: "append" },
    );
  }

  /** Record input the user steered into this running Turn; later Items land after it. */
  steer(content: unknown[], requestId: string | undefined): void {
    if (this.finished) return;
    this.closeStep();
    this.openStep();
    this.log.append(
      "user/message",
      {
        role: "user",
        content,
        source: requestId === undefined ? { kind: "user" } : { kind: "user", rpcId: requestId },
        id: randomUUID(),
      },
      { surfaceOp: "append" },
    );
  }

  /** Open a Turn started by the Harness itself; without input there is no user bubble to show. */
  beginAutonomous(content: unknown[]): void {
    const text = content.some(
      (part) =>
        typeof (part as { text?: unknown }).text === "string" &&
        (part as { text: string }).text.trim() !== "",
    );
    if (text) {
      this.begin(content, undefined);
      return;
    }
    this.log.append("turn/start", { turn: this.turn });
    this.openStep();
  }

  private openStep(): void {
    this.step += 1;
    this.stepOpen = true;
    this.stepHasTools = false;
    this.messageCommitted = false;
    this.blocks = [];
    this.blockByItem.clear();
    this.log.append("step/start", { turn: this.turn, step: this.step });
  }

  private closeStep(): void {
    if (!this.stepOpen) return;
    if (!this.messageCommitted && this.blocks.some((block) => block.text !== ""))
      this.commitMessage([]);
    else this.log.endAttempt(undefined);
    this.log.append("step/end", { turn: this.turn, step: this.step });
    this.stepOpen = false;
  }

  private ensureAttempt(): void {
    if (!this.options.live) return;
    if (this.log.activeAttempt === undefined) this.log.startAttempt(this.turn, this.step);
  }

  private endBlock(block: NarrationBlock): void {
    if (block.ended) return;
    block.ended = true;
    if (this.options.live && this.log.activeAttempt !== undefined) {
      this.log.chunk({
        type: "block-end",
        index: block.index,
        block: { type: block.kind, text: block.text },
      });
    }
  }

  private commitMessage(
    toolCalls: Array<{ id: string; name: string; arguments: string }>,
  ): WireEvent {
    for (const block of this.blocks) this.endBlock(block);
    const content: unknown[] = this.blocks
      .filter((block) => block.text !== "")
      .map((block) =>
        block.kind === "reasoning"
          ? { type: "reasoning", text: block.text }
          : { type: "text", text: block.text },
      );
    for (const call of toolCalls) content.push({ type: "tool-call", ...call });
    if (this.options.live && this.log.activeAttempt !== undefined) {
      this.log.chunk({
        type: "finish",
        reason: { kind: toolCalls.length > 0 ? "tool-calls" : "stop" },
      });
    }
    const event = this.log.append(
      "assistant/message",
      {
        turn: this.turn,
        step: this.step,
        message: {
          role: "assistant",
          content,
          source: {
            kind: "model",
            provider: this.options.model?.provider ?? "codexhost",
            model: this.options.model?.model ?? "harness",
          },
          id: randomUUID(),
        },
        stream: [],
      },
      { surfaceOp: "append" },
    );
    this.log.endAttempt(event);
    this.messageCommitted = true;
    return event;
  }

  itemStarted(item: HostItem): void {
    if (this.finished) return;
    if (NARRATION.has(item.type)) {
      const kind: BlockKind = item.type === "reasoning" ? "reasoning" : "text";
      if (!this.narration.has(item.itemId)) this.narration.set(item.itemId, { kind, text: "" });
      const initial = (item as { text: string }).text;
      if (initial !== "") this.appendNarration(item.itemId, initial);
      return;
    }
    // Context compaction renders as a tool row so the user sees that history was summarized.
    this.startTool(item);
  }

  /**
   * The block that may receive more text for one narration Item. Blocks are created lazily on the
   * first text, and a fresh Step opens whenever the current one already committed its message or
   * ran tools: Harnesses may keep one message Item open across tool calls, but a DSH Step reads
   * strictly as "narrate, then act".
   */
  private writableBlock(itemId: string): NarrationBlock {
    const existing = this.blockByItem.get(itemId);
    if (existing !== undefined && !existing.ended && !this.messageCommitted && !this.stepHasTools)
      return existing;
    if (!this.stepOpen || this.stepHasTools || this.messageCommitted) {
      this.closeStep();
      this.openStep();
    }
    const kind = this.narration.get(itemId)?.kind ?? "text";
    const block: NarrationBlock = {
      itemId,
      kind,
      index: this.blocks.length,
      text: "",
      ended: false,
    };
    this.blocks.push(block);
    this.blockByItem.set(itemId, block);
    this.ensureAttempt();
    if (this.options.live)
      this.log.chunk({ type: "block-start", index: block.index, blockType: kind });
    return block;
  }

  private appendNarration(itemId: string, text: string): void {
    if (text === "") return;
    const state = this.narration.get(itemId);
    if (state !== undefined) state.text += text;
    this.appendText(this.writableBlock(itemId), text);
  }

  private startTool(item: HostItem): void {
    if (this.tools.has(item.itemId)) return;
    if (!this.stepOpen) this.openStep();
    const call = toolCallOf(item, this.options.cwd);
    const callId = item.itemId;
    const argumentsJson = JSON.stringify(call.args);
    if (!this.messageCommitted)
      this.commitMessage([{ id: callId, name: call.name, arguments: argumentsJson }]);
    const event = this.log.append("tool/call", {
      turn: this.turn,
      step: this.step,
      callId,
      name: call.name,
      arguments: argumentsJson,
    });
    const early = this.earlyOutput.get(item.itemId) ?? "";
    this.earlyOutput.delete(item.itemId);
    this.tools.set(item.itemId, {
      callId,
      name: call.name,
      args: call.args,
      callSeq: event.seq,
      item,
      output: early,
    });
    if (early !== "") this.options.onToolOutput?.(callId, early);
    this.stepHasTools = true;
  }

  private appendText(block: NarrationBlock, text: string): void {
    block.text += text;
    if (this.options.live) {
      this.log.chunk({
        type: block.kind === "reasoning" ? "reasoning-delta" : "text-delta",
        index: block.index,
        text,
      });
    }
  }

  itemUpdated(itemId: string, update: HostItemUpdate): void {
    if (this.finished) return;
    if (this.narration.has(itemId)) {
      if (update.type === "text.append") this.appendNarration(itemId, update.text);
      return;
    }
    const tool = this.tools.get(itemId);
    if (tool === undefined) {
      if (update.type === "output.append")
        this.earlyOutput.set(itemId, (this.earlyOutput.get(itemId) ?? "") + update.text);
      return;
    }
    if (update.type === "output.append") {
      tool.output += update.text;
      this.options.onToolOutput?.(tool.callId, tool.output);
    } else if (update.type === "output.replace") {
      tool.output = update.output.content
        .filter((part) => part.type === "text")
        .map((part) => (part as { text: string }).text)
        .join("\n");
      this.options.onToolOutput?.(tool.callId, tool.output);
    } else if (update.type === "fileChanges.replace" && tool.item.type === "fileChange") {
      tool.item = { ...tool.item, changes: update.changes };
    } else if (update.type === "subagents.replace" && tool.item.type === "subagentDelegation") {
      tool.item = { ...tool.item, subagents: update.subagents };
    }
  }

  itemCompleted(item: HostItem, outcome: HostItemOutcome): void {
    if (this.finished) return;
    if (NARRATION.has(item.type)) {
      // Completed without a start is common in history snapshots.
      if (!this.narration.has(item.itemId)) this.itemStarted({ ...item, text: "" } as HostItem);
      const state = this.narration.get(item.itemId) as { kind: BlockKind; text: string };
      const finalText = (item as { text: string }).text;
      if (finalText.length > state.text.length && finalText.startsWith(state.text)) {
        this.appendNarration(item.itemId, finalText.slice(state.text.length));
      } else if (state.text === "" && finalText !== "") {
        this.appendNarration(item.itemId, finalText);
      }
      const block = this.blockByItem.get(item.itemId);
      if (block !== undefined) this.endBlock(block);
      return;
    }
    if (!this.tools.has(item.itemId)) this.startTool(item);
    const tool = this.tools.get(item.itemId);
    if (tool === undefined) return;
    this.tools.delete(item.itemId);
    if (tool.output !== "") this.options.onToolOutput?.(tool.callId, undefined);
    const { text, images } = toolResultText(tool, item);
    const isError = outcome.status !== "succeeded";
    const content: unknown[] = [
      {
        type: "text",
        text: capText(
          isError && text === ""
            ? outcome.status === "failed"
              ? outcome.error.message
              : "Cancelled"
            : text,
        ),
      },
    ];
    for (const image of images) {
      if (image.type === "image")
        content.push({ type: "image", mediaType: image.mimeType, data: image.base64Data });
    }
    const meta =
      item.type === "fileChange"
        ? { diffs: item.changes.map(diffTexts) }
        : isError
          ? undefined
          : editMeta(tool.name, tool.args);
    this.log.append(
      "tool/result",
      {
        turn: this.turn,
        step: this.step,
        message: {
          role: "tool",
          source: { kind: "tool", callId: tool.callId },
          toolCallId: tool.callId,
          content,
          isError,
          id: randomUUID(),
        },
        ...(isError
          ? {
              error: {
                name: "HarnessError",
                code: outcome.status === "failed" ? outcome.error.code : "cancelled",
                reason:
                  outcome.status === "failed"
                    ? outcome.error.message
                    : (outcome.reason ?? "cancelled"),
              },
            }
          : {}),
        ...(meta === undefined ? {} : { meta }),
      },
      { surfaceOp: "append", sourceEventSeqs: [tool.callSeq] },
    );
  }

  /** Close the Turn. */
  finish(outcome: TurnOutcomeShape): void {
    if (this.finished) return;
    // Settle tools the Harness never completed so the client does not show them running forever.
    for (const tool of [...this.tools.values()]) {
      this.itemCompleted(
        tool.item,
        outcome.status === "cancelled"
          ? { status: "cancelled" }
          : {
              status: "failed",
              error: {
                code: "unsettled",
                message: "The Harness did not report a result for this tool.",
              },
            },
      );
    }
    this.closeStep();
    this.finished = true;
    // History snapshots often cannot tell how a turn ended; reading those as completed is closer
    // to the truth than "stopped".
    const reason =
      outcome.status === "succeeded" || (outcome.status === "unknown" && !this.options.live)
        ? { kind: "completed" }
        : outcome.status === "cancelled"
          ? { kind: "aborted", reason: { kind: "user" } }
          : outcome.status === "failed"
            ? { kind: "error", error: { message: outcome.error.message, code: outcome.error.code } }
            : { kind: "interrupted" };
    this.log.append("turn/end", { turn: this.turn, reason });
  }

  get isFinished(): boolean {
    return this.finished;
  }
}
