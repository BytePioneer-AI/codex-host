import { CdpClient, listCdpTargets, type CdpFetch, type CdpTarget } from "./cdp-client.js";
import {
  installMainProcessTitlePolicy,
  markRendererTitlePolicyReady,
  readMainProcessTitlePolicyCounters,
  type MainProcessTitlePolicyCounters,
  type MainProcessTitlePolicyStatus,
  type RendererTitlePolicyReadiness,
} from "./main-process-title-policy.js";
import {
  installRendererDraftPrewarmPolicy,
  type RendererDraftPrewarmPolicyStatus,
} from "./renderer-draft-prewarm-policy.js";

export interface ElectronRendererSummary {
  id: number;
  type: string;
  surface: "primary" | "overlay";
  url: string;
  runtime: {
    available: boolean;
    elementCount: number | null;
    editorCandidates: number | null;
    sendButtonCandidates: number | null;
  };
}

export interface ProductionRendererStatus {
  version: 2;
  enabledAgents: string[];
  adapter: {
    state: "ready";
    reason: string;
  };
}

export interface RendererControlSnapshot {
  renderer: ElectronRendererSummary;
  inventory: ElectronRendererSummary[];
  titlePolicy: MainProcessTitlePolicyStatus;
  titlePolicyReadiness: RendererTitlePolicyReadiness;
  draftPrewarmPolicy: RendererDraftPrewarmPolicyStatus;
  binding: ProductionRendererStatus;
}

interface RendererInspector {
  command(method: string, params?: Record<string, unknown>): Promise<unknown>;
  evaluate<T>(expression: string): Promise<T>;
  close(): void;
}

interface RendererControlOperations {
  inspect(inspector: RendererInspector): Promise<ElectronRendererSummary[]>;
  installTitlePolicy(inspector: RendererInspector): Promise<MainProcessTitlePolicyStatus>;
  markTitlePolicyReady(inspector: RendererInspector): Promise<RendererTitlePolicyReadiness>;
  installDraftPrewarmPolicy(
    inspector: RendererInspector,
    rendererWebContentsId: number,
  ): Promise<RendererDraftPrewarmPolicyStatus>;
  reload(inspector: RendererInspector, rendererWebContentsId: number): Promise<void>;
  execute(
    inspector: RendererInspector,
    rendererWebContentsId: number,
    source: string,
  ): Promise<unknown>;
  readBinding(inspector: RendererInspector, rendererWebContentsId: number): Promise<unknown>;
  readTitlePolicyCounters(
    inspector: RendererInspector,
  ): Promise<MainProcessTitlePolicyCounters | null>;
}

export interface RendererControlSession {
  readonly snapshot: RendererControlSnapshot;
  ensureInstalled(): Promise<RendererControlSnapshot>;
  activateDesktop(): Promise<number>;
  executeRenderer<T>(expression: string): Promise<T>;
  readTitlePolicyCounters(): Promise<MainProcessTitlePolicyCounters | null>;
  close(): void;
}

export interface InstallRendererControlOptions {
  inspectorEndpoint: string;
  rendererSource: string;
  enabledAgents?: readonly string[];
  pollIntervalMs?: number;
  timeoutMs?: number;
}

interface CreateRendererControlOptions extends InstallRendererControlOptions {
  inspector: RendererInspector;
  operations?: RendererControlOperations;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeTargetUrl(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) return "unknown";
  try {
    const url = new URL(value);
    return url.protocol === "app:" ? `${url.protocol}//${url.host}${url.pathname}` : url.protocol;
  } catch {
    return "unknown";
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function sameAgents(actual: readonly string[], expected: readonly string[]): boolean {
  return (
    actual.length === expected.length && actual.every((agent, index) => agent === expected[index])
  );
}

function validateBindingStatus(
  value: unknown,
  expectedAgents: readonly string[],
): ProductionRendererStatus {
  if (
    !isRecord(value) ||
    value.version !== 2 ||
    !Array.isArray(value.enabledAgents) ||
    value.enabledAgents.some((agent) => typeof agent !== "string") ||
    !sameAgents(value.enabledAgents as string[], expectedAgents) ||
    !isRecord(value.adapter)
  ) {
    throw new Error("Production Renderer binding returned an invalid status");
  }
  if (value.adapter.state !== "ready" || typeof value.adapter.reason !== "string") {
    const state = typeof value.adapter.state === "string" ? value.adapter.state : "invalid";
    const reason = typeof value.adapter.reason === "string" ? value.adapter.reason : "unknown";
    throw new Error(`Production Renderer Adapter is ${state}: ${reason}`);
  }
  return value as unknown as ProductionRendererStatus;
}

function isTransientBindingReadinessError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message ===
      "Production Renderer Adapter is unsupported: model-controller-unavailable"
  );
}

export function selectRendererWebContents(
  contents: readonly ElectronRendererSummary[],
): ElectronRendererSummary | null {
  const candidates = contents
    .filter(
      (item) =>
        item.type === "window" &&
        item.surface === "primary" &&
        item.runtime.available &&
        item.runtime.elementCount !== null,
    )
    .toSorted(
      (left, right) => (right.runtime.elementCount ?? 0) - (left.runtime.elementCount ?? 0),
    );
  const selected = candidates[0];
  return selected && (selected.runtime.elementCount ?? 0) >= 50 ? selected : null;
}

export async function waitForRendererTitlePolicyReady(
  markReadiness: () => Promise<RendererTitlePolicyReadiness>,
  options: {
    timeoutMs?: number;
    pollIntervalMs?: number;
    now?: () => number;
    sleep?: (milliseconds: number) => Promise<void>;
  } = {},
): Promise<RendererTitlePolicyReadiness> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const now = options.now ?? Date.now;
  const wait = options.sleep ?? sleep;
  const deadline = now() + timeoutMs;
  let lastError: unknown;
  while (now() < deadline) {
    try {
      return await markReadiness();
    } catch (error) {
      lastError = error;
    }
    await wait(pollIntervalMs);
  }
  const detail = lastError instanceof Error ? `: ${lastError.message}` : "";
  throw new Error(`Renderer title policy ownership did not become ready${detail}`);
}

export async function waitForInspectorTarget(
  endpoint: string,
  options: {
    fetchImpl?: CdpFetch;
    pollIntervalMs?: number;
    timeoutMs?: number;
  } = {},
): Promise<CdpTarget> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const targets = await listCdpTargets(endpoint, options.fetchImpl);
      const inspector = targets.find((target) => target.type === "node");
      if (inspector) return inspector;
      lastError = new Error("Inspector has no Node target");
    } catch (error) {
      lastError = error;
    }
    await sleep(pollIntervalMs);
  }
  const detail = lastError instanceof Error ? `: ${lastError.message}` : "";
  throw new Error(`Electron main-process Inspector did not become ready${detail}`);
}

const electronModuleExpression = `(() => {
  const mainModule = process.mainModule;
  if (mainModule != null && typeof mainModule.require === 'function') {
    return mainModule.require('electron');
  }
  const { createRequire } = process.getBuiltinModule('module');
  return createRequire(process.execPath)('electron');
})()`;

const webContentsRuntimeExpression = `(() => ({
  elementCount: document.querySelectorAll('*').length,
  editorCandidates: document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]').length,
  sendButtonCandidates: [...document.querySelectorAll('button')].filter((button) => button.type === 'submit').length
}))()`;

export async function inspectElectronWebContents(
  inspector: Pick<RendererInspector, "evaluate">,
): Promise<ElectronRendererSummary[]> {
  const value = await inspector.evaluate<unknown>(`(async () => {
    const { webContents } = ${electronModuleExpression};
    const result = [];
    for (const contents of webContents.getAllWebContents()) {
      let runtime = { available: false, elementCount: null, editorCandidates: null, sendButtonCandidates: null };
      try {
        const evaluation = contents.executeJavaScript(${JSON.stringify(webContentsRuntimeExpression)}, true);
        const timeout = new Promise((_, reject) => {
          setTimeout(() => reject(new Error('Renderer inspection timed out')), 2_000);
        });
        runtime = { available: true, ...(await Promise.race([evaluation, timeout])) };
      } catch {}
      result.push({
        id: contents.id,
        type: contents.getType(),
        surface: contents.getURL().includes('avatar-overlay') ? 'overlay' : 'primary',
        url: contents.getURL(),
        runtime,
      });
    }
    return result;
  })()`);
  if (!Array.isArray(value)) throw new Error("Electron webContents inspection returned an array");
  return value.map((item) => {
    if (
      !isRecord(item) ||
      !Number.isInteger(item.id) ||
      typeof item.type !== "string" ||
      !["primary", "overlay"].includes(String(item.surface)) ||
      !isRecord(item.runtime)
    ) {
      throw new Error("Electron webContents inspection returned an invalid item");
    }
    return {
      id: item.id as number,
      type: item.type,
      surface: item.surface as "primary" | "overlay",
      url: safeTargetUrl(item.url),
      runtime: {
        available: item.runtime.available === true,
        elementCount: Number.isInteger(item.runtime.elementCount)
          ? (item.runtime.elementCount as number)
          : null,
        editorCandidates: Number.isInteger(item.runtime.editorCandidates)
          ? (item.runtime.editorCandidates as number)
          : null,
        sendButtonCandidates: Number.isInteger(item.runtime.sendButtonCandidates)
          ? (item.runtime.sendButtonCandidates as number)
          : null,
      },
    };
  });
}

export async function activateElectronDesktop(
  inspector: Pick<RendererInspector, "evaluate">,
): Promise<number> {
  const value = await inspector.evaluate<unknown>(`(() => {
    const { BrowserWindow } = ${electronModuleExpression};
    const windows = BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed());
    for (const window of windows) {
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    }
    return windows.length;
  })()`);
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new Error("Electron Desktop activation found no live window");
  }
  return value as number;
}

async function executeInWebContents<T>(
  inspector: Pick<RendererInspector, "evaluate">,
  rendererWebContentsId: number,
  source: string,
): Promise<T> {
  return inspector.evaluate<T>(`(async () => {
    const { webContents } = ${electronModuleExpression};
    const contents = webContents.fromId(${rendererWebContentsId});
    if (contents == null || contents.isDestroyed()) throw new Error('Renderer webContents is unavailable');
    const result = await contents.executeJavaScript(${JSON.stringify(source)}, true);
    return result === undefined ? null : result;
  })()`);
}

async function reloadRenderer(
  inspector: Pick<RendererInspector, "evaluate">,
  rendererWebContentsId: number,
): Promise<void> {
  await executeInWebContents(inspector, rendererWebContentsId, "location.reload(); null");
}

const defaultOperations: RendererControlOperations = {
  inspect: inspectElectronWebContents,
  installTitlePolicy: installMainProcessTitlePolicy,
  markTitlePolicyReady: markRendererTitlePolicyReady,
  installDraftPrewarmPolicy: installRendererDraftPrewarmPolicy,
  reload: reloadRenderer,
  execute: executeInWebContents,
  readBinding: (inspector, rendererWebContentsId) =>
    executeInWebContents(
      inspector,
      rendererWebContentsId,
      "window.__codexhostRendererBindingProbeV1?.status() ?? null",
    ),
  readTitlePolicyCounters: readMainProcessTitlePolicyCounters,
};

async function waitForRenderer(
  inspector: RendererInspector,
  operations: RendererControlOperations,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<{ inventory: ElectronRendererSummary[]; renderer: ElectronRendererSummary }> {
  const deadline = Date.now() + timeoutMs;
  let inventory: ElectronRendererSummary[] = [];
  while (Date.now() < deadline) {
    inventory = await operations.inspect(inspector);
    const renderer = selectRendererWebContents(inventory);
    if (renderer) return { inventory, renderer };
    await sleep(pollIntervalMs);
  }
  throw new Error(
    `Inspector did not find a populated Electron Renderer (${inventory.length} seen)`,
  );
}

async function waitForBinding(
  inspector: RendererInspector,
  operations: RendererControlOperations,
  rendererWebContentsId: number,
  enabledAgents: readonly string[],
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<ProductionRendererStatus> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await operations.readBinding(inspector, rendererWebContentsId);
      if (value !== null) return validateBindingStatus(value, enabledAgents);
    } catch (error) {
      lastError = error;
      if (
        error instanceof Error &&
        error.message.startsWith("Production Renderer Adapter is") &&
        !isTransientBindingReadinessError(error)
      ) {
        throw error;
      }
    }
    await sleep(pollIntervalMs);
  }
  const detail = lastError instanceof Error ? `: ${lastError.message}` : "";
  throw new Error(`Production Renderer binding did not become ready${detail}`);
}

class InstalledRendererControlSession implements RendererControlSession {
  #closed = false;
  #snapshot: RendererControlSnapshot;

  constructor(
    private readonly inspector: RendererInspector,
    private readonly rendererSource: string,
    private readonly enabledAgents: readonly string[],
    private readonly timeoutMs: number,
    private readonly pollIntervalMs: number,
    private readonly operations: RendererControlOperations,
    snapshot: RendererControlSnapshot,
  ) {
    this.#snapshot = snapshot;
  }

  get snapshot(): RendererControlSnapshot {
    return this.#snapshot;
  }

  async ensureInstalled(): Promise<RendererControlSnapshot> {
    if (this.#closed) throw new Error("Renderer Control Session is closed");
    const selected = await waitForRenderer(
      this.inspector,
      this.operations,
      this.timeoutMs,
      this.pollIntervalMs,
    );
    const existing = await this.operations
      .readBinding(this.inspector, selected.renderer.id)
      .catch(() => null);
    if (existing !== null) {
      const binding = validateBindingStatus(existing, this.enabledAgents);
      this.#snapshot = { ...this.#snapshot, ...selected, binding };
      return this.#snapshot;
    }

    const titlePolicyReadiness = await waitForRendererTitlePolicyReady(
      () => this.operations.markTitlePolicyReady(this.inspector),
      { timeoutMs: this.timeoutMs, pollIntervalMs: this.pollIntervalMs },
    );
    const draftPrewarmPolicy = await this.operations.installDraftPrewarmPolicy(
      this.inspector,
      selected.renderer.id,
    );
    await this.operations.execute(this.inspector, selected.renderer.id, this.rendererSource);
    const binding = await waitForBinding(
      this.inspector,
      this.operations,
      selected.renderer.id,
      this.enabledAgents,
      this.timeoutMs,
      this.pollIntervalMs,
    );
    this.#snapshot = {
      ...this.#snapshot,
      ...selected,
      titlePolicyReadiness,
      draftPrewarmPolicy,
      binding,
    };
    return this.#snapshot;
  }

  activateDesktop(): Promise<number> {
    if (this.#closed) return Promise.reject(new Error("Renderer Control Session is closed"));
    return activateElectronDesktop(this.inspector);
  }

  executeRenderer<T>(expression: string): Promise<T> {
    if (this.#closed) return Promise.reject(new Error("Renderer Control Session is closed"));
    return this.operations.execute(
      this.inspector,
      this.#snapshot.renderer.id,
      expression,
    ) as Promise<T>;
  }

  readTitlePolicyCounters(): Promise<MainProcessTitlePolicyCounters | null> {
    if (this.#closed) return Promise.reject(new Error("Renderer Control Session is closed"));
    return this.operations.readTitlePolicyCounters(this.inspector);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.inspector.close();
  }
}

export async function createRendererControlSession(
  options: CreateRendererControlOptions,
): Promise<RendererControlSession> {
  const enabledAgents = options.enabledAgents ?? ["codex", "pi"];
  const timeoutMs = options.timeoutMs ?? 30_000;
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const operations = options.operations ?? defaultOperations;
  const initial = await waitForRenderer(options.inspector, operations, timeoutMs, pollIntervalMs);
  const titlePolicy = await operations.installTitlePolicy(options.inspector);
  await operations.reload(options.inspector, initial.renderer.id);
  const selected = await waitForRenderer(options.inspector, operations, timeoutMs, pollIntervalMs);
  const titlePolicyReadiness = await waitForRendererTitlePolicyReady(
    () => operations.markTitlePolicyReady(options.inspector),
    { timeoutMs, pollIntervalMs },
  );
  const draftPrewarmPolicy = await operations.installDraftPrewarmPolicy(
    options.inspector,
    selected.renderer.id,
  );
  await operations.execute(options.inspector, selected.renderer.id, options.rendererSource);
  const binding = await waitForBinding(
    options.inspector,
    operations,
    selected.renderer.id,
    enabledAgents,
    timeoutMs,
    pollIntervalMs,
  );
  return new InstalledRendererControlSession(
    options.inspector,
    options.rendererSource,
    enabledAgents,
    timeoutMs,
    pollIntervalMs,
    operations,
    {
      ...selected,
      titlePolicy,
      titlePolicyReadiness,
      draftPrewarmPolicy,
      binding,
    },
  );
}

export async function installRendererControlSession(
  options: InstallRendererControlOptions,
): Promise<RendererControlSession> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const target = await waitForInspectorTarget(options.inspectorEndpoint, {
    timeoutMs,
    pollIntervalMs,
  });
  const inspector = await CdpClient.connect(target.webSocketDebuggerUrl);
  try {
    await inspector.command("Runtime.enable");
    return await createRendererControlSession({
      ...options,
      inspector,
      timeoutMs,
      pollIntervalMs,
    });
  } catch (error) {
    inspector.close();
    throw error;
  }
}
