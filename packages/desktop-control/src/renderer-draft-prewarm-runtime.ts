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

export function installDraftPrewarmPolicyBridge(
  send: (method: string, parameters: { hostId: string }) => unknown,
  hostId: string,
  target: DraftPrewarmPolicyTarget,
): { state: "ready"; reason: "owned-request-bridge" } {
  let clearInFlight: Promise<void> | null = null;
  const policy = Object.freeze({
    state: "ready" as const,
    clear(): Promise<void> {
      if (clearInFlight === null) {
        clearInFlight = Promise.resolve(send("clear-prewarmed-threads-for-host", { hostId }))
          .then(() => undefined)
          .finally(() => {
            clearInFlight = null;
          });
      }
      return clearInFlight;
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
    const sendRequest = managerProperties.result?.find(
      (property) => property.name === "sendRequest",
    )?.value;
    if (candidateCount !== 1 || hostId !== "local" || typeof sendRequest?.objectId !== "string") {
      throw new Error("Renderer request manager is ambiguous");
    }

    const functionProperties = (await contents.debugger.sendCommand("Runtime.getProperties", {
      objectId: sendRequest.objectId,
    })) as {
      internalProperties?: Array<{
        name?: unknown;
        value?: { objectId?: unknown };
      }>;
    };
    const scopesId = functionProperties.internalProperties?.find(
      (property) => property.name === "[[Scopes]]",
    )?.value?.objectId;
    if (typeof scopesId !== "string") {
      throw new Error("Renderer request bridge scopes are unavailable");
    }
    const scopes = (await contents.debugger.sendCommand("Runtime.getProperties", {
      objectId: scopesId,
      ownProperties: true,
    })) as {
      result?: Array<{ value?: { objectId?: unknown } }>;
    };
    const bridgeCandidates: Array<{ objectId: string }> = [];
    for (const scope of scopes.result ?? []) {
      const scopeId = scope.value?.objectId;
      if (typeof scopeId !== "string") continue;
      const scopeProperties = (await contents.debugger.sendCommand("Runtime.getProperties", {
        objectId: scopeId,
        ownProperties: true,
      })) as {
        result?: Array<{
          name?: unknown;
          value?: { objectId?: unknown; type?: unknown };
        }>;
      };
      const bridge = scopeProperties.result?.find(
        (property) =>
          (property.name === "Rf" || property.name === "rp") && property.value?.type === "function",
      )?.value;
      if (typeof bridge?.objectId === "string") {
        bridgeCandidates.push({ objectId: bridge.objectId });
      }
    }
    const bridge = bridgeCandidates[0];
    if (bridgeCandidates.length !== 1 || !bridge) {
      throw new Error("Renderer request bridge is ambiguous");
    }
    const signature = (await contents.debugger.sendCommand("Runtime.callFunctionOn", {
      objectId: bridge.objectId,
      functionDeclaration:
        "function(){return {arity:this.length,source:Function.prototype.toString.call(this)}}",
      returnByValue: true,
    })) as {
      result?: { value?: { arity?: unknown; source?: unknown } };
    };
    const signatureValue = signature.result?.value;
    if (
      signatureValue?.arity !== 2 ||
      typeof signatureValue.source !== "string" ||
      !signatureValue.source.includes(".sendRequest")
    ) {
      throw new Error("Renderer request bridge signature mismatch");
    }

    const installed = (await contents.debugger.sendCommand("Runtime.callFunctionOn", {
      objectId: bridge.objectId,
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
