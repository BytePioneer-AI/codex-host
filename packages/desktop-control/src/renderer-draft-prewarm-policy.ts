import type { CdpClient } from "./cdp-client.js";
import { committedReactAncestors } from "./renderer-react-ownership.js";
import { retainRendererHostResponses } from "./renderer-host-response-ownership.js";
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
  const grouped = new Map<Manager, RendererRequestManagerCandidate<Manager, RequestClient>[]>();
  for (const candidate of candidates) {
    const group = grouped.get(candidate.manager) ?? [];
    group.push(candidate);
    grouped.set(candidate.manager, group);
  }

  const hosts = new Set(
    activeHostIds.filter((value): value is string => typeof value === "string" && value.length > 0),
  );
  if (hosts.size > 1) return null;

  const activeHostId = hosts.values().next().value as string | undefined;
  const unique: RendererRequestManagerCandidate<Manager, RequestClient>[] = [];
  for (const group of grouped.values()) {
    const fallback = group[0];
    if (fallback === undefined) continue;
    const candidateHostIds = new Set(
      group
        .map((candidate) => candidate.hostId)
        .filter((value): value is string => typeof value === "string" && value.length > 0),
    );
    if (candidateHostIds.size > 1) return null;
    unique.push(
      group.find((candidate) => candidate.hostId === activeHostId) ??
        group.find((candidate) => candidateHostIds.has(candidate.hostId as string)) ??
        fallback,
    );
  }
  const eligible = unique.filter(
    (candidate) => activeHostId === undefined || candidate.hostId === activeHostId,
  );
  return eligible.length === 1 ? (eligible[0] ?? null) : null;
}

export interface RendererHookRequestManagerCandidate {
  manager: object;
  hostId: string | null;
}

export function requestManagerFromHookState(
  value: unknown,
  activeHostId?: string,
): RendererHookRequestManagerCandidate | null {
  const matchesRequestManager = (candidate: unknown): candidate is object => {
    if (
      candidate == null ||
      typeof candidate !== "object" ||
      !("requestClient" in candidate) ||
      !("prewarmedThreadManager" in candidate) ||
      !("sendRequest" in candidate)
    ) {
      return false;
    }
    const requestClient = candidate.requestClient;
    const prewarmedThreadManager = candidate.prewarmedThreadManager;
    return (
      requestClient != null &&
      typeof requestClient === "object" &&
      "prewarmThreadStart" in requestClient &&
      typeof requestClient.prewarmThreadStart === "function" &&
      "sendRequest" in requestClient &&
      typeof requestClient.sendRequest === "function" &&
      "enqueueRequest" in requestClient &&
      typeof requestClient.enqueueRequest === "function" &&
      prewarmedThreadManager != null &&
      typeof prewarmedThreadManager === "object" &&
      "discardAllPrewarmedThreads" in prewarmedThreadManager &&
      typeof prewarmedThreadManager.discardAllPrewarmedThreads === "function" &&
      typeof candidate.sendRequest === "function"
    );
  };
  const candidateFromManager = (
    manager: object,
    preferredHostId?: unknown,
  ): RendererHookRequestManagerCandidate | null => {
    const normalizeHostId = (candidate: unknown): string | null =>
      typeof candidate === "string" && candidate.length > 0 ? candidate : null;
    const managerHostId = normalizeHostId(
      "getHostId" in manager && typeof manager.getHostId === "function"
        ? manager.getHostId()
        : undefined,
    );
    const requestClient = "requestClient" in manager ? manager.requestClient : undefined;
    const requestClientHostId = normalizeHostId(
      requestClient != null && typeof requestClient === "object" && "hostId" in requestClient
        ? requestClient.hostId
        : undefined,
    );
    const preferred = normalizeHostId(preferredHostId);
    const explicitHostIds = new Set(
      [preferred, managerHostId, requestClientHostId].filter(
        (candidate): candidate is string => candidate !== null,
      ),
    );
    if (explicitHostIds.size > 1) return null;
    return {
      manager,
      hostId: preferred ?? managerHostId ?? requestClientHostId,
    };
  };
  if (matchesRequestManager(value)) return candidateFromManager(value);
  if (
    value != null &&
    typeof value === "object" &&
    "manager" in value &&
    matchesRequestManager(value.manager)
  ) {
    // Newer Desktop builds keep the authoritative Host identity on this wrapper,
    // while the inner manager and request client may no longer repeat it.
    const wrapperHostId = "hostId" in value ? value.hostId : undefined;
    return candidateFromManager(value.manager, wrapperHostId);
  }
  if (typeof activeHostId !== "string" || activeHostId.length === 0) return null;
  if (
    value == null ||
    typeof value !== "object" ||
    !("addManager" in value) ||
    typeof value.addManager !== "function" ||
    !("getForHostId" in value) ||
    typeof value.getForHostId !== "function" ||
    !("waitForManagerForHostId" in value) ||
    typeof value.waitForManagerForHostId !== "function"
  ) {
    return null;
  }
  const manager = value.getForHostId.call(value, activeHostId);
  return matchesRequestManager(manager) ? candidateFromManager(manager) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const FIND_REQUEST_MANAGER_EXPRESSION = `(() => {
  const requestManagerFromHookState = ${requestManagerFromHookState.toString()};
  const committedReactAncestors = ${committedReactAncestors.toString()};
  const editors = [...document.querySelectorAll(
    '[data-codex-composer], [contenteditable="true"][role="textbox"]',
  )];
  if (editors.length === 0) {
    return { candidateCount: 0, editorCount: editors.length, hostId: null, sendRequest: null };
  }
  // Main and side chat can expose multiple editors backed by the same manager.
  // Resolve their combined Host ownership before consulting any Host registry.
  const composerAncestors = new Set();
  const activeHostIds = new Set();
  for (const editor of editors) {
    let element = editor;
    let fiber = null;
    while (element != null && fiber == null) {
      const key = Object.getOwnPropertyNames(element).find((name) =>
        name.startsWith('__reactFiber$'),
      );
      if (key != null) fiber = element[key];
      element = element.parentElement;
    }
    for (const current of committedReactAncestors(fiber)) {
      composerAncestors.add(current);
      const props = current.memoizedProps;
      if (props != null && typeof props === 'object') {
        for (const name of ['executionTargetHostId', 'permissionsHostId']) {
          const value = props[name];
          if (typeof value === 'string' && value.length > 0) activeHostIds.add(value);
        }
      }
    }
  }
  const activeHostId =
    activeHostIds.size === 1 ? activeHostIds.values().next().value : undefined;
  const managerCandidates = [];
  for (const fiber of composerAncestors) {
    let hook = fiber.memoizedState;
    for (let index = 0; hook != null && index < 120; index += 1, hook = hook.next) {
      const candidate = requestManagerFromHookState(hook.memoizedState, activeHostId);
      if (candidate != null) {
        // Preserve every observed Host identity until selection so duplicate
        // manager sightings cannot hide a conflicting wrapper identity.
        managerCandidates.push(candidate);
      }
    }
  }
  const candidates = managerCandidates.map((candidate) => {
    const manager = candidate.manager;
    const requestClient =
      typeof manager.requestClient?.sendRequest === 'function' &&
      typeof manager.requestClient?.prewarmThreadStart === 'function' &&
      typeof manager.requestClient?.enqueueRequest === 'function'
        ? manager.requestClient
        : manager;
    return {
      manager,
      requestClient,
      hostId: candidate.hostId,
      prewarmedThreadManager: manager?.prewarmedThreadManager ?? null,
    };
  });
  const selected = (${selectRendererRequestManager.toString()})(candidates, [...activeHostIds]);
  return {
    candidateCount: selected == null ? candidates.length : 1,
    editorCount: editors.length,
    hostId: selected?.hostId ?? null,
    manager: selected?.manager ?? null,
    requestClient: selected?.requestClient ?? null,
    prewarmedThreadManager: selected?.prewarmedThreadManager ?? null,
  };
})()`;

// Validate the pinned owner between Controller polls. An old manager can still
// send requests after retirement, but Desktop delivers replies to its replacement.
const IS_CURRENT_REQUEST_MANAGER = `function(manager, requestClient, hostId, prewarmedThreadManager) {
  const current = ${FIND_REQUEST_MANAGER_EXPRESSION};
  return current.editorCount === 0 || (
    current.manager === manager && current.requestClient === requestClient &&
    current.hostId === hostId && current.prewarmedThreadManager === prewarmedThreadManager
  );
}`;

const INSTALL_RENDERER_POLICY_FUNCTION = `function(requestClient, hostId, prewarmedThreadManager) {
  return (${installDraftPrewarmPolicyBridge.toString()})(
    this,
    requestClient,
    hostId,
    window,
    prewarmedThreadManager,
    () => (${IS_CURRENT_REQUEST_MANAGER})(this, requestClient, hostId, prewarmedThreadManager),
    (${retainRendererHostResponses.toString()}),
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
      () => (${IS_CURRENT_REQUEST_MANAGER})(
        selected.manager, selected.requestClient, selected.hostId, selected.prewarmedThreadManager,
      ),
      (${retainRendererHostResponses.toString()}),
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
