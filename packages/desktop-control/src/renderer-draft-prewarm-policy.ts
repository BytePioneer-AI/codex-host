import type { CdpClient } from "./cdp-client.js";

interface InspectorEvaluator {
  evaluate<T>(expression: string): Promise<T>;
}

export interface RendererDraftPrewarmPolicyStatus {
  state: "ready";
  reason: "owned-request-bridge";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const FIND_REQUEST_MANAGER_EXPRESSION = `(() => {
  const visibleEditors = [...document.querySelectorAll(
    '[data-codex-composer], [contenteditable="true"][role="textbox"]',
  )].filter((editor) => {
    const bounds = editor.getBoundingClientRect();
    return bounds.width > 0 && bounds.height > 0;
  });
  if (visibleEditors.length !== 1) {
    return { candidateCount: 0, hostId: null, sendRequest: null };
  }
  let element = visibleEditors[0];
  let fiber = null;
  while (element != null && fiber == null) {
    const key = Object.getOwnPropertyNames(element).find((name) =>
      name.startsWith('__reactFiber$'),
    );
    if (key != null) fiber = element[key];
    element = element.parentElement;
  }
  const managers = new Set();
  for (let depth = 0; fiber != null && depth < 200; depth += 1, fiber = fiber.return) {
    let hook = fiber.memoizedState;
    for (let index = 0; hook != null && index < 120; index += 1, hook = hook.next) {
      const value = hook.memoizedState;
      if (
        value != null &&
        typeof value === 'object' &&
        value.requestClient != null &&
        typeof value.requestClient.prewarmThreadStart === 'function' &&
        typeof value.sendRequest === 'function' &&
        Function.prototype.toString.call(value.sendRequest).includes(
          'send-cli-request-for-host',
        )
      ) {
        managers.add(value);
      }
    }
  }
  const manager = managers.size === 1 ? managers.values().next().value : null;
  return {
    candidateCount: managers.size,
    hostId: manager?.getHostId?.() ?? null,
    sendRequest: manager?.sendRequest ?? null,
  };
})()`;

const INSTALL_RENDERER_POLICY_FUNCTION = `function(hostId) {
  const send = this;
  let clearInFlight = null;
  const policy = Object.freeze({
    state: 'ready',
    clear() {
      if (clearInFlight == null) {
        clearInFlight = Promise.resolve(
          send('clear-prewarmed-threads-for-host', { hostId }),
        ).then(() => undefined).finally(() => {
          clearInFlight = null;
        });
      }
      return clearInFlight;
    },
  });
  Object.defineProperty(window, '__codexhostDraftPrewarmPolicyV1', {
    configurable: true,
    value: policy,
  });
  return { state: 'ready', reason: 'owned-request-bridge' };
}`;

const INSTALL_POLICY_FUNCTION = `async function () {
  const mainModule = process.mainModule;
  const electron = mainModule != null && typeof mainModule.require === 'function'
    ? mainModule.require('electron')
    : process.getBuiltinModule('module').createRequire(process.execPath)('electron');
  const contents = electron.webContents.fromId(RENDERER_WEB_CONTENTS_ID);
  if (contents == null || contents.isDestroyed() || contents.getType() !== 'window') {
    throw new Error('Owned Renderer is unavailable for draft prewarm policy');
  }

  let attachedHere = false;
  try {
    if (!contents.debugger.isAttached()) {
      contents.debugger.attach('1.3');
      attachedHere = true;
    }
    await contents.debugger.sendCommand('Runtime.enable');
    const managerResult = await contents.debugger.sendCommand('Runtime.evaluate', {
      expression: FIND_REQUEST_MANAGER_EXPRESSION,
    });
    const managerResultId = managerResult.result?.objectId;
    if (typeof managerResultId !== 'string') {
      throw new Error('Renderer request manager inspection failed');
    }
    const managerProperties = await contents.debugger.sendCommand('Runtime.getProperties', {
      objectId: managerResultId,
      ownProperties: true,
    });
    const candidateCount = managerProperties.result?.find(
      (property) => property.name === 'candidateCount',
    )?.value?.value;
    const hostId = managerProperties.result?.find(
      (property) => property.name === 'hostId',
    )?.value?.value;
    const sendRequest = managerProperties.result?.find(
      (property) => property.name === 'sendRequest',
    )?.value;
    if (
      candidateCount !== 1 ||
      hostId !== 'local' ||
      typeof sendRequest?.objectId !== 'string'
    ) {
      throw new Error('Renderer request manager is ambiguous');
    }

    const functionProperties = await contents.debugger.sendCommand('Runtime.getProperties', {
      objectId: sendRequest.objectId,
    });
    const scopesId = functionProperties.internalProperties?.find(
      (property) => property.name === '[[Scopes]]',
    )?.value?.objectId;
    if (typeof scopesId !== 'string') {
      throw new Error('Renderer request bridge scopes are unavailable');
    }
    const scopes = await contents.debugger.sendCommand('Runtime.getProperties', {
      objectId: scopesId,
      ownProperties: true,
    });
    const bridgeCandidates = [];
    for (const scope of scopes.result ?? []) {
      const scopeId = scope.value?.objectId;
      if (typeof scopeId !== 'string') continue;
      const scopeProperties = await contents.debugger.sendCommand('Runtime.getProperties', {
        objectId: scopeId,
        ownProperties: true,
      });
      const bridge = scopeProperties.result?.find((property) => property.name === 'Rf')?.value;
      if (typeof bridge?.objectId === 'string') bridgeCandidates.push(bridge);
    }
    if (bridgeCandidates.length !== 1) {
      throw new Error('Renderer request bridge is ambiguous');
    }
    const bridge = bridgeCandidates[0];
    const signature = await contents.debugger.sendCommand('Runtime.callFunctionOn', {
      objectId: bridge.objectId,
      functionDeclaration:
        'function(){return {arity:this.length,source:Function.prototype.toString.call(this)}}',
      returnByValue: true,
    });
    const signatureValue = signature.result?.value;
    if (
      signatureValue?.arity !== 2 ||
      typeof signatureValue.source !== 'string' ||
      !signatureValue.source.includes('.sendRequest')
    ) {
      throw new Error('Renderer request bridge signature mismatch');
    }

    const installed = await contents.debugger.sendCommand('Runtime.callFunctionOn', {
      objectId: bridge.objectId,
      functionDeclaration: INSTALL_RENDERER_POLICY_FUNCTION,
      arguments: [{ value: hostId }],
      awaitPromise: true,
      returnByValue: true,
    });
    return installed.result?.value;
  } finally {
    if (attachedHere && contents.debugger.isAttached()) contents.debugger.detach();
  }
}`;

export async function installRendererDraftPrewarmPolicy(
  inspector: Pick<CdpClient, "evaluate"> | InspectorEvaluator,
  rendererWebContentsId: number,
): Promise<RendererDraftPrewarmPolicyStatus> {
  if (!Number.isInteger(rendererWebContentsId) || rendererWebContentsId <= 0) {
    throw new Error("Renderer webContents ID must be a positive integer");
  }
  const installer = INSTALL_POLICY_FUNCTION.replace(
    "RENDERER_WEB_CONTENTS_ID",
    String(rendererWebContentsId),
  )
    .replace("FIND_REQUEST_MANAGER_EXPRESSION", () =>
      JSON.stringify(FIND_REQUEST_MANAGER_EXPRESSION),
    )
    .replace("INSTALL_RENDERER_POLICY_FUNCTION", () =>
      JSON.stringify(INSTALL_RENDERER_POLICY_FUNCTION),
    );
  const value = await inspector.evaluate<unknown>(`(${installer})()`);
  if (!isRecord(value) || value.state !== "ready" || value.reason !== "owned-request-bridge") {
    throw new Error("Renderer draft prewarm policy returned an invalid status");
  }
  return value as unknown as RendererDraftPrewarmPolicyStatus;
}
