import type { Session, SnapshotFileDiff } from "@opencode-ai/sdk/v2";
import type { HostThreadSnapshot, HostUsage } from "@codexhost/harness-adapter";
import {
  openCodeAssistantMessages,
  projectOpenCodeHistory,
  reliableOpenCodeFileChanges,
  type OpenCodeMessageWithParts,
} from "./history.js";
import {
  openCodeContextWindow,
  type OpenCodeNativeModelRef,
  type OpenCodeProviderCatalog,
} from "./model-catalog.js";
import { openCodeFileIdentity, verifiedOpenCodeWorktree } from "./file-change-verification.js";
import { OpenCodeTransportError, type OpenCodeTransport } from "./protocol.js";
import { projectOpenCodeUsage } from "./usage.js";

export interface OpenCodeSnapshotProjection {
  session: Session;
  messages: OpenCodeMessageWithParts[];
  snapshot: HostThreadSnapshot;
  usage: HostUsage | null;
  model?: OpenCodeNativeModelRef;
  variant?: string;
}

const SELECTION_METADATA_KEY = "codexhost.selection.v1";
// Native summary persistence can lag the terminal Patch Part.
const DIFF_RECONCILIATION_DELAYS_MS = [25, 50, 100, 200, 400, 800] as const;

function storedSelection(
  session: Session,
): (OpenCodeNativeModelRef & { variant?: string }) | undefined {
  const value = session.metadata?.[SELECTION_METADATA_KEY];
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const providerID = Reflect.get(value, "providerID");
  const modelID = Reflect.get(value, "modelID");
  const variant = Reflect.get(value, "variant");
  if (
    typeof providerID !== "string" ||
    !providerID ||
    typeof modelID !== "string" ||
    !modelID ||
    (variant !== undefined && (typeof variant !== "string" || !variant))
  ) {
    return undefined;
  }
  return { providerID, modelID, ...(typeof variant === "string" ? { variant } : {}) };
}

export function selectionMetadata(
  session: Session,
  model: OpenCodeNativeModelRef,
  variant: string | undefined,
): Record<string, unknown> {
  return {
    ...session.metadata,
    [SELECTION_METADATA_KEY]: {
      providerID: model.providerID,
      modelID: model.modelID,
      ...(variant ? { variant } : {}),
    },
  };
}

function nativeModelFromSession(
  session: Session,
  messages: readonly OpenCodeMessageWithParts[],
): OpenCodeNativeModelRef | undefined {
  const stored = storedSelection(session);
  if (stored) return { providerID: stored.providerID, modelID: stored.modelID };
  if (session.model) {
    return { providerID: session.model.providerID, modelID: session.model.id };
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const info = messages[index]?.info;
    if (info?.role === "user") return info.model;
  }
  return undefined;
}

function nativeVariantFromSession(
  session: Session,
  messages: readonly OpenCodeMessageWithParts[],
): string | undefined {
  const stored = storedSelection(session);
  if (stored) return stored.variant;
  if (session.model?.variant) return session.model.variant;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const info = messages[index]?.info;
    if (info?.role === "user") return info.model.variant;
  }
  return undefined;
}

export function turnNativePatchFiles(
  messages: readonly OpenCodeMessageWithParts[],
  userMessageID: string,
): string[] {
  const start = messages.findIndex(({ info }) => info.id === userMessageID);
  if (start < 0) return [];
  let end = start + 1;
  while (end < messages.length && messages[end]?.info.role !== "user") end += 1;
  return [
    ...new Set(
      messages
        .slice(start + 1, end)
        .flatMap(({ parts }) => parts.flatMap((part) => (part.type === "patch" ? part.files : []))),
    ),
  ];
}

export async function readTurnDiff(
  transport: OpenCodeTransport,
  sessionID: string,
  userMessageID: string,
  nativePatchFiles: readonly string[],
  options: { strict?: boolean; worktree?: string } = {},
): Promise<SnapshotFileDiff[]> {
  const strict = options.strict === true;
  for (let attempt = 0; ; attempt += 1) {
    let diffs: SnapshotFileDiff[];
    try {
      diffs = await transport.getDiff(sessionID, userMessageID);
    } catch (error) {
      if (strict) {
        throw new OpenCodeTransportError(
          "protocolError",
          "OpenCode could not verify FileChange history",
          { cause: error },
        );
      }
      diffs = [];
    }
    const reliableChanges = reliableOpenCodeFileChanges(diffs);
    const worktree = options.worktree;
    const reliablePaths = worktree
      ? reliableChanges.map(({ path: file }) => openCodeFileIdentity(file, worktree))
      : [];
    const nativePatchPaths = worktree
      ? nativePatchFiles.map((file) => openCodeFileIdentity(file, worktree))
      : [];
    const completeStrictProjection =
      Boolean(worktree) &&
      reliableChanges.length === diffs.length &&
      reliablePaths.every((file): file is string => file !== undefined) &&
      nativePatchPaths.every((file) => file !== undefined && reliablePaths.includes(file));
    if (
      strict
        ? completeStrictProjection
        : reliableChanges.length > 0 || nativePatchFiles.length === 0
    ) {
      return diffs;
    }
    if (attempt >= DIFF_RECONCILIATION_DELAYS_MS.length) {
      if (strict) {
        throw new OpenCodeTransportError(
          "protocolError",
          "OpenCode did not expose complete reliable FileChange history",
        );
      }
      return diffs;
    }
    await new Promise<void>((resolve) =>
      setTimeout(resolve, DIFF_RECONCILIATION_DELAYS_MS[attempt]),
    );
  }
}

export async function readProjection(
  transport: OpenCodeTransport,
  sessionID: string,
  providerCatalog: OpenCodeProviderCatalog,
  toolOutputLimit: number,
  options: { strictFileChanges?: boolean } = {},
): Promise<OpenCodeSnapshotProjection> {
  const strictFileChanges = options.strictFileChanges === true;
  const [session, messages, paths] = await Promise.all([
    transport.getSession(sessionID),
    transport.getMessages(sessionID),
    strictFileChanges
      ? transport.getPaths().catch((error: unknown) => {
          throw new OpenCodeTransportError(
            "protocolError",
            "OpenCode could not verify worktree paths",
            { cause: error },
          );
        })
      : undefined,
  ]);
  const worktree = paths ? verifiedOpenCodeWorktree(session.directory, paths) : undefined;
  if (strictFileChanges && !worktree) {
    throw new OpenCodeTransportError(
      "protocolError",
      "OpenCode returned inconsistent Session and worktree paths",
    );
  }
  const userMessageIds = messages
    .filter(({ info }) => info.role === "user")
    .map(({ info }) => info.id);
  const diffEntries = await Promise.all(
    userMessageIds.map(async (messageID) => {
      const diffs = await readTurnDiff(
        transport,
        sessionID,
        messageID,
        turnNativePatchFiles(messages, messageID),
        { strict: strictFileChanges, ...(worktree ? { worktree } : {}) },
      );
      return [messageID, diffs] as const;
    }),
  );
  const snapshot = projectOpenCodeHistory({
    session,
    messages,
    diffsByUserMessageId: new Map(diffEntries),
    toolOutputLimit,
  });
  const model = nativeModelFromSession(session, messages);
  const nativeVariant = nativeVariantFromSession(session, messages);
  const nativeModel = model
    ? providerCatalog.all.find(({ id }) => id === model.providerID)?.models[model.modelID]
    : undefined;
  // Codewiz can persist the default selection as the literal "default".
  // Keep a real named variant when the Model advertises one with that name.
  const variant =
    nativeVariant === "default" &&
    nativeModel &&
    !Object.hasOwn(nativeModel.variants ?? {}, "default")
      ? undefined
      : nativeVariant;
  const usage = projectOpenCodeUsage(
    openCodeAssistantMessages(session, messages),
    model ? openCodeContextWindow(providerCatalog, model) : undefined,
  );
  return {
    session,
    messages,
    snapshot,
    usage,
    ...(model ? { model } : {}),
    ...(variant ? { variant } : {}),
  };
}
