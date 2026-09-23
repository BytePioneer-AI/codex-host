import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";

import type { HarnessResult, HostThreadSnapshot } from "@codexhost/harness-adapter";
import { jsonValueSchema } from "@codexhost/shared-contracts";
import { activePiEntries, mapPiSnapshot, type PiSessionHistory } from "./pi-history.js";
import { piSubagentSnapshot } from "./pi-subagents.js";
import {
  piWorkflowSummary,
  piWorkflowSubagentId,
  type PiWorkflowAddress,
} from "./pi-subagent-workflow.js";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
const MAX_SESSION_BYTES = 8 * 1024 * 1024;

async function childHistory(
  file: string,
  parentSessionId: string,
  identity: string,
): Promise<HostThreadSnapshot> {
  if (!path.isAbsolute(file)) throw new Error("Pi child Session path is not absolute");
  const handle = await open(
    file,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_SESSION_BYTES)
      throw new Error("Pi child Session exceeds read bounds");
    const buffer = Buffer.alloc(MAX_SESSION_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_SESSION_BYTES) throw new Error("Pi child Session exceeds read bounds");
    const values: unknown[] = buffer
      .subarray(0, bytesRead)
      .toString("utf8")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
    const header = values[0];
    if (
      !record(header) ||
      header.type !== "session" ||
      typeof header.id !== "string" ||
      header.version !== 3
    )
      throw new Error("Unsupported Pi child Session header");
    const entries: PiSessionHistory["entries"] = [];
    for (const entry of values.slice(1)) {
      const parsed = jsonValueSchema.safeParse(entry);
      if (!parsed.success || !record(parsed.data) || typeof parsed.data.id !== "string")
        throw new Error("Malformed Pi child Session entry");
      entries.push(parsed.data);
    }
    const history: PiSessionHistory = { entries, leafId: String(entries.at(-1)?.id ?? "") || null };
    const snapshot = mapPiSnapshot(history, { sessionId: parentSessionId, model: null });
    const prefix = createHash("sha256").update(identity).digest("hex");
    return {
      turns: snapshot.turns.map((turn) => {
        const readonlyTurn = {
          ...turn,
          nativeTurnRef: {
            ...turn.nativeTurnRef,
            nativeTurnKey: `${prefix}:${turn.nativeTurnRef.nativeTurnKey}`,
          },
        };
        delete readonlyTurn.checkpoint;
        return readonlyTurn;
      }),
    };
  } finally {
    await handle.close();
  }
}

/** Resolve paths through the parent's native result, never through a UI-provided file path. */
export async function readPiWorkflowChild(
  history: PiSessionHistory,
  parentSessionId: string,
  address: PiWorkflowAddress,
): Promise<HarnessResult<HostThreadSnapshot>> {
  for (const entry of activePiEntries(history).reverse()) {
    const message = entry.message;
    if (!record(message) || message.role !== "toolResult" || message.toolName !== "subagent")
      continue;
    const summary = piWorkflowSummary(message);
    if (
      !summary ||
      summary.workflowRunId !== address.workflowRunId ||
      summary.parentToolCallId !== message.toolCallId
    )
      continue;
    const child = summary.children.find((candidate) => candidate.childId === address.childId);
    if (!child) break;
    const details = message.details;
    if (!record(details) || !Array.isArray(details.results)) break;
    const result = details.results.findLast(
      (candidate) => record(candidate) && candidate.workflowKey === address.childId,
    );
    if (!record(result)) break;
    const id = piWorkflowSubagentId(address);
    if (typeof result.sessionFile === "string") {
      try {
        const snapshot = await childHistory(result.sessionFile, parentSessionId, id);
        if (snapshot.turns.length) return { ok: true, value: snapshot };
      } catch {
        // Pruned, partial, oversized and unsupported transcripts can still have a saved final result.
      }
    }
    if (typeof result.finalOutput === "string" && result.finalOutput.length > 0) {
      const output = result.finalOutput.slice(0, 64 * 1024);
      return {
        ok: true,
        value: piSubagentSnapshot(parentSessionId, id, {
          kind: "pi-subagents.inspect-reply",
          version: 1,
          requestId: "native-workflow-result",
          status:
            child.state === "completed"
              ? "complete"
              : child.state === "failed"
                ? "failed"
                : child.state === "interrupted"
                  ? "paused"
                  : "running",
          ...(typeof result.task === "string" ? { task: result.task.slice(0, 4096) } : {}),
          finalOutput: `[Pi subagent: saved native result; Session transcript unavailable.]\n${output}`,
          truncated: {
            task: typeof result.task === "string" && result.task.length > 4096,
            messages: 0,
            finalOutput: output.length < result.finalOutput.length,
          },
        }),
      };
    }
    break;
  }
  return {
    ok: false,
    error: {
      code: "sessionNotFound",
      message:
        "Pi workflow child has no published transcript/result in this parent's active history",
      retryable: true,
    },
  };
}
