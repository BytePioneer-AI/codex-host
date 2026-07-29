import type { CdpClient } from "./cdp-client.js";

interface CdpCommander {
  command(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

interface RemoteObject {
  objectId?: string;
  value?: unknown;
}

interface RuntimeProperty {
  name?: string;
  value?: RemoteObject;
}

export interface MainProcessTitlePolicyStatus {
  state: "ready";
  reason: "ready";
  contextClass: string;
  serviceClass: string;
  requiresRendererReload: true;
}

export interface MainProcessTitlePolicyCounters {
  codexTitleCalls: number;
  piTitleSkips: number;
  externalTitleSkips: number;
  ambiguousTitleSkips: number;
}

export interface RendererTitlePolicyReadiness {
  state: "ready";
  reason: "owned-metadata-service";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resultRecord(value: unknown, command: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${command} returned an invalid result`);
  if (isRecord(value.exceptionDetails)) {
    const exception = value.exceptionDetails.exception;
    const description = isRecord(exception) ? exception.description : null;
    const text = value.exceptionDetails.text;
    throw new Error(
      typeof description === "string"
        ? description
        : typeof text === "string"
          ? text
          : `${command} failed`,
    );
  }
  return value;
}

function remoteObjectId(value: unknown, label: string): string {
  if (!isRecord(value) || typeof value.objectId !== "string") {
    throw new Error(`${label} is unavailable`);
  }
  return value.objectId;
}

function properties(value: unknown, command: string): RuntimeProperty[] {
  const result = resultRecord(value, command).result;
  if (!Array.isArray(result)) throw new Error(`${command} returned invalid properties`);
  return result.filter(isRecord) as RuntimeProperty[];
}

const ELECTRON_MODULE_EXPRESSION = `(() => {
  const mainModule = process.mainModule;
  if (mainModule != null && typeof mainModule.require === 'function') {
    return mainModule.require('electron');
  }
  const { createRequire } = process.getBuiltinModule('module');
  return createRequire(process.execPath)('electron');
})()`;

const CONNECT_APP_HOST_CHANNEL = "codex_desktop:connect-app-host";
const POLICY_STATE_SYMBOL = "codexhost.main-process-title-policy.v1";
const SERVICE_OWNER_SYMBOL = "codexhost.main-process-title-policy.owner.v1";
const RENDERER_READY_EXPRESSION =
  "(() => { Object.defineProperty(window, '__codexhostMainProcessTitlePolicyV1', { configurable: true, value: { state: 'ready' } }); return 'ready'; })()";

const INSTALL_POLICY_FUNCTION = `async function () {
  const mainModule = process.mainModule;
  const electron = mainModule != null && typeof mainModule.require === 'function'
    ? mainModule.require('electron')
    : process.getBuiltinModule('module').createRequire(process.execPath)('electron');
  let selected = null;
  let largestElementCount = 0;
  for (const contents of electron.webContents.getAllWebContents()) {
    if (contents.isDestroyed() || contents.getType() !== 'window') continue;
    let elementCount = 0;
    try {
      elementCount = await contents.executeJavaScript(
        "document.querySelectorAll('*').length",
        true,
      );
    } catch {}
    if (Number.isInteger(elementCount) && elementCount > largestElementCount) {
      selected = contents;
      largestElementCount = elementCount;
    }
  }
  if (selected == null || largestElementCount < 50) {
    throw new Error('Populated Renderer unavailable for title policy');
  }

  const context = this(selected);
  if (context == null || typeof context.createAppHost !== 'function') {
    throw new Error('WindowContext unavailable for title policy');
  }
  const stateSymbol = Symbol.for(${JSON.stringify(POLICY_STATE_SYMBOL)});
  const ownerSymbol = Symbol.for(${JSON.stringify(SERVICE_OWNER_SYMBOL)});
  globalThis[stateSymbol]?.dispose?.();

  const originalCreateAppHost = context.createAppHost;
  const sampleHost = originalCreateAppHost.call(context, selected);
  const sampleService = sampleHost?.services?.threadMetadataGeneration;
  const servicePrototype = sampleService == null ? null : Object.getPrototypeOf(sampleService);
  const originalGenerateTitle = servicePrototype?.generateTitle;
  if (
    servicePrototype == null ||
    sampleService?.constructor?.name !== 'Dhe' ||
    typeof originalGenerateTitle !== 'function' ||
    !Function.prototype.toString.call(originalGenerateTitle).includes('Failed to generate thread title')
  ) {
    throw new Error('ThreadMetadataGenerationService signature mismatch');
  }

  const counters = {
    codexTitleCalls: 0,
    piTitleSkips: 0,
    externalTitleSkips: 0,
    ambiguousTitleSkips: 0,
  };
  const ownedWebContentsIds = new Set();
  const wrappedCreateAppHost = function (contents) {
    const host = originalCreateAppHost.call(this, contents);
    const service = host?.services?.threadMetadataGeneration;
    if (service != null) {
      Object.defineProperty(service, ownerSymbol, { value: contents });
      ownedWebContentsIds.add(contents.id);
    }
    return host;
  };
  const wrappedGenerateTitle = async function (params) {
    const owner = this[ownerSymbol];
    if (owner == null || owner.isDestroyed()) {
      counters.ambiguousTitleSkips += 1;
      return null;
    }
    let selection = null;
    try {
      selection = await owner.executeJavaScript(
        "window.__codexhostRendererBindingProbeV1?.lockedSelection() ?? null",
        true,
      );
    } catch {}
    if (selection?.phase !== 'locked') {
      counters.ambiguousTitleSkips += 1;
      return null;
    }
    if (selection.agent === 'pi') {
      counters.piTitleSkips += 1;
      return null;
    }
    if (selection.agent !== 'codex') {
      counters.externalTitleSkips += 1;
      return null;
    }
    counters.codexTitleCalls += 1;
    return originalGenerateTitle.call(this, params);
  };

  context.createAppHost = wrappedCreateAppHost;
  servicePrototype.generateTitle = wrappedGenerateTitle;
  const state = {
    counters,
    ownedWebContentsIds,
    dispose() {
      if (context.createAppHost === wrappedCreateAppHost) {
        context.createAppHost = originalCreateAppHost;
      }
      if (servicePrototype.generateTitle === wrappedGenerateTitle) {
        servicePrototype.generateTitle = originalGenerateTitle;
      }
      if (globalThis[stateSymbol] === state) delete globalThis[stateSymbol];
    },
  };
  globalThis[stateSymbol] = state;
  return {
    state: 'ready',
    reason: 'ready',
    contextClass: context.constructor.name,
    serviceClass: sampleService.constructor.name,
    requiresRendererReload: true,
  };
}`;

export async function installMainProcessTitlePolicy(
  inspector: Pick<CdpClient, "command"> | CdpCommander,
): Promise<MainProcessTitlePolicyStatus> {
  const listenerResponse = resultRecord(
    await inspector.command("Runtime.evaluate", {
      expression: `(${ELECTRON_MODULE_EXPRESSION}).ipcMain.listeners(${JSON.stringify(
        CONNECT_APP_HOST_CHANNEL,
      )})[0]`,
    }),
    "Runtime.evaluate",
  );
  const listener = listenerResponse.result;
  const listenerId = remoteObjectId(listener, "connect-app-host listener");

  const listenerProperties = resultRecord(
    await inspector.command("Runtime.getProperties", { objectId: listenerId }),
    "Runtime.getProperties",
  );
  const internalProperties = listenerProperties.internalProperties;
  if (!Array.isArray(internalProperties)) {
    throw new Error("connect-app-host listener scopes are unavailable");
  }
  const scopes = internalProperties.find(
    (property) => isRecord(property) && property.name === "[[Scopes]]",
  );
  const scopesId = remoteObjectId(
    isRecord(scopes) ? scopes.value : null,
    "connect-app-host listener scopes",
  );

  const scopeProperties = properties(
    await inspector.command("Runtime.getProperties", {
      objectId: scopesId,
      ownProperties: true,
    }),
    "Runtime.getProperties",
  );
  const localScope = scopeProperties.find((property) => property.name === "0");
  const localScopeId = remoteObjectId(localScope?.value, "connect-app-host local scope");

  const localProperties = properties(
    await inspector.command("Runtime.getProperties", {
      objectId: localScopeId,
      ownProperties: true,
    }),
    "Runtime.getProperties",
  );
  const getContext = localProperties.find(
    (property) => property.name === "f" && typeof property.value?.objectId === "string",
  );
  const getContextId = remoteObjectId(getContext?.value, "getContextForWebContents");

  const installResponse = resultRecord(
    await inspector.command("Runtime.callFunctionOn", {
      objectId: getContextId,
      functionDeclaration: INSTALL_POLICY_FUNCTION,
      awaitPromise: true,
      returnByValue: true,
    }),
    "Runtime.callFunctionOn",
  );
  const remoteResult = installResponse.result;
  const value = isRecord(remoteResult) ? remoteResult.value : null;
  if (
    !isRecord(value) ||
    value.state !== "ready" ||
    value.reason !== "ready" ||
    typeof value.contextClass !== "string" ||
    typeof value.serviceClass !== "string" ||
    value.requiresRendererReload !== true
  ) {
    throw new Error("Main-process title policy returned an invalid status");
  }
  return value as unknown as MainProcessTitlePolicyStatus;
}

export async function markRendererTitlePolicyReady(
  inspector: Pick<CdpClient, "evaluate">,
): Promise<RendererTitlePolicyReadiness> {
  const value = await inspector.evaluate<unknown>(`(async () => {
    const state = globalThis[Symbol.for(${JSON.stringify(POLICY_STATE_SYMBOL)})];
    if (state == null) throw new Error('Main-process title policy is unavailable');
    const mainModule = process.mainModule;
    const electron = mainModule != null && typeof mainModule.require === 'function'
      ? mainModule.require('electron')
      : process.getBuiltinModule('module').createRequire(process.execPath)('electron');
    let selected = null;
    let largestElementCount = 0;
    for (const contents of electron.webContents.getAllWebContents()) {
      if (contents.isDestroyed() || contents.getType() !== 'window') continue;
      let elementCount = 0;
      try {
        const evaluation = contents.executeJavaScript(
          "document.querySelectorAll('*').length",
          true,
        );
        const timeout = new Promise((_, reject) => {
          setTimeout(() => reject(new Error('Renderer readiness inspection timed out')), 2_000);
        });
        elementCount = await Promise.race([evaluation, timeout]);
      } catch {}
      if (Number.isInteger(elementCount) && elementCount > largestElementCount) {
        selected = contents;
        largestElementCount = elementCount;
      }
    }
    if (selected == null || largestElementCount < 50) {
      throw new Error('Populated Renderer unavailable for title policy readiness');
    }
    if (!state.ownedWebContentsIds.has(selected.id)) {
      throw new Error('Renderer metadata service ownership is unavailable');
    }
    const marker = selected.executeJavaScript(
      ${JSON.stringify(RENDERER_READY_EXPRESSION)},
      true,
    );
    const markerTimeout = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Renderer readiness marker timed out')), 2_000);
    });
    await Promise.race([marker, markerTimeout]);
    return { state: 'ready', reason: 'owned-metadata-service' };
  })()`);
  if (!isRecord(value) || value.state !== "ready" || value.reason !== "owned-metadata-service") {
    throw new Error("Renderer title policy returned an invalid readiness status");
  }
  return value as unknown as RendererTitlePolicyReadiness;
}

export async function readMainProcessTitlePolicyCounters(
  inspector: Pick<CdpClient, "evaluate">,
): Promise<MainProcessTitlePolicyCounters | null> {
  const value = await inspector.evaluate<unknown>(`(() => {
    const state = globalThis[Symbol.for(${JSON.stringify(POLICY_STATE_SYMBOL)})];
    return state == null ? null : { ...state.counters };
  })()`);
  if (value === null) return null;
  if (
    !isRecord(value) ||
    !Number.isInteger(value.codexTitleCalls) ||
    !Number.isInteger(value.piTitleSkips) ||
    !Number.isInteger(value.externalTitleSkips) ||
    !Number.isInteger(value.ambiguousTitleSkips)
  ) {
    throw new Error("Main-process title policy returned invalid counters");
  }
  return value as unknown as MainProcessTitlePolicyCounters;
}
