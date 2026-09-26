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
import { resolveGatewayModel } from "./gateway-configuration.js";
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
  steer: true,
};
export function gatewayPermissionModes() {
  return harnessPermissionModeCatalogSchema.parse({
    modes: [
      {
        id: "default",
        label: "原生审批策略",
        description: "遵循 Hermes 全局审批策略，关闭本会话 YOLO。",
      },
      {
        id: "dont_ask",
        label: "会话 YOLO",
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

/** One stdio gateway owns one public Session. Legacy ACP refs never enter this path. */
export async function openGatewaySession(
  input: OpenSessionInput,
  transport: HermesGatewayTransport,
  onSettle: (session: HermesSession) => void,
  inheritedPermissionMode?: string,
): Promise<HermesSession> {
  const source =
    input.kind === "create" ? null : input.kind === "resume" ? input.nativeRef : input.sourceRef;
  if (source && !isGatewayRef(source))
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
      "Hermes gateway supports native policy and session YOLO; accept_edits remains ACP-only",
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
    await transport.prepareSession();
    await transport.start();
    if (source && (input.kind === "fork" || input.kind === "rollbackLastTurn")) {
      sourceHistory = new HermesGatewayHistory({
        python: transport.python,
        cwd: transport.cwd,
        environment: transport.environment,
        nativeSessionId: source.nativeSessionId,
      });
      nativeRef = await sourceHistory.derive(
        input.kind === "fork" ? { checkpoint: input.checkpoint } : { rollbackLastTurn: true },
      );
    }
    const choice = model ? await resolveGatewayModel(transport, model) : null;
    const response = await transport.request(
      nativeRef ? "session.resume" : "session.create",
      nativeRef
        ? { session_id: nativeRef.nativeSessionId, eager_build: true, omit_messages: true }
        : {
            cwd: input.cwd,
            close_on_disconnect: true,
            ...(choice ? choice : {}),
            ...(input.kind === "create" && input.thinkingOptionId
              ? { reasoning_effort: input.thinkingOptionId }
              : {}),
          },
    );
    const runtimeId = gatewayString(response.session_id);
    const storedId = nativeRef?.nativeSessionId || gatewayString(response.stored_session_id);
    if (!runtimeId || !storedId) throw new Error("Hermes gateway did not return Session identity");
    let info = gatewayRecord(response.info);
    if (info.lazy === true) info = await transport.waitForSession(runtimeId);
    const nativeCwd = gatewayString(info.cwd);
    if (nativeCwd && !(await sameDirectory(nativeCwd, input.cwd)))
      throw new HermesGatewayHistoryError(
        "unsupported",
        "Hermes resumed a different native working directory",
      );
    const bridge = new HermesGatewaySessionTransport(transport, runtimeId, storedId, info);
    if (!nativeRef)
      await bridge.history.ensureCreated({
        cwd: input.cwd,
        model: gatewayString(info.model),
        provider: gatewayString(info.provider),
        reasoningEffort: gatewayString(info.reasoning_effort),
      });
    const physicalId = await bridge.history.resolvePhysicalSessionId();
    if (gatewayString(info.stored_session_id) !== physicalId)
      throw new Error("Hermes live Session and persisted history identities differ");
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
      supportsDerivation: true,
      onSettle,
    });
  } catch (error) {
    await transport.close().catch(() => undefined);
    if (sourceHistory && nativeRef)
      await sourceHistory.discardDerived(nativeRef).catch(() => false);
    throw error;
  }
}
