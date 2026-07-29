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
  return (${installDraftPrewarmPolicyBridge.toString()})(this, hostId, window);
}`;

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
  const value = await inspector.evaluate<unknown>(`(${installer})()`);
  if (!isRecord(value) || value.state !== "ready" || value.reason !== "owned-request-bridge") {
    throw new Error("Renderer draft prewarm policy returned an invalid status");
  }
  return value as unknown as RendererDraftPrewarmPolicyStatus;
}
