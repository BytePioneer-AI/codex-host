import { open, realpath } from "node:fs/promises";
import path from "node:path";

import type {
  HarnessResult,
  HistoricalTurnOutcome,
  HostItemSnapshot,
  HostSubagentStatus,
  HostThreadSnapshot,
} from "@codexhost/harness-adapter";
import { hostItemIdSchema, nativeTurnRefSchema } from "@codexhost/shared-contracts";
import { z } from "zod";

import { nativeBrainDirPath } from "./fork.js";
import { synthesizeAntigravityCommand } from "./tool-projection.js";

export const nativeSubagentIdSchema = z.uuid();
const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;
const transcriptStepSchema = z.object({
  step_index: z.number().int().nonnegative(),
  source: z.string(),
  type: z.string(),
  status: z.string(),
  content: z.string().optional(),
  thinking: z.string().optional(),
  tool_calls: z.array(z.object({ name: z.string(), args: z.unknown().optional() })).optional(),
});

function turnOutcome(status: HostSubagentStatus): HistoricalTurnOutcome {
  if (status === "completed") return { status: "succeeded" };
  if (status === "interrupted") return { status: "cancelled", reason: "Subagent interrupted" };
  if (status === "failed") {
    return {
      status: "failed",
      error: { code: "nativeFailure", message: "Antigravity Subagent failed", retryable: false },
    };
  }
  return { status: "unknown", reason: "Antigravity Subagent is still running" };
}

/** Only completed, user-visible log entries are projected; a partial last line is retried later. */
export function parseSubagentTranscript(
  text: string,
  parentId: string,
  childId: string,
  status: HostSubagentStatus,
  cwd: string,
  outputLimit: number,
): HostThreadSnapshot {
  const lines = text.split("\n");
  if (lines.at(-1)?.trim()) {
    try {
      JSON.parse(lines.at(-1) ?? "");
    } catch {
      lines.pop();
    }
  }
  const steps = lines
    .filter((line) => line.trim())
    .map((line) => transcriptStepSchema.parse(JSON.parse(line)));
  const turns: HostThreadSnapshot["turns"] = [];
  let current: HostThreadSnapshot["turns"][number] | undefined;
  let calls: Array<{ name: string; args?: unknown }> = [];
  const seen = new Set<number>();
  for (const step of steps) {
    if (seen.has(step.step_index)) throw new Error("Duplicate Subagent step");
    seen.add(step.step_index);
    if (!current || step.type === "USER_INPUT") {
      calls = [];
      current = {
        nativeTurnRef: nativeTurnRefSchema.parse({
          harnessId: "antigravity",
          nativeSessionId: parentId,
          nativeTurnKey: `subagent-${childId}-${step.step_index}`,
          formatVersion: 1,
        }),
        input: [],
        items: [],
        outcome: { status: "unknown", reason: "Native log has no per-Turn terminal status" },
      };
      turns.push(current);
    }
    if (step.type === "USER_INPUT") {
      const content = step.content ?? "";
      const userText =
        /<USER_REQUEST>\n?([\s\S]*?)\n?<\/USER_REQUEST>/u.exec(content)?.[1] ?? content;
      if (userText) current.input.push({ type: "text", text: userText });
      continue;
    }
    if (step.type === "PLANNER_RESPONSE") calls.push(...(step.tool_calls ?? []));
    if (step.status !== "DONE" && step.status !== "ERROR") continue;
    const itemId = hostItemIdSchema.parse(`agy-${parentId}-${childId}-${step.step_index}`);
    const outcome: HostItemSnapshot["outcome"] =
      step.status === "ERROR"
        ? {
            status: "failed",
            error: {
              code: "nativeFailure",
              message: "Antigravity Subagent step failed",
              retryable: false,
            },
          }
        : { status: "succeeded" };
    if (step.type === "PLANNER_RESPONSE") {
      if (step.thinking?.trim()) {
        current.items.push({
          item: {
            type: "reasoning",
            itemId: hostItemIdSchema.parse(`${itemId}-thinking`),
            text: step.thinking.slice(0, outputLimit),
          },
          outcome,
        });
      }
      if (step.content) {
        current.items.push({
          item: { type: "agentMessage", itemId, text: step.content.slice(0, outputLimit) },
          outcome,
        });
      }
    } else if (step.source === "MODEL" && step.content) {
      const call = calls.shift();
      const toolName = call?.name ?? step.type;
      const command = synthesizeAntigravityCommand(toolName, call?.args, cwd);
      const output = step.content.slice(0, outputLimit);
      const truncated = step.content.length > outputLimit;
      current.items.push({
        item: command
          ? {
              type: "commandExecution",
              itemId,
              ...command,
              output,
              outputTruncated: truncated,
            }
          : {
              type: "toolExecution",
              itemId,
              toolName,
              arguments: JSON.parse(JSON.stringify(call?.args ?? null)),
              output: { content: [{ type: "text", text: output }], truncated },
            },
        outcome,
      });
    }
  }
  if (current)
    current.outcome = turnOutcome(
      status === "completed" && steps.at(-1)?.status === "ERROR" ? "failed" : status,
    );
  return { turns };
}

export async function readSubagentTranscript(input: {
  parentId: string;
  childId: string;
  status: HostSubagentStatus;
  cwd: string;
  outputLimit: number;
  home?: string;
}): Promise<HarnessResult<HostThreadSnapshot>> {
  if (!nativeSubagentIdSchema.safeParse(input.childId).success) {
    return {
      ok: false,
      error: { code: "invalidRequest", message: "Invalid Subagent ID", retryable: false },
    };
  }
  try {
    // Never follow a model-supplied log_uri to an arbitrary local file or network share.
    const file = path.join(
      nativeBrainDirPath(input.childId, input.home),
      ".system_generated",
      "logs",
      "transcript.jsonl",
    );
    const brainRoot = await realpath(path.dirname(nativeBrainDirPath(input.childId, input.home)));
    const resolved = await realpath(file);
    const expected = path.join(
      brainRoot,
      input.childId,
      ".system_generated",
      "logs",
      "transcript.jsonl",
    );
    const normalize = (value: string) =>
      process.platform === "win32" ? value.toLowerCase() : value;
    if (normalize(resolved) !== normalize(expected))
      throw new Error("Subagent log redirects outside its native location");
    const handle = await open(resolved, "r");
    let text: string;
    try {
      const size = (await handle.stat()).size;
      if (size > MAX_TRANSCRIPT_BYTES) throw new Error("Subagent transcript too large");
      const buffer = Buffer.alloc(size);
      const { bytesRead } = await handle.read(buffer, 0, size, 0);
      text = buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
    return {
      ok: true,
      value: parseSubagentTranscript(
        text,
        input.parentId,
        input.childId,
        input.status,
        input.cwd,
        input.outputLimit,
      ),
    };
  } catch {
    return {
      ok: false,
      error: {
        code: "protocolError",
        message: "Antigravity Subagent transcript is unavailable or invalid",
        retryable: true,
      },
    };
  }
}
