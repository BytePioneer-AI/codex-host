import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type {
  HarnessError,
  HostThreadSnapshot,
  OpenSessionInput,
} from "@codexhost/harness-adapter";
import { nativeCheckpointRefSchema } from "@codexhost/shared-contracts";
import { devinReplayTurnKey, devinSnapshot } from "./projection.js";
import { DevinTransport, type DevinTransportOptions } from "./transport.js";

export class DevinHistoryError extends Error {
  constructor(
    readonly code: HarnessError["code"],
    message: string,
  ) {
    super(message);
  }
}

export interface DevinHistoryStep {
  stepId: string;
  kind: string;
  userMessageId?: string | null;
}

/** Shape inferred from the official RevertListStepsResponse/RevertStepInfo symbols. */
export function devinHistorySteps(value: unknown): DevinHistoryStep[] {
  const steps = (value as { steps?: unknown } | null)?.steps;
  if (!Array.isArray(steps)) throw new Error("Devin listSteps returned no steps array");
  const seen = new Set<string>();
  return steps.map((step: unknown) => {
    const row = step as Partial<DevinHistoryStep> | null;
    if (
      !row ||
      typeof row.stepId !== "string" ||
      !row.stepId.trim() ||
      seen.has(row.stepId) ||
      typeof row.kind !== "string" ||
      (row.userMessageId != null && typeof row.userMessageId !== "string")
    )
      throw new Error("Devin listSteps returned an invalid or duplicate step");
    seen.add(row.stepId);
    return row as DevinHistoryStep;
  });
}

export function devinCheckpoint(
  sessionId: string,
  userMessageId: string,
  steps: DevinHistoryStep[],
) {
  // Tool/question steps do not establish a complete Host Turn boundary.
  const matches = steps.filter(
    (step) => step.kind === "prompt" && step.userMessageId === userMessageId,
  );
  if (matches.length > 1) throw new Error("Devin has ambiguous prompt steps for a User Turn");
  const step = matches[0];
  return step
    ? nativeCheckpointRefSchema.parse({
        harnessId: "devin",
        nativeSessionId: sessionId,
        checkpointId: step.stepId,
        formatVersion: 1,
      })
    : undefined;
}

async function readHistory(transport: DevinTransport) {
  const replay = await transport.reload();
  const snapshot = devinSnapshot(transport.sessionId, replay);
  // Compare native transcript updates too: projection must not hide a changed opaque payload.
  const transcript: Array<{ key: string; updates: unknown[] }> = [];
  const stateUpdates = new Set([
    "config_option_update",
    "current_mode_update",
    "available_commands_update",
    "session_info_update",
    "usage_update",
  ]);
  for (const { update } of replay) {
    if (update.sessionUpdate === "user_message_chunk") {
      const key = devinReplayTurnKey({ sessionId: transport.sessionId, update });
      if (!key) throw new Error("Devin replay user message has no stable native identity");
      if (transcript.at(-1)?.key !== key) {
        if (transcript.some((turn) => turn.key === key))
          throw new Error("Devin replay contains a duplicate User Turn identity");
        transcript.push({ key, updates: [] });
      }
    }
    if (!stateUpdates.has(update.sessionUpdate))
      transcript.at(-1)?.updates.push(structuredClone(update));
  }
  if (transport.nativeHistory) {
    const steps = devinHistorySteps(await transport.historyRequest("listSteps"));
    for (const turn of snapshot.turns) {
      const checkpoint = devinCheckpoint(
        transport.sessionId,
        turn.nativeTurnRef.nativeTurnKey,
        steps,
      );
      if (checkpoint) turn.checkpoint = checkpoint;
    }
  }
  return { snapshot, transcript };
}

export async function readDevinHistory(transport: DevinTransport): Promise<HostThreadSnapshot> {
  return (await readHistory(transport)).snapshot;
}

/** Only Session identity and checkpoint routing may differ; content and Turn keys must not. */
function comparable(snapshot: HostThreadSnapshot) {
  return snapshot.turns.map(({ nativeTurnRef, ...turn }) => {
    delete turn.checkpoint;
    return { ...turn, nativeTurnKey: nativeTurnRef.nativeTurnKey };
  });
}

export type DevinHistoryInput = Extract<OpenSessionInput, { kind: "fork" | "rollbackLastTurn" }>;

export async function deriveDevinHistory(
  input: DevinHistoryInput,
  source: DevinTransport,
  options: DevinTransportOptions,
) {
  if (!source.nativeHistory)
    throw new DevinHistoryError(
      "unsupported",
      "Devin did not negotiate the native revert extension",
    );
  const cwd = path.resolve(input.cwd);
  if (path.resolve(source.options.cwd) !== cwd)
    throw new DevinHistoryError(
      "unsupported",
      "Devin cross-cwd history derivation is not supported",
    );
  // session/list is the native cwd authority, including for a cold source resume.
  await source.verifyCwd(cwd);
  const before = await readHistory(source);
  let count: number;
  if (input.kind === "fork") {
    const index = before.snapshot.turns.findIndex(
      (turn) => turn.checkpoint?.checkpointId === input.checkpoint.checkpointId,
    );
    if (index < 0)
      throw new DevinHistoryError(
        "checkpointNotFound",
        "Devin checkpoint is not on the source history",
      );
    count = index + 1;
  } else {
    if (!before.snapshot.turns.length)
      throw new DevinHistoryError("invalidState", "Devin cannot roll back empty history");
    count = before.snapshot.turns.length - 1;
  }
  const checkpoint = before.snapshot.turns[count - 1]?.checkpoint;
  if (count && !checkpoint)
    throw new DevinHistoryError(
      "checkpointNotFound",
      "Devin has no exact prompt step for this boundary",
    );
  const child = new DevinTransport(options);
  let childId: string | undefined;
  try {
    if (checkpoint) {
      // Assumption: forkFromStep accepts this Step target and retains its complete Turn.
      // No speculative alternative target or destructive revert is attempted.
      const response = await source.historyRequest("forkFromStep", {
        stepId: checkpoint.checkpointId,
      });
      const id = (response as { forkedSessionId?: unknown } | null)?.forkedSessionId;
      if (typeof id !== "string" || !id.trim() || id === source.sessionId)
        throw new Error("Devin fork did not return an independent native Session ID");
      childId = id;
    }
    // A one-Turn rollback needs no history copy: create a distinct writable empty Session.
    const info = await child.open(childId);
    childId = child.sessionId;
    if (!childId || childId === source.sessionId)
      throw new Error("Devin derived Session is not independent of its source");
    if (!child.nativeHistory) throw new Error("Devin child lost native history negotiation");
    await child.verifyCwd(cwd);
    const actual = await readHistory(child);
    const expected = comparable(before.snapshot).slice(0, count);
    if (
      !isDeepStrictEqual(comparable(actual.snapshot), expected) ||
      !isDeepStrictEqual(actual.transcript, before.transcript.slice(0, count))
    )
      throw new Error("Devin derived Session does not contain the exact retained history prefix");
    const after = await readHistory(source);
    if (
      !isDeepStrictEqual(comparable(after.snapshot), comparable(before.snapshot)) ||
      !isDeepStrictEqual(after.transcript, before.transcript)
    )
      throw new Error("Devin source history changed during derivation");
    return { transport: child, info };
  } catch (error) {
    let cleanupFailure = "";
    try {
      await child.close();
    } catch {
      cleanupFailure = "; child resource cleanup failed";
    }
    // No safe native deletion contract is wired; never guess at Session storage paths.
    const orphanId = childId ?? child.sessionId;
    const residue =
      orphanId && orphanId !== source.sessionId
        ? `; native child ${orphanId} may remain on disk (safe deletion unavailable)`
        : "";
    if (residue || cleanupFailure)
      throw new Error(
        `${error instanceof Error ? error.message : "Devin derivation failed"}${residue}${cleanupFailure}`,
      );
    throw error;
  }
}
