// Narrow live probe: ONLY workspace discovery, bridge attachment, deferred create and close.
// In particular, modelSelectionService.getView() is forbidden: it can return personal API Keys.
import { randomUUID } from "node:crypto";
import { bounded, ProbeError } from "./paired-relay.mjs";

function createdSessionId(snapshot, workspacePath) {
  if (
    typeof snapshot?.session?.sessionId !== "string" ||
    !snapshot.session.sessionId.trim() ||
    snapshot.session.sessionId.length > 512 ||
    snapshot.session.workspace?.workspacePath !== workspacePath ||
    !Array.isArray(snapshot.messages) ||
    snapshot.messages.length !== 0 ||
    snapshot.projection?.currentTurnId
  )
    throw new ProbeError("invalid-session-snapshot");
  return snapshot.session.sessionId;
}

function projectCatalog(snapshot) {
  if (!Array.isArray(snapshot.settings?.model?.available))
    throw new ProbeError("invalid-model-catalog");
  const text = (value, max = 512) => {
    if (typeof value !== "string" || !value.length || value.length > max)
      throw new ProbeError("invalid-model-catalog");
    return value;
  };
  return snapshot.settings.model.available
    .filter((model) => !model.disabledReason)
    .map((model) => ({
      providerId: text(model.ref?.providerId),
      modelId: text(model.ref?.modelId),
      label: text(model.label),
      thinking: (model.reasoning?.levels ?? []).map((level) => ({
        value: text(level.value),
        label: text(level.label),
      })),
    }));
}

export async function probePairedCatalog(
  relay,
  { cwd, createProtocol, createRpc, timeoutMs = 15_000 },
) {
  let protocol, rpc, disposeDegraded, removeListener;
  try {
    const listing = await relay.request("workspace-list-request", "workspace-list-response");
    const workspaces = listing.result?.workspaces;
    if (listing.success !== true || !Array.isArray(workspaces))
      throw new ProbeError("invalid-workspace-list");
    const matches = workspaces.filter(
      (workspace) => workspace.kind === "local" && workspace.workspacePath === cwd,
    );
    if (matches.length !== 1) throw new ProbeError("workspace-not-open-or-ambiguous");
    const workspace = matches[0];
    if (workspace.connectionState && workspace.connectionState !== "connected")
      throw new ProbeError("workspace-offline");
    const identity = { bridgeSessionId: `probe-${randomUUID()}`, bridgeGeneration: 1 };
    protocol = createProtocol({
      ...identity,
      sendFrame: (frame) => {
        try {
          relay.sendPayload(frame);
          return true;
        } catch {
          relay.close();
          return false;
        }
      },
    });
    disposeDegraded = protocol.onDegraded(() => relay.close());
    // Listen before requesting attachment: the server may send its channel handshake immediately.
    removeListener = relay.onPayload((payload) => {
      if (
        payload.zcode_type === "bridge-degraded" &&
        payload.bridgeSessionId === identity.bridgeSessionId
      )
        relay.close();
      else if (payload.zcode_type === "rpc-frame" || payload.zcode_type === "rpc-frame-ack")
        protocol.acceptPayload(payload);
    });
    rpc = createRpc(protocol.protocol);
    const ready = await relay.request("workspace-bridge-open", "workspace-bridge-ready", {
      ...identity,
      workspaceKey: workspace.workspaceIdentity?.trim() || workspace.workspacePath,
    });
    const bridge = ready.bridge;
    if (
      ready.bridgeSessionId !== identity.bridgeSessionId ||
      ready.bridgeGeneration !== 1 ||
      bridge?.bridgeSessionId !== identity.bridgeSessionId ||
      bridge.bridgeGeneration !== 1 ||
      bridge.kind !== "local" ||
      bridge.workspacePath !== workspace.workspacePath ||
      bridge.workspaceKey !== (workspace.workspaceIdentity?.trim() || workspace.workspacePath) ||
      bridge.recoveryId !== undefined
    ) {
      throw new ProbeError("unexpected-workspace-bridge");
    }
    const call = async (method, params) => {
      if (method !== "createSession" && method !== "closeSession")
        throw new ProbeError("forbidden-probe-method");
      try {
        if (relay.signal.aborted) throw new Error();
        return await bounded(
          rpc.getChannel("zcode-agent").call(method, [params]),
          timeoutMs,
          "native-request-timeout",
          relay.signal,
        );
      } catch {
        throw new ProbeError("native-request-failed-or-unconfirmed");
      }
    };
    // Native create rejects client-supplied IDs except for imported histories. Do not
    // change to an import to manufacture idempotency. Lost create receipts are uncertain:
    // never retry, enumerate other Sessions, or guess an ID for cleanup.
    const scope = {
      workspacePath: workspace.workspacePath,
      ...(workspace.workspaceIdentity ? { workspaceIdentity: workspace.workspaceIdentity } : {}),
    };
    let catalog, sessionId;
    try {
      const snapshot = await call("createSession", {
        ...scope,
        persistence: "deferred",
        titleGenerationEnabled: false,
        mcpServers: [],
      });
      sessionId = createdSessionId(snapshot, workspace.workspacePath);
      catalog = projectCatalog(snapshot);
    } finally {
      // No success is reported without a verified create identity and confirmed cleanup.
      try {
        if (
          !sessionId ||
          (await call("closeSession", { ...scope, sessionId, expectedPersistence: "deferred" })) !==
            true
        )
          throw new Error();
      } catch {
        throw new ProbeError("deferred-session-cleanup-unconfirmed");
      }
    }
    return { models: catalog, cleanupConfirmed: true };
  } finally {
    removeListener?.();
    disposeDegraded?.dispose();
    rpc?.dispose();
    protocol?.dispose();
    relay.close();
  }
}
