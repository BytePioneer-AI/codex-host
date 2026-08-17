import type { CdpClient } from "./cdp-client.js";
import {
  installDraftPrewarmPolicyBridge,
  installDraftPrewarmPolicyInRenderer,
} from "./renderer-draft-prewarm-runtime.js";

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
  const editors = [...document.querySelectorAll(
    '[data-codex-composer], [contenteditable="true"][role="textbox"]',
  )];
  if (editors.length !== 1) {
    return { candidateCount: 0, hostId: null, sendRequest: null };
  }
  let element = editors[0];
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
        typeof value.requestClient.sendRequest === 'function' &&
        typeof value.requestClient.enqueueRequest === 'function' &&
        typeof value.sendRequest === 'function'
      ) {
        managers.add(value);
      }
    }
  }
  const manager = managers.size === 1 ? managers.values().next().value : null;
  const requestClient =
    manager != null &&
    typeof manager.requestClient?.sendRequest === 'function' &&
    typeof manager.requestClient?.prewarmThreadStart === 'function' &&
    typeof manager.requestClient?.enqueueRequest === 'function'
      ? manager.requestClient
      : manager;
  return {
    candidateCount: managers.size,
    hostId: manager?.getHostId?.() ?? requestClient?.hostId ?? null,
    manager: requestClient,
    prewarmedThreadManager: manager?.prewarmedThreadManager ?? null,
  };
})()`;

const INSTALL_RENDERER_POLICY_FUNCTION = `function(hostId, prewarmedThreadManager) {
  return (${installDraftPrewarmPolicyBridge.toString()})(this, hostId, window, prewarmedThreadManager);
}`;
const REQUEST_MANAGER_WAIT_TIMEOUT_MS = 60_000;
const REQUEST_MANAGER_POLL_INTERVAL_MS = 25;

function mainProcessInstaller(rendererWebContentsId: number): string {
  return `async function () {
    const mainModule = process.mainModule;
    const electron = mainModule != null && typeof mainModule.require === 'function'
      ? mainModule.require('electron')
      : process.getBuiltinModule('module').createRequire(process.execPath)('electron');
    const contents = electron.webContents.fromId(${rendererWebContentsId});
    return (${installDraftPrewarmPolicyInRenderer.toString()})(
      contents,
      ${JSON.stringify(FIND_REQUEST_MANAGER_EXPRESSION)},
      ${JSON.stringify(INSTALL_RENDERER_POLICY_FUNCTION)}
    );
  }`;
}

export async function installRendererDraftPrewarmPolicy(
  inspector: Pick<CdpClient, "evaluate"> | InspectorEvaluator,
  rendererWebContentsId: number,
): Promise<RendererDraftPrewarmPolicyStatus> {
  if (!Number.isInteger(rendererWebContentsId) || rendererWebContentsId <= 0) {
    throw new Error("Renderer webContents ID must be a positive integer");
  }
  const installer = mainProcessInstaller(rendererWebContentsId);
  const deadline = Date.now() + REQUEST_MANAGER_WAIT_TIMEOUT_MS;
  while (true) {
    try {
      const value = await inspector.evaluate<unknown>(`(${installer})()`);
      if (!isRecord(value) || value.state !== "ready" || value.reason !== "owned-request-bridge") {
        throw new Error("Renderer draft prewarm policy returned an invalid status");
      }
      return value as unknown as RendererDraftPrewarmPolicyStatus;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const remaining = deadline - Date.now();
      if (!message.includes("Renderer request manager is ambiguous") || remaining <= 0) throw error;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, Math.min(REQUEST_MANAGER_POLL_INTERVAL_MS, remaining));
      });
    }
  }
}
