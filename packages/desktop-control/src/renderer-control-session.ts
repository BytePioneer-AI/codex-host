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
  runtime: {
    available: boolean;
    elementCount: number | null;
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
  installTitlePolicy(
    inspector: RendererInspector,
    rendererWebContentsId: number,
  ): Promise<MainProcessTitlePolicyStatus>;
  markTitlePolicyReady(
    inspector: RendererInspector,
    rendererWebContentsId: number,
  ): Promise<RendererTitlePolicyReadiness>;
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
  quitDesktop(inspector: RendererInspector): Promise<void>;
}

export type CompatibilityUpdateOutcome = "update-started" | "current" | "unavailable";

export interface RendererControlSession {
  readonly snapshot: RendererControlSnapshot;
  ensureInstalled(): Promise<RendererControlSnapshot>;
  activateDesktop(): Promise<number>;
  quitDesktop(): Promise<void>;
  requestCompatibilityUpdate(): Promise<CompatibilityUpdateOutcome>;
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

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function sameAgents(actual: readonly string[], expected: readonly string[]): boolean {
  return (
    actual.length === expected.length && actual.every((agent, index) => agent === expected[index])
  );
}

class RendererAdapterReadinessError extends Error {
  constructor(
    readonly state: string,
    readonly reason: string,
  ) {
    super(`Production Renderer Adapter is ${state}: ${reason}`);
    this.name = "RendererAdapterReadinessError";
  }
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
    throw new RendererAdapterReadinessError(state, reason);
  }
  return value as unknown as ProductionRendererStatus;
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
  return candidates.find((candidate) => (candidate.runtime.elementCount ?? 0) > 0) ?? null;
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

const webContentsRuntimeExpression =
  "(() => ({ elementCount: document.querySelectorAll('*').length }))()";

export async function inspectElectronWebContents(
  inspector: Pick<RendererInspector, "evaluate">,
): Promise<ElectronRendererSummary[]> {
  const value = await inspector.evaluate<unknown>(`(async () => {
    const { webContents } = ${electronModuleExpression};
    const result = [];
    for (const contents of webContents.getAllWebContents()) {
      let runtime = { available: false, elementCount: null };
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
      runtime: {
        available: item.runtime.available === true,
        elementCount: Number.isInteger(item.runtime.elementCount)
          ? (item.runtime.elementCount as number)
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

export async function quitElectronDesktop(
  inspector: Pick<RendererInspector, "evaluate">,
): Promise<void> {
  const accepted = await inspector.evaluate<unknown>(`(() => {
    const { app } = ${electronModuleExpression};
    setTimeout(() => app.quit(), 100);
    return true;
  })()`);
  if (accepted !== true) throw new Error("Electron Desktop did not accept the quit request");
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
  quitDesktop: quitElectronDesktop,
};

async function waitForRenderer(
  inspector: RendererInspector,
  operations: RendererControlOperations,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<ElectronRendererSummary> {
  const deadline = Date.now() + timeoutMs;
  let candidateCount = 0;
  while (Date.now() < deadline) {
    const inventory = await operations.inspect(inspector);
    candidateCount = inventory.length;
    const renderer = selectRendererWebContents(inventory);
    if (renderer) return renderer;
    await sleep(pollIntervalMs);
  }
  throw new Error(`Inspector did not find a live Electron Renderer (${candidateCount} seen)`);
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
      if (error instanceof RendererAdapterReadinessError && error.state !== "installing") {
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
      .readBinding(this.inspector, selected.id)
      .catch(() => null);
    if (existing !== null) {
      const binding = validateBindingStatus(existing, this.enabledAgents);
      this.#snapshot = { ...this.#snapshot, renderer: selected, binding };
      return this.#snapshot;
    }

    const titlePolicyReadiness = await waitForRendererTitlePolicyReady(
      () => this.operations.markTitlePolicyReady(this.inspector, selected.id),
      { timeoutMs: this.timeoutMs, pollIntervalMs: this.pollIntervalMs },
    );
    await this.operations.execute(this.inspector, selected.id, this.rendererSource);
    const binding = await waitForBinding(
      this.inspector,
      this.operations,
      selected.id,
      this.enabledAgents,
      this.timeoutMs,
      this.pollIntervalMs,
    );
    const draftPrewarmPolicy = await this.operations.installDraftPrewarmPolicy(
      this.inspector,
      selected.id,
    );
    this.#snapshot = {
      ...this.#snapshot,
      renderer: selected,
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

  quitDesktop(): Promise<void> {
    if (this.#closed) return Promise.reject(new Error("Renderer Control Session is closed"));
    return this.operations.quitDesktop(this.inspector);
  }

  async requestCompatibilityUpdate(): Promise<CompatibilityUpdateOutcome> {
    const value = await this.executeRenderer<unknown>(
      "window.__codexhostRendererBindingProbeV1?.requestCompatibilityUpdate?.() ?? 'unavailable'",
    );
    if (value !== "update-started" && value !== "current" && value !== "unavailable") {
      throw new Error("Renderer returned an invalid compatibility update outcome");
    }
    return value;
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
  const titlePolicy = await operations.installTitlePolicy(options.inspector, initial.id);
  await operations.reload(options.inspector, initial.id);
  const selected = await waitForRenderer(options.inspector, operations, timeoutMs, pollIntervalMs);
  const titlePolicyReadiness = await waitForRendererTitlePolicyReady(
    () => operations.markTitlePolicyReady(options.inspector, selected.id),
    {
      timeoutMs,
      pollIntervalMs,
    },
  );
  await operations.execute(options.inspector, selected.id, options.rendererSource);
  const binding = await waitForBinding(
    options.inspector,
    operations,
    selected.id,
    enabledAgents,
    timeoutMs,
    pollIntervalMs,
  );
  const draftPrewarmPolicy = await operations.installDraftPrewarmPolicy(
    options.inspector,
    selected.id,
  );
  return new InstalledRendererControlSession(
    options.inspector,
    options.rendererSource,
    enabledAgents,
    timeoutMs,
    pollIntervalMs,
    operations,
    {
      renderer: selected,
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
