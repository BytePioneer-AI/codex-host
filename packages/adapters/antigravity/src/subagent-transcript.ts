import { open, realpath } from "node:fs/promises";
import https from "node:https";
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
import { isRecord } from "./stream-events.js";
import { startAntigravityToolItem } from "./tool-projection.js";

export const nativeSubagentIdSchema = z.uuid();
const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;
const transcriptStepSchema = z.object({
  step_index: z.number().int().nonnegative(),
  source: z.string(),
  type: z.string(),
  status: z.string(),
  content: z.string().optional(),
  tool_calls: z.array(z.object({ name: z.string(), args: z.unknown().optional() })).optional(),
});

export async function subagentRpc(
  port: number,
  conversationId: string,
  method: "GetCascadeTrajectory" | "CancelCascadeInvocation",
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        hostname: "127.0.0.1",
        port,
        path: `/exa.language_server_pb.LanguageServerService/${method}`,
        method: "POST",
        rejectUnauthorized: false,
        timeout: 2_000,
        headers: { "content-type": "application/json" },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_TRANSCRIPT_BYTES)
            request.destroy(new Error("Subagent response too large"));
          else chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("end", () => {
          if (response.statusCode !== 200) return reject(new Error("Subagent RPC failed"));
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.on("timeout", () => request.destroy(new Error("Subagent RPC timed out")));
    request.on("error", reject);
    request.end(JSON.stringify({ cascadeId: conversationId }));
  });
}

export function subagentRunStatus(value: unknown, parentId: string): HostSubagentStatus | null {
  if (!isRecord(value) || !isRecord(value.trajectory)) return null;
  const metadata = value.trajectory.metadata;
  if (!isRecord(metadata) || metadata.parentConversationId !== parentId) return null;
  if (value.status === "CASCADE_RUN_STATUS_RUNNING") return "running";
  if (value.status !== "CASCADE_RUN_STATUS_IDLE") return null;
  const steps = value.trajectory.steps;
  const last = Array.isArray(steps) ? steps.at(-1) : null;
  return isRecord(last) && last.status === "CORTEX_STEP_STATUS_ERROR" ? "failed" : "completed";
}

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
      if (step.content) {
        current.items.push({
          item: { type: "agentMessage", itemId, text: step.content.slice(0, outputLimit) },
          outcome,
        });
      }
    } else if (step.source === "MODEL" && step.content) {
      const call = calls.shift();
      const item = startAntigravityToolItem(
        itemId,
        {
          conversation_id: childId,
          step_index: step.step_index,
          step_type: "tool",
          state: step.status,
          tool_name: call?.name ?? step.type,
          tool_info: { parameters: call?.args ?? null },
        },
        cwd,
      );
      const output = step.content.slice(0, outputLimit);
      const truncated = step.content.length > outputLimit;
      if (item.type === "commandExecution") {
        current.items.push({ item: { ...item, output, outputTruncated: truncated }, outcome });
      } else if (item.type === "toolExecution") {
        current.items.push({
          item: { ...item, output: { content: [{ type: "text", text: output }], truncated } },
          outcome,
        });
      }
    }
  }
  if (current) current.outcome = turnOutcome(status);
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
