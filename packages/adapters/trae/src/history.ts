import type { OpenSessionInput } from "@codexhost/harness-adapter";
import { nativeCheckpointRefSchema } from "@codexhost/shared-contracts";
import { nativeId } from "./connection.js";
import { historyFrom } from "./projection.js";
import { record, requiredText, TraeError } from "./protocol.js";
import type { TraeTransport } from "./transport.js";

/** Native rollback is destructive: apply it only to a new native Fork, never the source. */
export async function openHistory(
  transport: TraeTransport,
  input: Exclude<OpenSessionInput, { kind: "create" }>,
  cwd: string,
): Promise<unknown> {
  const source = nativeId(input.kind === "resume" ? input.nativeRef : input.sourceRef);
  if (input.kind === "resume") {
    const response = await transport.call("thread/resume", { threadId: source, cwd });
    if (record(record(response).thread).id !== source)
      throw new TraeError("protocolError", "Trae resume changed Session identity");
    return response;
  }
  const before = historyFrom(
    await transport.call("thread/read", { threadId: source, includeTurns: true }),
    source,
  );
  if (before.turns.some((t) => t.outcome.status === "unknown"))
    throw new TraeError("sessionBusy", "Trae source has an active Turn", true);
  let retained = before.turns.length;
  if (input.kind === "fork") {
    const cp = nativeCheckpointRefSchema.safeParse(input.checkpoint);
    if (
      !cp.success ||
      cp.data.harnessId !== "trae" ||
      cp.data.formatVersion !== 1 ||
      cp.data.nativeSessionId !== source
    )
      throw new TraeError("checkpointNotFound", "Checkpoint does not belong to this Trae Session");
    retained =
      before.turns.findIndex((t) => t.checkpoint?.checkpointId === cp.data.checkpointId) + 1;
    if (!retained)
      throw new TraeError("checkpointNotFound", "Trae checkpoint is absent from native history");
  } else if (!retained) throw new TraeError("invalidState", "Trae has no Turn to roll back");
  const fork = await transport.call("thread/fork", {
    threadId: source,
    cwd,
    ...(input.kind === "fork"
      ? { lastTurnId: before.turns.at(retained - 1)?.nativeTurnRef.nativeTurnKey }
      : {}),
  });
  const id = requiredText(record(record(fork).thread).id, "fork thread.id");
  if (id === source) throw new TraeError("protocolError", "Trae Fork reused the source identity");
  // Keep an unverified derived Session for diagnosis rather than deleting unknown native data.
  if (input.kind === "rollbackLastTurn") {
    await transport.call("thread/rollback", { threadId: id, numTurns: 1 });
    retained--;
  }
  const after = historyFrom(
    await transport.call("thread/read", { threadId: id, includeTurns: true }),
    id,
  );
  const content = (turns: typeof before.turns) =>
    turns.map((t) => ({
      key: t.nativeTurnRef.nativeTurnKey,
      input: t.input,
      items: t.items,
      outcome: t.outcome,
    }));
  if (
    JSON.stringify(content(after.turns)) !==
    JSON.stringify(content(before.turns.slice(0, retained)))
  )
    throw new TraeError(
      "protocolError",
      "Trae derived history did not preserve the exact Turn boundary",
    );
  const sourceAfter = historyFrom(
    await transport.call("thread/read", { threadId: source, includeTurns: true }),
    source,
  );
  if (JSON.stringify(content(sourceAfter.turns)) !== JSON.stringify(content(before.turns)))
    throw new TraeError("sessionBusy", "Trae source history changed during derivation", true);
  const resumed = await transport.call("thread/resume", { threadId: id, cwd });
  if (record(record(resumed).thread).id !== id)
    throw new TraeError("protocolError", "Trae derived resume changed Session identity");
  return resumed;
}
