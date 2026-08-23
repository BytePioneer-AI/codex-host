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
  dispatchEvent?: (event: Event) => boolean;
}

export interface RendererHostRequestBridge {
  sendRequest(method: string, parameters: unknown, options?: unknown): unknown;
  prewarmThreadStart(parameters: unknown, options?: unknown): unknown;
}

export interface RendererPrewarmedThreadManager {
  discardAllPrewarmedThreads(): void;
}

export function installDraftPrewarmPolicyBridge(
  bridge: RendererHostRequestBridge,
  hostId: string,
  target: DraftPrewarmPolicyTarget,
  prewarmedThreadManager: RendererPrewarmedThreadManager,
): { state: "ready"; reason: "owned-request-bridge" } {
  const existing = target.__codexhostDraftPrewarmPolicyV1 as
    | {
        owns?: (
          candidate: RendererHostRequestBridge,
          candidateHostId: string,
          candidatePrewarmedThreadManager: RendererPrewarmedThreadManager,
        ) => boolean;
        dispose?: () => void;
      }
    | undefined;
  if (
    existing?.owns?.length === 3 &&
    existing.owns(bridge, hostId, prewarmedThreadManager) === true
  ) {
    return { state: "ready", reason: "owned-request-bridge" };
  }
  existing?.dispose?.();

  const originalSend = bridge.sendRequest;
  const originalPrewarm = bridge.prewarmThreadStart;
  let selectedModel: string | null = null;
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  const routeThreadStart = (parameters: unknown): unknown => {
    if (selectedModel === null || !isRecord(parameters) || parameters.ephemeral === true) {
      return parameters;
    }
    return { ...parameters, model: selectedModel };
  };
  const routedSend = (method: string, parameters: unknown, options?: unknown): unknown => {
    const routedParameters = method === "thread/start" ? routeThreadStart(parameters) : parameters;
    return options === undefined
      ? originalSend.call(bridge, method, routedParameters)
      : originalSend.call(bridge, method, routedParameters, options);
  };
  const routedPrewarm = (parameters: unknown, options?: unknown): unknown => {
    const routedParameters = routeThreadStart(parameters);
    return options === undefined
      ? originalPrewarm.call(bridge, routedParameters)
      : originalPrewarm.call(bridge, routedParameters, options);
  };
  bridge.sendRequest = routedSend;
  bridge.prewarmThreadStart = routedPrewarm;

  const policy = Object.freeze({
    state: "ready" as const,
    hostId,
    owns(
      candidate: RendererHostRequestBridge,
      candidateHostId: string,
      candidatePrewarmedThreadManager: RendererPrewarmedThreadManager,
    ): boolean {
      return (
        candidate === bridge &&
        candidateHostId === hostId &&
        candidatePrewarmedThreadManager === prewarmedThreadManager
      );
    },
    select(model: string | null): boolean {
      if (model !== null && (typeof model !== "string" || !model.startsWith("codexhost/"))) {
        throw new Error("Draft route Model must be a codexhost transport carrier");
      }
      if (selectedModel === model) return false;
      selectedModel = model;
      return true;
    },
    clear(): Promise<void> {
      prewarmedThreadManager.discardAllPrewarmedThreads();
      return Promise.resolve();
    },
    dispose(): void {
      if (bridge.sendRequest === routedSend) bridge.sendRequest = originalSend;
      if (bridge.prewarmThreadStart === routedPrewarm) {
        bridge.prewarmThreadStart = originalPrewarm;
      }
      selectedModel = null;
    },
  });
  Object.defineProperty(target, "__codexhostDraftPrewarmPolicyV1", {
    configurable: true,
    value: policy,
  });
  if (typeof target.dispatchEvent === "function" && typeof CustomEvent === "function") {
    target.dispatchEvent(new CustomEvent("codexhost:draft-prewarm-policy-changed"));
  }
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
    const prewarmedThreadManager = managerProperties.result?.find(
      (property) => property.name === "prewarmedThreadManager",
    )?.value;
    if (
      candidateCount !== 1 ||
      typeof hostId !== "string" ||
      hostId.length === 0 ||
      typeof manager?.objectId !== "string"
    ) {
      throw new Error("Renderer request manager is ambiguous");
    }
    if (typeof prewarmedThreadManager?.objectId !== "string") {
      throw new Error("Renderer prewarmed Thread manager is unavailable");
    }

    const installed = (await contents.debugger.sendCommand("Runtime.callFunctionOn", {
      objectId: manager.objectId,
      functionDeclaration: installRendererPolicyFunction,
      arguments: [{ value: hostId }, { objectId: prewarmedThreadManager.objectId }],
      awaitPromise: true,
      returnByValue: true,
    })) as { result?: { value?: unknown } };
    return installed.result?.value;
  } finally {
    if (attachedHere && contents.debugger.isAttached()) contents.debugger.detach();
  }
}
