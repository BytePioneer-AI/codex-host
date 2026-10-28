import path from "node:path";
import { realpath } from "node:fs/promises";
import type { OpenSessionInput, HarnessSessionCapabilities } from "@codexhost/harness-adapter";
import {
  harnessPermissionModeCatalogSchema,
  nativeSessionRefSchema,
  type NativeSessionRef,
} from "@codexhost/shared-contracts";
import { type HermesGatewayTransport, gatewayString, gatewayRecord } from "./gateway-transport.js";
import { HermesGatewayHistory, HermesGatewayHistoryError } from "./gateway-history.js";
import { HermesGatewaySessionTransport } from "./gateway-session-transport.js";
import { decodeHermesModelRefId } from "./hermes-models.js";
import { HermesSession } from "./hermes-session.js";

async function sameDirectory(left: string, right: string): Promise<boolean> {
  return (
    (await realpath(left).catch(() => path.resolve(left))) ===
    (await realpath(right).catch(() => path.resolve(right)))
  );
}

export const gatewayCapabilities: HarnessSessionCapabilities = {
  configuration: {
    selectModel: true,
    selectThinkingOption: true,
    selectPermissionMode: true,
    permissionModeScope: "live",
  },
  history: { fork: true, forkAcrossCwd: false, rollbackLastTurn: true },
};
export function gatewayPermissionModes() {
  return harnessPermissionModeCatalogSchema.parse({
    modes: [
      {
        id: "default",
        label: "原生审批策略",
        localizations: {
          en: {
            label: "Native approval policy",
            description: "Follow the Hermes global approval policy; disable YOLO for this Session.",
          },
        },
        description: "遵循 Hermes 全局审批策略，关闭本会话 YOLO。",
      },
      {
        id: "dont_ask",
        label: "会话 YOLO",
        localizations: {
          en: {
            label: "Session YOLO",
            description: "Automatically approve Hermes tool actions in this Session.",
          },
        },
        description: "本会话自动批准 Hermes 工具操作。",
        dangerous: true,
      },
    ],
    defaultModeId: "default",
  });
}
export function isGatewayRef(ref: NativeSessionRef): boolean {
  return ref.harnessId === "hermes" && gatewayRecord(ref.locator).transport === "gateway";
}

/** One stdio Gateway owns one public Session, including native identities from import discovery. */
export async function openGatewaySession(
  input: OpenSessionInput,
  transport: HermesGatewayTransport,
  onSettle: (session: HermesSession) => void,
  inheritedPermissionMode?: string,
): Promise<HermesSession> {
  const source =
    input.kind === "create" ? null : input.kind === "resume" ? input.nativeRef : input.sourceRef;
  if (
    source &&
    !isGatewayRef(source) &&
    !(input.kind === "resume" && source.harnessId === "hermes" && !source.locator)
  )
    throw new HermesGatewayHistoryError(
      "unsupported",
      "This Hermes native reference is not a supported gateway Session",
    );
  const savedMode = source ? gatewayRecord(source.locator).permissionModeId : undefined;
  const mode =
    (input.kind === "fork" ? inheritedPermissionMode : input.permissionModeId) ??
    (typeof savedMode === "string" ? savedMode : undefined);
  if (mode && mode !== "default" && mode !== "dont_ask")
    throw new HermesGatewayHistoryError(
      "unsupported",
      "Hermes gateway supports only native approval policy and session YOLO",
    );
  if (
    input.kind === "create" &&
    input.executionPolicy === "unattended-full-access" &&
    mode &&
    mode !== "dont_ask"
  )
    throw new HermesGatewayHistoryError(
      "invalidRequest",
      "unattended-full-access requires dont_ask",
    );
  const model =
    input.kind !== "fork" && input.model ? decodeHermesModelRefId(input.model.id) : null;
  if (input.kind !== "fork" && input.model && !model)
    throw new HermesGatewayHistoryError("invalidRequest", "Model Ref does not belong to Hermes");
  if (
    source &&
    gatewayRecord(source.locator).cwd &&
    !(await sameDirectory(String(gatewayRecord(source?.locator).cwd), input.cwd))
  )
    throw new HermesGatewayHistoryError(
      "unsupported",
      "Hermes gateway preserves the native Session working directory",
    );
  let nativeRef = source;
  let sourceHistory: HermesGatewayHistory | undefined;
  try {
    // A warm transport from the pool already prepared (delegation skill) and
    // started (bridge + capabilities); skip straight to the session RPCs.
    if (!transport.started) {
      await transport.prepareSession();
      await transport.start();
    }
    if (source && (input.kind === "fork" || input.kind === "rollbackLastTurn")) {
      sourceHistory = new HermesGatewayHistory({
        python: transport.runtime,
        cwd: transport.cwd,
        environment: transport.environment,
        nativeSessionId: source.nativeSessionId,
      });
      nativeRef = await sourceHistory.derive(
        input.kind === "fork" ? { checkpoint: input.checkpoint } : { rollbackLastTurn: true },
      );
    }
    // Canonical create/mutate run Hermes's own provider-aware model resolution
    // (switch_model) server-side, so the qualified id goes over the wire as-is
    // and no helper interpreter is spawned to pre-split it.
    const response = await transport.request(
      nativeRef ? "session.resume" : "session.create",
      // Canonical wire (hermes-gateway-v1, CanonicalCreateParams/CanonicalResumeParams):
      // no close_on_disconnect / eager_build keys, and the effort key is "reasoning".
      nativeRef
        ? { session_id: nativeRef.nativeSessionId, omit_messages: true }
        : {
            cwd: input.cwd,
            ...(model ? { model } : {}),
            ...(input.kind === "create" && input.thinkingOptionId
              ? { reasoning: input.thinkingOptionId }
              : {}),
          },
    );
    const runtimeId = gatewayString(response.session_id);
    const storedId = nativeRef?.nativeSessionId || gatewayString(response.stored_session_id);
    if (!runtimeId || !storedId) throw new Error("Hermes gateway did not return Session identity");
    const info = gatewayRecord(response.info);
    // Canonical lazy sessions build their agent on the first prompt and never emit
    // a non-lazy session.info event (the official TUI renders lazy info with
    // placeholders), so waiting here always times out. The lazy snapshot carries
    // cwd/model/provider already.
    const nativeCwd = gatewayString(info.cwd);
    if (nativeCwd && !(await sameDirectory(nativeCwd, input.cwd)))
      throw new HermesGatewayHistoryError(
        "unsupported",
        "Hermes resumed a different native working directory",
      );
    const bridge = new HermesGatewaySessionTransport(transport, runtimeId, storedId, info, {
      revision: response.revision,
      generation: response.execution_generation,
      subscriptionId: response.subscription_id,
    });
    // Canonical create persists the state.db row itself (source, cwd, frozen
    // model/reasoning policy), and a fresh session's public id IS its physical
    // id, so the create path needs no helper interpreter at all; resume/fork
    // still reconcile through the native reader.
    if (nativeRef) {
      const physicalId = await bridge.history.resolvePhysicalSessionId();
      if (storedId !== physicalId)
        throw new Error("Hermes live Session and persisted history identities differ");
    }
    // Every selection is confirmed by the live native agent, including persisted runtime settings.
    if (model) await bridge.setModel(model);
    if (input.kind !== "fork" && input.thinkingOptionId)
      await bridge.setThinking(input.thinkingOptionId);
    const desiredMode =
      input.kind === "create" && input.executionPolicy === "unattended-full-access"
        ? "dont_ask"
        : mode;
    if (desiredMode) await bridge.setPermissionMode(desiredMode);
    const open = await bridge.openResult();
    return new HermesSession({
      nativeRef: nativeSessionRefSchema.parse({
        harnessId: "hermes",
        nativeSessionId: storedId,
        formatVersion: 1,
        locator: {
          transport: "gateway",
          cwd: input.cwd,
          permissionModeId: open.session.modes?.currentModeId,
        },
      }),
      transport: bridge,
      open,
      onSettle,
    });
  } catch (error) {
    await transport.close().catch(() => undefined);
    if (sourceHistory && nativeRef)
      await sourceHistory.discardDerived(nativeRef).catch(() => false);
    throw error;
  }
}
