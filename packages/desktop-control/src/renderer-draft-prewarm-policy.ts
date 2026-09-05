import type { CdpClient } from "./cdp-client.js";
import { createRendererTurnAdjustmentBridge } from "./renderer-turn-adjustment.js";
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

export interface RendererRequestManagerCandidate<Manager = object, RequestClient = object> {
  manager: Manager;
  requestClient: RequestClient;
  hostId: unknown;
  prewarmedThreadManager: unknown;
}

export function selectRendererRequestManager<Manager, RequestClient>(
  candidates: readonly RendererRequestManagerCandidate<Manager, RequestClient>[],
  activeHostIds: readonly unknown[],
): RendererRequestManagerCandidate<Manager, RequestClient> | null {
  const unique = new Map<Manager, RendererRequestManagerCandidate<Manager, RequestClient>>();
  for (const candidate of candidates) unique.set(candidate.manager, candidate);

  const hosts = new Set(
    activeHostIds.filter((value): value is string => typeof value === "string" && value.length > 0),
  );
  if (hosts.size > 1) return null;

  const activeHostId = hosts.values().next().value as string | undefined;
  const eligible = [...unique.values()].filter(
    (candidate) => activeHostId === undefined || candidate.hostId === activeHostId,
  );
  return eligible.length === 1 ? (eligible[0] ?? null) : null;
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
  const activeHostIds = new Set();
  for (let depth = 0; fiber != null && depth < 200; depth += 1, fiber = fiber.return) {
    const props = fiber.memoizedProps;
    if (props != null && typeof props === 'object') {
      for (const name of ['executionTargetHostId', 'permissionsHostId']) {
        const value = props[name];
        if (typeof value === 'string' && value.length > 0) activeHostIds.add(value);
      }
    }
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
        typeof value.prewarmedThreadManager?.discardAllPrewarmedThreads === 'function' &&
        typeof value.sendRequest === 'function'
      ) {
        managers.add(value);
      }
    }
  }
  const candidates = [...managers].map((manager) => {
    const requestClient =
      typeof manager.requestClient?.sendRequest === 'function' &&
      typeof manager.requestClient?.prewarmThreadStart === 'function' &&
      typeof manager.requestClient?.enqueueRequest === 'function'
        ? manager.requestClient
        : manager;
    return {
      manager,
      requestClient,
      hostId: manager?.getHostId?.() ?? requestClient?.hostId ?? null,
      prewarmedThreadManager: manager?.prewarmedThreadManager ?? null,
    };
  });
  const selected = (${selectRendererRequestManager.toString()})(candidates, [...activeHostIds]);
  return {
    candidateCount: selected == null ? candidates.length : 1,
    hostId: selected?.hostId ?? null,
    manager: selected?.manager ?? null,
    requestClient: selected?.requestClient ?? null,
    prewarmedThreadManager: selected?.prewarmedThreadManager ?? null,
  };
})()`;

const INSTALL_RENDERER_POLICY_FUNCTION = `function(requestClient, hostId, prewarmedThreadManager) {
  return (${installDraftPrewarmPolicyBridge.toString()})(
    this,
    requestClient,
    hostId,
    window,
    prewarmedThreadManager,
    (${createRendererTurnAdjustmentBridge.toString()}),
  );
}`;
const REQUEST_MANAGER_WAIT_TIMEOUT_MS = 60_000;
const REQUEST_MANAGER_POLL_INTERVAL_MS = 25;

function directRendererInstaller(): string {
  return `(async () => {
    const selected = ${FIND_REQUEST_MANAGER_EXPRESSION};
    if (
      selected.candidateCount !== 1 ||
      typeof selected.hostId !== 'string' ||
      selected.hostId.length === 0 ||
      selected.manager == null ||
      selected.requestClient == null
    ) {
      throw new Error('Renderer request manager is ambiguous');
    }
    if (selected.prewarmedThreadManager == null) {
      throw new Error('Renderer prewarmed Thread manager is unavailable');
    }
    return (${installDraftPrewarmPolicyBridge.toString()})(
      selected.manager,
      selected.requestClient,
      selected.hostId,
      window,
      selected.prewarmedThreadManager,
      (${createRendererTurnAdjustmentBridge.toString()}),
    );
  })()`;
}

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

async function waitForDraftPrewarmPolicy(
  evaluate: (expression: string) => Promise<unknown>,
  expression: string,
): Promise<RendererDraftPrewarmPolicyStatus> {
  const deadline = Date.now() + REQUEST_MANAGER_WAIT_TIMEOUT_MS;
  while (true) {
    try {
      const value = await evaluate(expression);
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

export function installRendererDraftPrewarmPolicyDirect(
  renderer: Pick<CdpClient, "evaluate"> | InspectorEvaluator,
): Promise<RendererDraftPrewarmPolicyStatus> {
  return waitForDraftPrewarmPolicy(
    (expression) => renderer.evaluate<unknown>(expression),
    directRendererInstaller(),
  );
}

export async function installRendererDraftPrewarmPolicy(
  inspector: Pick<CdpClient, "evaluate"> | InspectorEvaluator,
  rendererWebContentsId: number,
): Promise<RendererDraftPrewarmPolicyStatus> {
  if (!Number.isInteger(rendererWebContentsId) || rendererWebContentsId <= 0) {
    throw new Error("Renderer webContents ID must be a positive integer");
  }
  const installer = mainProcessInstaller(rendererWebContentsId);
  return waitForDraftPrewarmPolicy(
    (expression) => inspector.evaluate<unknown>(expression),
    `(${installer})()`,
  );
}
