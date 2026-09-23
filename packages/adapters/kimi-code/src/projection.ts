import type {
  HarnessModelCatalog,
  HarnessSessionCapabilities,
  HarnessSessionState,
  HostItem,
  HostItemOutcome,
  HostItemSnapshot,
  HostTurnSnapshot,
  TurnOutcome,
} from "@codexhost/harness-adapter";
import {
  harnessModelRefSchema,
  harnessPermissionModeIdSchema,
  harnessThinkingOptionIdSchema,
  hostItemIdSchema,
  type JsonValue,
  type NativeSessionRef,
} from "@codexhost/shared-contracts";
import {
  HARNESS_ID,
  KimiError,
  parse,
  sessionPath,
  transcriptSchema,
  type KimiTransport,
  type NativeFrame,
  type NativeModel,
  type NativeStatus,
  type NativeTurn,
} from "./protocol.js";

export const capabilities: HarnessSessionCapabilities = {
  configuration: {
    selectModel: true,
    selectThinkingOption: true,
    selectPermissionMode: true,
    permissionModeScope: "live",
  },
  history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
  subagents: { observe: false, readTranscript: false },
  autonomousTurns: { observe: false },
};
export function modelRef(alias: string) {
  return harnessModelRefSchema.parse({ id: `kimi_${Buffer.from(alias).toString("base64url")}` });
}
export function catalog(models: NativeModel[], defaultAlias?: string): HarnessModelCatalog {
  const efforts = [...new Set(models.flatMap((model) => model.support_efforts ?? []))];
  return {
    models: models.map((model) => ({
      ref: modelRef(model.model),
      label: model.display_name || model.model,
      supportedThinkingOptionIds: (model.support_efforts ?? []).map((effort) =>
        harnessThinkingOptionIdSchema.parse(effort),
      ),
    })),
    thinkingOptions: efforts.map((effort) => ({
      id: harnessThinkingOptionIdSchema.parse(effort),
      label: effort,
    })),
    ...(defaultAlias && models.some((model) => model.model === defaultAlias)
      ? { defaultModel: modelRef(defaultAlias) }
      : {}),
  };
}
export function sessionState(
  ref: NativeSessionRef,
  status: NativeStatus,
  models: NativeModel[],
): HarnessSessionState {
  const model = models.find((entry) => entry.model === status.model);
  const available = (model?.support_efforts ?? []).map((effort) => ({
    id: harnessThinkingOptionIdSchema.parse(effort),
    label: effort,
  }));
  return {
    nativeRef: ref,
    ...(status.model
      ? {
          effectiveModel: modelRef(status.model),
          resolvedModelLabel: model?.display_name || status.model,
        }
      : {}),
    ...(status.thinking_level
      ? { effectiveThinkingOptionId: harnessThinkingOptionIdSchema.parse(status.thinking_level) }
      : {}),
    // Only advertise a complete list when the native catalog includes the observed effort.
    ...(available.some((option) => option.id === status.thinking_level) || !status.thinking_level
      ? { availableThinkingOptions: available }
      : {}),
    effectivePermissionModeId: harnessPermissionModeIdSchema.parse(status.permission),
  };
}
export async function readTurns(
  transport: KimiTransport,
  sessionId: string,
): Promise<NativeTurn[]> {
  const turns = new Map<string, NativeTurn>();
  let before: string | undefined;
  const cursors = new Set<string>();
  for (let pages = 0; pages < 10_000; pages++) {
    const page = parse(
      transcriptSchema,
      await transport.request(
        `${sessionPath(sessionId)}/transcript?agent_id=main&page_size=100${before ? `&before_turn=${encodeURIComponent(before)}` : ""}`,
      ),
    );
    if (page.agent_id !== "main")
      throw new KimiError("protocolError", "Kimi Code returned another agent's transcript");
    const batch = page.items.filter((item): item is NativeTurn => item.kind === "turn");
    for (const turn of batch) {
      if (turns.has(turn.turnId))
        throw new KimiError("protocolError", "Kimi Code transcript pages overlap");
      turns.set(turn.turnId, turn);
    }
    if (!page.has_more)
      return [...turns.values()].sort((left, right) => left.ordinal - right.ordinal);
    before = batch.toSorted((left, right) => left.ordinal - right.ordinal)[0]?.turnId;
    if (!before || cursors.has(before))
      throw new KimiError("protocolError", "Kimi Code transcript pagination made no progress");
    cursors.add(before);
  }
  throw new KimiError(
    "protocolError",
    "Kimi Code transcript exceeds the 1,000,000-turn safety limit",
  );
}

/** The pinned API returns the newest turns without a cursor. A newly submitted
 * prompt cannot be in an older page; absence means its transcript is not ready. */
export async function readActiveTurn(
  transport: KimiTransport,
  sessionId: string,
  promptId: string,
): Promise<NativeTurn | undefined> {
  const page = parse(
    transcriptSchema,
    await transport.request(`${sessionPath(sessionId)}/transcript?agent_id=main&page_size=100`),
  );
  if (page.agent_id !== "main")
    throw new KimiError("protocolError", "Kimi Code returned another agent's transcript");
  return page.items.find(
    (item): item is NativeTurn => item.kind === "turn" && item.triggerPromptId === promptId,
  );
}
function record(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}
function outputText(value: JsonValue | undefined): string {
  if (value === undefined) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}
const OUTPUT_LIMIT = 1024 * 1024;
export function projectFrame(
  sessionId: string,
  turn: NativeTurn,
  frame: NativeFrame,
): HostItem | undefined {
  const itemId = hostItemIdSchema.parse(`kimi:${sessionId}:${turn.turnId}:${frame.frameId}`);
  if (frame.kind === "text")
    return frame.role === "user" ? undefined : { type: "agentMessage", itemId, text: frame.text };
  if (frame.kind === "thinking") return { type: "reasoning", itemId, text: frame.text };
  if (frame.kind === "notice")
    return { type: "agentMessage", itemId, text: frame.message, phase: "commentary" };
  const output =
    frame.output === undefined ? (frame.progress?.text ?? "") : outputText(frame.output);
  const display = record(frame.display);
  if (display?.kind === "command" && typeof display.command === "string") {
    const result = record(frame.output);
    return {
      type: "commandExecution",
      itemId,
      command: display.command,
      ...(typeof display.cwd === "string" ? { cwd: display.cwd } : {}),
      output: output.slice(0, OUTPUT_LIMIT),
      ...(output.length > OUTPUT_LIMIT ? { outputTruncated: true } : {}),
      ...(typeof result?.exitCode === "number" ? { exitCode: result.exitCode } : {}),
    };
  }
  return {
    type: "toolExecution",
    itemId,
    toolName: frame.name,
    arguments: frame.input ?? null,
    ...(output
      ? {
          output: {
            content: [{ type: "text", text: output.slice(0, OUTPUT_LIMIT) }],
            ...(output.length > OUTPUT_LIMIT ? { truncated: true } : {}),
          },
        }
      : {}),
  };
}
export function terminal(turn: NativeTurn): boolean {
  return !["queued", "running"].includes(turn.state);
}
export function turnOutcome(turn: NativeTurn): TurnOutcome {
  if (turn.state === "completed") return { status: "succeeded" };
  if (turn.state === "cancelled") return { status: "cancelled" };
  return {
    status: "failed",
    error: { code: "nativeFailure", message: "Kimi Code turn failed", retryable: false },
  };
}
export function frameOutcome(frame: NativeFrame, turn: NativeTurn): HostItemOutcome {
  if (frame.kind === "tool" && frame.state === "error")
    return {
      status: "failed",
      error: { code: "nativeFailure", message: "Kimi Code tool failed", retryable: false },
    };
  if (frame.kind !== "tool" || frame.state === "done") return { status: "succeeded" };
  return turnOutcome(turn);
}
export function projectTurn(sessionId: string, turn: NativeTurn): HostTurnSnapshot {
  const items: HostItemSnapshot[] = [];
  for (const step of turn.steps)
    for (const frame of step.frames) {
      const item = projectFrame(sessionId, turn, frame);
      if (item) items.push({ item, outcome: frameOutcome(frame, turn) });
    }
  return {
    nativeTurnRef: {
      harnessId: HARNESS_ID,
      nativeSessionId: sessionId,
      nativeTurnKey: turn.turnId,
      formatVersion: 1,
    },
    input: turn.prompt !== undefined ? [{ type: "text", text: turn.prompt }] : [],
    items,
    outcome: terminal(turn)
      ? turnOutcome(turn)
      : { status: "unknown", reason: "The native turn has no terminal state" },
    ...(turn.startedAt && Number.isFinite(Date.parse(turn.startedAt))
      ? { startedAtMs: Date.parse(turn.startedAt) }
      : {}),
    ...(turn.endedAt && Number.isFinite(Date.parse(turn.endedAt))
      ? { completedAtMs: Date.parse(turn.endedAt) }
      : {}),
  };
}
