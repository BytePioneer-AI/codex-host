import {
  CdpClient,
  listCdpTargets,
  type CdpClientOptions,
  type CdpFetch,
  type CdpTarget,
} from "./cdp-client.js";
import {
  installRendererDraftPrewarmPolicyDirect,
  type RendererDraftPrewarmPolicyStatus,
} from "./renderer-draft-prewarm-policy.js";

export interface ProductionRendererStatus {
  version: 2;
  enabledAgents: string[];
  adapter: {
    state: "ready";
    reason: string;
  };
}

export interface RendererCdpControlSnapshot {
  target: CdpTarget;
  draftPrewarmPolicy: RendererDraftPrewarmPolicyStatus;
  binding: ProductionRendererStatus;
}

interface RendererCdpClient {
  command(method: string, params?: Record<string, unknown>): Promise<unknown>;
  evaluate<T>(expression: string): Promise<T>;
  close(): void;
}

interface RendererCdpControlOperations {
  listTargets(endpoint: string): Promise<CdpTarget[]>;
  connect(webSocketDebuggerUrl: string): Promise<RendererCdpClient>;
  installDraftPrewarmPolicy(renderer: RendererCdpClient): Promise<RendererDraftPrewarmPolicyStatus>;
}

export interface RendererCdpControlSession {
  readonly snapshot: RendererCdpControlSnapshot;
  ensureInstalled(): Promise<RendererCdpControlSnapshot>;
  activateDesktop(): Promise<number>;
  executeRenderer<T>(expression: string): Promise<T>;
  close(): void;
}

export interface InstallRendererCdpControlOptions {
  rendererCdpEndpoint: string;
  rendererSource: string;
  enabledAgents?: readonly string[];
  pollIntervalMs?: number;
  timeoutMs?: number;
}

interface CreateRendererCdpControlOptions extends InstallRendererCdpControlOptions {
  operations?: RendererCdpControlOperations;
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

function isPrimaryRendererUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "app:" &&
      url.hostname === "-" &&
      url.pathname === "/index.html" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

export function selectPrimaryRendererTarget(
  targets: readonly CdpTarget[],
  preferredTargetId?: string,
): CdpTarget | null {
  const candidates = targets.filter(
    (target) => target.type === "page" && isPrimaryRendererUrl(target.url),
  );
  return candidates.find((target) => target.id === preferredTargetId) ?? candidates.at(0) ?? null;
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

async function waitForPrimaryTarget(
  endpoint: string,
  operations: RendererCdpControlOperations,
  timeoutMs: number,
  pollIntervalMs: number,
  preferredTargetId?: string,
): Promise<CdpTarget> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const target = selectPrimaryRendererTarget(
        await operations.listTargets(endpoint),
        preferredTargetId,
      );
      if (target) return target;
      lastError = new Error("Renderer CDP has no primary app://-/index.html page target");
    } catch (error) {
      lastError = error;
    }
    await sleep(pollIntervalMs);
  }
  const detail = lastError instanceof Error ? `: ${lastError.message}` : "";
  throw new Error(`Primary Codex Renderer CDP target did not become ready${detail}`);
}

async function evaluateSource(renderer: RendererCdpClient, source: string): Promise<void> {
  const response = await renderer.command("Runtime.evaluate", {
    expression: source,
    awaitPromise: true,
  });
  if (!isRecord(response)) throw new Error("Renderer source evaluation returned an invalid result");
  if (isRecord(response.exceptionDetails)) {
    const text =
      typeof response.exceptionDetails.text === "string"
        ? response.exceptionDetails.text
        : "Renderer source evaluation failed";
    throw new Error(text);
  }
}

async function readBinding(renderer: RendererCdpClient): Promise<unknown> {
  return renderer.evaluate<unknown>("window.__codexhostRendererBindingProbeV1?.status() ?? null");
}

async function waitForBinding(
  renderer: RendererCdpClient,
  enabledAgents: readonly string[],
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<ProductionRendererStatus> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await readBinding(renderer);
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

async function installTarget(
  target: CdpTarget,
  rendererSource: string,
  enabledAgents: readonly string[],
  timeoutMs: number,
  pollIntervalMs: number,
  operations: RendererCdpControlOperations,
): Promise<{ renderer: RendererCdpClient; snapshot: RendererCdpControlSnapshot }> {
  const renderer = await operations.connect(target.webSocketDebuggerUrl);
  try {
    await renderer.command("Runtime.enable");
    await renderer.command("Page.enable");
    await renderer.command("Page.addScriptToEvaluateOnNewDocument", { source: rendererSource });
    await evaluateSource(renderer, rendererSource);
    const draftPrewarmPolicy = await operations.installDraftPrewarmPolicy(renderer);
    const binding = await waitForBinding(renderer, enabledAgents, timeoutMs, pollIntervalMs);
    return { renderer, snapshot: { target, draftPrewarmPolicy, binding } };
  } catch (error) {
    renderer.close();
    throw error;
  }
}

class InstalledRendererCdpControlSession implements RendererCdpControlSession {
  #closed = false;

  constructor(
    private renderer: RendererCdpClient,
    private readonly rendererCdpEndpoint: string,
    private readonly rendererSource: string,
    private readonly enabledAgents: readonly string[],
    private readonly timeoutMs: number,
    private readonly pollIntervalMs: number,
    private readonly operations: RendererCdpControlOperations,
    private currentSnapshot: RendererCdpControlSnapshot,
  ) {}

  get snapshot(): RendererCdpControlSnapshot {
    return this.currentSnapshot;
  }

  async ensureInstalled(): Promise<RendererCdpControlSnapshot> {
    if (this.#closed) throw new Error("Renderer CDP Control Session is closed");
    const target = await waitForPrimaryTarget(
      this.rendererCdpEndpoint,
      this.operations,
      this.timeoutMs,
      this.pollIntervalMs,
      this.currentSnapshot.target.id,
    );
    if (target.id !== this.currentSnapshot.target.id) {
      const replacement = await installTarget(
        target,
        this.rendererSource,
        this.enabledAgents,
        this.timeoutMs,
        this.pollIntervalMs,
        this.operations,
      );
      this.renderer.close();
      this.renderer = replacement.renderer;
      this.currentSnapshot = replacement.snapshot;
      return this.currentSnapshot;
    }

    try {
      const existing = await readBinding(this.renderer);
      if (existing === null) await evaluateSource(this.renderer, this.rendererSource);
      else validateBindingStatus(existing, this.enabledAgents);
      const draftPrewarmPolicy = await this.operations.installDraftPrewarmPolicy(this.renderer);
      const binding = await waitForBinding(
        this.renderer,
        this.enabledAgents,
        this.timeoutMs,
        this.pollIntervalMs,
      );
      this.currentSnapshot = { target, draftPrewarmPolicy, binding };
      return this.currentSnapshot;
    } catch {
      const replacement = await installTarget(
        target,
        this.rendererSource,
        this.enabledAgents,
        this.timeoutMs,
        this.pollIntervalMs,
        this.operations,
      );
      this.renderer.close();
      this.renderer = replacement.renderer;
      this.currentSnapshot = replacement.snapshot;
      return this.currentSnapshot;
    }
  }

  async activateDesktop(): Promise<number> {
    if (this.#closed) throw new Error("Renderer CDP Control Session is closed");
    await this.renderer.command("Page.bringToFront");
    return 1;
  }

  executeRenderer<T>(expression: string): Promise<T> {
    if (this.#closed) return Promise.reject(new Error("Renderer CDP Control Session is closed"));
    return this.renderer.evaluate<T>(expression);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.renderer.close();
  }
}

const defaultOperations: RendererCdpControlOperations = {
  listTargets: (endpoint) => listCdpTargets(endpoint),
  connect: (webSocketDebuggerUrl) => CdpClient.connect(webSocketDebuggerUrl),
  installDraftPrewarmPolicy: installRendererDraftPrewarmPolicyDirect,
};

export async function createRendererCdpControlSession(
  options: CreateRendererCdpControlOptions,
): Promise<RendererCdpControlSession> {
  const enabledAgents = options.enabledAgents ?? ["codex", "pi"];
  const timeoutMs = options.timeoutMs ?? 30_000;
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const operations = options.operations ?? defaultOperations;
  const target = await waitForPrimaryTarget(
    options.rendererCdpEndpoint,
    operations,
    timeoutMs,
    pollIntervalMs,
  );
  const installed = await installTarget(
    target,
    options.rendererSource,
    enabledAgents,
    timeoutMs,
    pollIntervalMs,
    operations,
  );
  return new InstalledRendererCdpControlSession(
    installed.renderer,
    options.rendererCdpEndpoint,
    options.rendererSource,
    enabledAgents,
    timeoutMs,
    pollIntervalMs,
    operations,
    installed.snapshot,
  );
}

export function installRendererCdpControlSession(
  options: InstallRendererCdpControlOptions,
): Promise<RendererCdpControlSession> {
  return createRendererCdpControlSession(options);
}

export type RendererCdpFetch = CdpFetch;
export type RendererCdpClientOptions = CdpClientOptions;
