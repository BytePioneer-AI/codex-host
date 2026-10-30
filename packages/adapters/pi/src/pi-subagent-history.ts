import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";

import { activePiEntries, type PiSessionHistory } from "./pi-history.js";
import { parsePiSubagentStatus, type PiSubagentNode, type PiSubagents } from "./pi-subagents.js";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function state(value: unknown): unknown {
  return value === "pending" ? "queued" : value === "completed" ? "complete" : value;
}

/** Project only documented lifecycle v3 artifacts; do not import the plugin's private runtime. */
export function piSubagentArtifact(
  value: unknown,
  runId: string,
  parentSessionId: string,
): PiSubagentNode[] | null {
  if (
    !record(value) ||
    value.lifecycleArtifactVersion !== 3 ||
    value.runId !== runId ||
    value.sessionId !== parentSessionId ||
    !["single", "parallel", "chain", "workflow"].includes(String(value.mode))
  )
    return null;
  if (value.steps !== undefined && (!Array.isArray(value.steps) || value.steps.length > 128))
    return null;
  const steps = Array.isArray(value.steps) ? value.steps : [];
  const children: Record<string, unknown>[] = [];
  for (const [index, step] of steps.entries()) {
    if (!record(step) || typeof step.agent !== "string") return null;
    children.push({
      id: step.workflowKey ?? step.runId ?? `step:${index}`,
      kind: "step",
      label: step.label ?? step.agent,
      state: state(step.status),
    });
  }
  return parsePiSubagentStatus({
    type: "extension_ui_request",
    method: "setWidget",
    widgetKey: "subagent-async",
    widgetLines: [
      "PI_SUBAGENT_ASYNC_JSON:" +
        JSON.stringify({
          kind: "pi-subagents.async-status-snapshot",
          version: 1,
          runs: [
            {
              id: runId,
              kind: value.mode === "single" ? "subagent" : "workflow",
              label: "Pi subagent",
              state: value.state,
              children,
            },
          ],
        }),
    ],
  });
}

/** Restored cards use parent-owned native receipts, never arbitrary filesystem paths supplied by the UI. */
export async function restorePiSubagents(
  history: PiSessionHistory,
  parentSessionId: string,
  observer: PiSubagents,
): Promise<void> {
  const receipts = new Map<string, string>();
  for (const entry of activePiEntries(history)) {
    if (
      !record(entry.message) ||
      entry.message.role !== "toolResult" ||
      entry.message.toolName !== "subagent" ||
      entry.message.isError !== false ||
      !record(entry.message.details)
    )
      continue;
    const details = entry.message.details;
    if (
      !["single", "parallel", "chain", "workflow"].includes(String(details.mode)) ||
      typeof details.asyncId !== "string" ||
      typeof details.asyncDir !== "string" ||
      !path.isAbsolute(details.asyncDir) ||
      path.basename(details.asyncDir) !== details.asyncId
    )
      continue;
    receipts.set(details.asyncId, details.asyncDir);
  }
  // Bound history I/O. Missing, pruned, foreign and future-version artifacts remain ordinary tools.
  for (const [id, directory] of [...receipts].slice(-128)) {
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
      file = await open(
        path.join(directory, "status.json"),
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 1024 * 1024) continue;
      const buffer = Buffer.alloc(1024 * 1024 + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 1024 * 1024) continue;
      const value: unknown = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
      const runs = piSubagentArtifact(value, id, parentSessionId);
      if (runs) observer.restore(runs);
    } catch {
      // Artifact retention and status publication races are not parent Session failures.
    } finally {
      await file?.close();
    }
  }
}
