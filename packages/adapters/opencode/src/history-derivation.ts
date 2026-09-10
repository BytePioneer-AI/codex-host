import { isDeepStrictEqual } from "node:util";

import type { Session } from "@opencode-ai/sdk/v2";
import type { HostThreadSnapshot, OpenSessionInput } from "@codexhost/harness-adapter";

import { resolveOpenCodeForkBoundary, resolveOpenCodeLastTurnBoundary } from "./history.js";
import {
  readProjection,
  selectionMetadata,
  type OpenCodeSnapshotProjection,
} from "./history-projection.js";
import type { OpenCodeProviderCatalog } from "./model-catalog.js";
import { OpenCodeTransportError, type OpenCodeTransport } from "./protocol.js";

function semanticHistory(snapshot: HostThreadSnapshot) {
  return snapshot.turns.map((turn) => ({
    input: turn.input,
    items: turn.items.map(({ item, outcome }) => {
      const { itemId: _itemId, ...content } = item;
      void _itemId;
      return { item: content, outcome };
    }),
    outcome: turn.outcome,
    model: turn.model,
    checkpoint: Boolean(turn.checkpoint),
  }));
}

function sourceState(projection: OpenCodeSnapshotProjection) {
  return {
    id: projection.session.id,
    directory: projection.session.directory,
    revert: projection.session.revert,
    metadata: projection.session.metadata,
    permission: projection.session.permission,
    model: projection.model,
    variant: projection.variant,
    snapshot: projection.snapshot,
  };
}

export async function deriveOpenCodeHistory(options: {
  transport: OpenCodeTransport;
  source: Session;
  input: Extract<OpenSessionInput, { kind: "fork" | "rollbackLastTurn" }>;
  providers: OpenCodeProviderCatalog;
  toolOutputLimit: number;
  onCreated(session: Session): void;
}): Promise<Session> {
  const { transport, source, input, providers, toolOutputLimit } = options;
  const read = (id: string) =>
    readProjection(transport, id, providers, toolOutputLimit, { strictFileChanges: true });
  if ((await transport.getStatus(source.id)).type !== "idle") {
    throw new Error("OpenCode source Session is busy");
  }
  const before = await read(source.id);
  // Freeze evidence: a native client or a test transport may mutate returned objects.
  const expectedSource = structuredClone(sourceState(before));
  let messageID: string | undefined;
  let retainedCount: number;
  if (input.kind === "fork") {
    const boundary = resolveOpenCodeForkBoundary(before.session, before.messages, input.checkpoint);
    if (!boundary)
      throw new OpenCodeTransportError(
        "checkpointNotFound",
        "OpenCode Checkpoint is not on the source Session transcript",
      );
    messageID = boundary.messageID;
    retainedCount = boundary.sourceTurnCount;
  } else {
    const boundary = resolveOpenCodeLastTurnBoundary(before.session, before.messages);
    if (!boundary)
      throw new OpenCodeTransportError(
        "invalidState",
        "OpenCode Native Session has no Turn to roll back",
      );
    messageID = boundary.lastUserMessageID;
    retainedCount = boundary.sourceTurnCount - 1;
  }
  const expectedHistory = structuredClone(semanticHistory(before.snapshot).slice(0, retainedCount));
  let candidate = await transport.forkSession(source.id, messageID);
  if (candidate.id === source.id) {
    throw new OpenCodeTransportError(
      "protocolError",
      "OpenCode Fork did not create a distinct Native Session",
    );
  }
  const candidateID = candidate.id;
  options.onCreated(candidate);
  if (candidate.directory !== expectedSource.directory) {
    throw new OpenCodeTransportError("protocolError", "OpenCode Fork changed working directory");
  }
  if (expectedSource.model) {
    candidate = await transport.updateSessionMetadata(
      candidateID,
      selectionMetadata(candidate, expectedSource.model, expectedSource.variant),
    );
  }
  if (!isDeepStrictEqual(candidate.permission ?? [], expectedSource.permission ?? [])) {
    candidate = await transport.updateSessionPermission(
      candidateID,
      expectedSource.permission ?? [],
    );
  }
  const [derived, after, candidateStatus, sourceStatus] = await Promise.all([
    read(candidateID),
    read(source.id),
    transport.getStatus(candidateID),
    transport.getStatus(source.id),
  ]);
  if (
    derived.session.id !== candidateID ||
    candidate.id !== candidateID ||
    derived.session.directory !== before.session.directory ||
    candidateStatus.type !== "idle" ||
    sourceStatus.type !== "idle" ||
    !isDeepStrictEqual(semanticHistory(derived.snapshot), expectedHistory) ||
    !isDeepStrictEqual(sourceState(after), expectedSource) ||
    !isDeepStrictEqual(derived.model, expectedSource.model) ||
    derived.variant !== expectedSource.variant ||
    !isDeepStrictEqual(derived.session.permission ?? [], expectedSource.permission ?? [])
  ) {
    throw new OpenCodeTransportError(
      "protocolError",
      "OpenCode derived history, source or configuration changed during Fork",
    );
  }
  return derived.session;
}
