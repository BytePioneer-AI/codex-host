export interface RendererDebugger {
  isAttached(): boolean;
  attach(version: string): void;
  detach(): void;
  sendCommand(method: string, parameters?: Record<string, unknown>): Promise<unknown>;
}

export interface RendererWebContents {
  isDestroyed(): boolean;
  getType(): string;
  debugger: RendererDebugger;
}

export interface DraftPrewarmPolicyTarget {
  [key: string]: unknown;
}

export interface RendererHostRequestBridge {
  sendRequest(method: string, parameters: unknown, options?: unknown): unknown;
}

export function installDraftPrewarmPolicyBridge(
  bridge: RendererHostRequestBridge,
  hostId: string,
  target: DraftPrewarmPolicyTarget,
): { state: "ready"; reason: "owned-request-bridge" } {
  const existing = target.__codexhostDraftPrewarmPolicyV1 as { dispose?: () => void } | undefined;
  existing?.dispose?.();

  const originalSend = bridge.sendRequest;
  let selectedModel: string | null = null;
  let clearInFlight: Promise<void> | null = null;
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  const routeCollaborationMode = (method: string, parameters: unknown): unknown => {
    if (selectedModel === null || !isRecord(parameters)) return parameters;
    const collaborationMode = parameters.collaborationMode;
    const settings = isRecord(collaborationMode) ? collaborationMode.settings : null;
    if (!isRecord(collaborationMode) || !isRecord(settings)) {
      throw new Error(`Codex ${method} omitted collaborationMode.settings`);
    }
    return {
      ...parameters,
      collaborationMode: {
        ...collaborationMode,
        settings: { ...settings, model: selectedModel },
      },
    };
  };
  const routeThreadStart = (method: string, parameters: unknown): unknown => {
    if (selectedModel === null || !isRecord(parameters)) return parameters;
    const threadParams =
      method === "prewarm-thread-start-for-host"
        ? parameters.params
        : parameters.method === "thread/start"
          ? parameters.params
          : null;
    if (!isRecord(threadParams) || threadParams.ephemeral === true) return parameters;
    return { ...parameters, params: { ...threadParams, model: selectedModel } };
  };
  const routedSend = (method: string, parameters: unknown, options?: unknown): unknown => {
    const routedParameters =
      method === "start-conversation" || method === "prewarm-conversation-for-host"
        ? routeCollaborationMode(method, parameters)
        : method === "prewarm-thread-start-for-host" || method === "send-cli-request-for-host"
          ? routeThreadStart(method, parameters)
          : parameters;
    return options === undefined
      ? originalSend.call(bridge, method, routedParameters)
      : originalSend.call(bridge, method, routedParameters, options);
  };
  bridge.sendRequest = routedSend;

  const policy = Object.freeze({
    state: "ready" as const,
    select(model: string | null): boolean {
      if (model !== null && (typeof model !== "string" || !model.startsWith("codexhost/"))) {
        throw new Error("Draft route Model must be a codexhost transport carrier");
      }
      if (selectedModel === model) return false;
      selectedModel = model;
      return true;
    },
    clear(): Promise<void> {
      if (clearInFlight === null) {
        clearInFlight = Promise.resolve(
          originalSend.call(bridge, "clear-prewarmed-threads-for-host", { hostId }),
        )
          .then(() => undefined)
          .finally(() => {
            clearInFlight = null;
          });
      }
      return clearInFlight;
    },
    dispose(): void {
      if (bridge.sendRequest === routedSend) bridge.sendRequest = originalSend;
      selectedModel = null;
    },
  });
  Object.defineProperty(target, "__codexhostDraftPrewarmPolicyV1", {
    configurable: true,
    value: policy,
  });
  return { state: "ready", reason: "owned-request-bridge" };
}

export async function installDraftPrewarmPolicyInRenderer(
  contents: RendererWebContents | null,
  findRequestManagerExpression: string,
  installRendererPolicyFunction: string,
): Promise<unknown> {
  if (contents === null || contents.isDestroyed() || contents.getType() !== "window") {
    throw new Error("Owned Renderer is unavailable for draft prewarm policy");
  }

  let attachedHere = false;
  try {
    if (!contents.debugger.isAttached()) {
      contents.debugger.attach("1.3");
      attachedHere = true;
    }
    await contents.debugger.sendCommand("Runtime.enable");
    const managerResult = (await contents.debugger.sendCommand("Runtime.evaluate", {
      expression: findRequestManagerExpression,
    })) as { result?: { objectId?: unknown } };
    const managerResultId = managerResult.result?.objectId;
    if (typeof managerResultId !== "string") {
      throw new Error("Renderer request manager inspection failed");
    }
    const managerProperties = (await contents.debugger.sendCommand("Runtime.getProperties", {
      objectId: managerResultId,
      ownProperties: true,
    })) as {
      result?: Array<{
        name?: unknown;
        value?: { objectId?: unknown; value?: unknown };
      }>;
    };
    const candidateCount = managerProperties.result?.find(
      (property) => property.name === "candidateCount",
    )?.value?.value;
    const hostId = managerProperties.result?.find((property) => property.name === "hostId")?.value
      ?.value;
    const manager = managerProperties.result?.find(
      (property) => property.name === "manager",
    )?.value;
    if (candidateCount !== 1 || hostId !== "local" || typeof manager?.objectId !== "string") {
      throw new Error("Renderer request manager is ambiguous");
    }

    const managerFunctions = (await contents.debugger.sendCommand("Runtime.getProperties", {
      objectId: manager.objectId,
    })) as {
      result?: Array<{ name?: unknown; value?: { objectId?: unknown } }>;
      internalProperties?: Array<{ name?: unknown; value?: { objectId?: unknown } }>;
    };
    let managerSendRequestId = managerFunctions.result?.find(
      (property) => property.name === "sendRequest",
    )?.value?.objectId;
    const managerPrototypeId = managerFunctions.internalProperties?.find(
      (property) => property.name === "[[Prototype]]",
    )?.value?.objectId;
    if (typeof managerSendRequestId !== "string" && typeof managerPrototypeId === "string") {
      const prototypeFunctions = (await contents.debugger.sendCommand("Runtime.getProperties", {
        objectId: managerPrototypeId,
        ownProperties: true,
      })) as { result?: Array<{ name?: unknown; value?: { objectId?: unknown } }> };
      managerSendRequestId = prototypeFunctions.result?.find(
        (property) => property.name === "sendRequest",
      )?.value?.objectId;
    }
    if (typeof managerSendRequestId !== "string") {
      throw new Error("Renderer request manager sendRequest is unavailable");
    }
    const functionProperties = (await contents.debugger.sendCommand("Runtime.getProperties", {
      objectId: managerSendRequestId,
    })) as {
      internalProperties?: Array<{ name?: unknown; value?: { objectId?: unknown } }>;
    };
    const scopesId = functionProperties.internalProperties?.find(
      (property) => property.name === "[[Scopes]]",
    )?.value?.objectId;
    const hostBridgeCandidates: Array<{ name: string; objectId: string }> = [];
    if (typeof scopesId === "string") {
      const scopes = (await contents.debugger.sendCommand("Runtime.getProperties", {
        objectId: scopesId,
        ownProperties: true,
      })) as { result?: Array<{ value?: { objectId?: unknown } }> };
      for (const scope of scopes.result ?? []) {
        if (typeof scope.value?.objectId !== "string") continue;
        const scopeProperties = (await contents.debugger.sendCommand("Runtime.getProperties", {
          objectId: scope.value.objectId,
          ownProperties: true,
        })) as {
          result?: Array<{
            name?: unknown;
            value?: { objectId?: unknown; type?: unknown };
          }>;
        };
        for (const property of scopeProperties.result ?? []) {
          if (property.value?.type !== "object" || typeof property.value.objectId !== "string") {
            continue;
          }
          const candidateSignature = (await contents.debugger.sendCommand(
            "Runtime.callFunctionOn",
            {
              objectId: property.value.objectId,
              functionDeclaration:
                "function(){const send=this.sendRequest;return typeof send==='function'&&Function.prototype.toString.call(send).includes('messageHandler')}",
              returnByValue: true,
            },
          )) as { result?: { value?: unknown } };
          if (candidateSignature.result?.value === true) {
            hostBridgeCandidates.push({
              name: String(property.name),
              objectId: property.value.objectId,
            });
          }
        }
      }
    }
    const hostBridge = hostBridgeCandidates[0];
    if (hostBridgeCandidates.length !== 1 || !hostBridge) {
      throw new Error("Renderer Host request bridge is ambiguous");
    }

    const installed = (await contents.debugger.sendCommand("Runtime.callFunctionOn", {
      objectId: hostBridge.objectId,
      functionDeclaration: installRendererPolicyFunction,
      arguments: [{ value: hostId }],
      awaitPromise: true,
      returnByValue: true,
    })) as { result?: { value?: unknown } };
    return installed.result?.value;
  } finally {
    if (attachedHere && contents.debugger.isAttached()) contents.debugger.detach();
  }
}
