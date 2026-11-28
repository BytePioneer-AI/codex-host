/**
 * Host-owned zero-ID, locally deduplicated anonymous product telemetry
 * (`POST https://ext-stats.chost.dev/v1/telemetry/heartbeat`).
 *
 * Privacy architecture & design rationale:
 * - Zero personal privacy collection: never reads third-party authentication or credential files
 *   and never collects prompts, conversation content, code, file paths, repository names,
 *   accounts, credentials, model/provider usage, token counts, local extensions, private Relay
 *   hostnames, or custom Harness names.
 * - Local-only deduplication (zero ID leaves the machine): DAU / WAU / MAU / new-install /
 *   D1 & D7 retention deduplication is computed strictly locally using calendar dates stored in
 *   `$CODEXHOST_DATA_DIR/telemetry-v1.json`. No `installId`, UUID, hardware fingerprint, or
 *   account hash is ever generated or transmitted. Because the server only receives stateless
 *   counter increments, requests cannot be correlated to any individual user or device.
 * - Strictly scoped & easy to disable: automatically disabled in local source checkouts
 *   (`development` builds) and CI environments; disabled immediately via `CODEXHOST_TELEMETRY=0`,
 *   `DO_NOT_TRACK=1`, `CODEXHOST_TELEMETRY_URL=off`, or setting `"enabled": false` in
 *   `telemetry-v1.json`. Set `CODEXHOST_TELEMETRY_DEBUG=1` to print outgoing JSON payloads to
 *   stderr. See `docs/product/product-telemetry.md` and `docs/PRIVACY.md`.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { JsonRpcRequest, JsonValue } from "@codexhost/protocol-core";
import {
  DEFAULT_PRODUCT_TELEMETRY_URL,
  PRODUCT_TELEMETRY_GET_METHOD,
  PRODUCT_TELEMETRY_SET_METHOD,
  PRODUCT_TELEMETRY_SIGNAL_METHOD,
  jsonValueSchema,
  normalizeTelemetryHarnessId,
  normalizeTelemetryUiLanguage,
  productTelemetryHeartbeatSchema,
  productTelemetrySetParamsSchema,
  productTelemetrySignalParamsSchema,
  type ProductTelemetryHeartbeat,
  type ProductTelemetrySettings,
  type ProductTelemetrySignalParams,
  type TelemetryHarness,
  type TelemetryRemoteAccessChannel,
  type TelemetrySurface,
  type TelemetryUiLanguage,
} from "@codexhost/shared-contracts";
import { readRuntimeMetadata } from "@codexhost/update-manager";

import type { ConsoleHostReply } from "./app-server-host.js";
import { rpcEnvelope, rpcError } from "./desktop-rpc.js";
import { codexhostDataDirectory } from "./external-clients.js";

const TELEMETRY_STATE_FILE = "telemetry-v1.json";
const MAX_STATE_FILE_BYTES = 64 * 1024;
const MAX_STARTUP_FILE_BYTES = 256 * 1024;
const INITIAL_FLUSH_DELAY_MS = 15_000;
const DELTA_FLUSH_DELAY_MS = 45_000;
const ROLLOVER_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 3_000;
const DISABLED_ENV_VALUES = /^(?:0|false|off|no|none)$/iu;
const ENABLED_ENV_VALUES = /^(?:1|true|yes|on)$/iu;
const UTC_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

const CI_ENV_VARS = [
  "CI",
  "GITHUB_ACTIONS",
  "GITLAB_CI",
  "BUILDKITE",
  "CIRCLECI",
  "JENKINS_URL",
  "TRAVIS",
  "TF_BUILD",
  "BITBUCKET_BUILD_NUMBER",
  "CODEBUILD_BUILD_ID",
] as const;

/**
 * Local-only deduplication state persisted to `$CODEXHOST_DATA_DIR/telemetry-v1.json`.
 * Contains ONLY calendar markers and today's already-counted dimension sets — NEVER any
 * `installId`, UUID, or device identifier.
 */
interface PersistedTelemetryFile {
  version: 1;
  enabled: boolean;
  firstSeenDay?: string | undefined;
  lastDailyDay?: string | undefined;
  lastWeeklyKey?: string | undefined;
  lastMonthlyKey?: string | undefined;
  sentRetainedD1?: boolean | undefined;
  sentRetainedD7?: boolean | undefined;
  sentDay?: string | undefined;
  sentAppVersion?: boolean | undefined;
  sentCodexDesktopVersion?: boolean | undefined;
  sentEnv?: boolean | undefined;
  sentUiLanguage?: boolean | undefined;
  sentSurfaces?: string[] | undefined;
  sentHarnesses?: string[] | undefined;
  sentRemoteAccess?: string[] | undefined;
  sentRemoteAny?: boolean | undefined;
}

export function isProductTelemetryMethod(method: string): boolean {
  return (
    method === PRODUCT_TELEMETRY_GET_METHOD ||
    method === PRODUCT_TELEMETRY_SET_METHOD ||
    method === PRODUCT_TELEMETRY_SIGNAL_METHOD
  );
}

export function isCiEnvironment(environment: NodeJS.ProcessEnv = process.env): boolean {
  for (const key of CI_ENV_VARS) {
    const raw = environment[key]?.trim();
    if (raw && !DISABLED_ENV_VALUES.test(raw)) return true;
  }
  return false;
}

export function isTelemetryDisabledByEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  const explicit = environment.CODEXHOST_TELEMETRY;
  if (explicit !== undefined && DISABLED_ENV_VALUES.test(explicit.trim())) return true;
  const dnt = environment.DO_NOT_TRACK;
  if (dnt !== undefined && ENABLED_ENV_VALUES.test(dnt.trim())) return true;
  const url = environment.CODEXHOST_TELEMETRY_URL;
  if (url !== undefined && (url.trim() === "" || DISABLED_ENV_VALUES.test(url.trim()))) {
    return true;
  }
  return false;
}

export function isTelemetryDebugEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
  const raw = environment.CODEXHOST_TELEMETRY_DEBUG;
  return raw !== undefined && ENABLED_ENV_VALUES.test(raw.trim());
}

export function resolveProductTelemetryUrl(
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (isTelemetryDisabledByEnvironment(environment)) return undefined;
  const configured = environment.CODEXHOST_TELEMETRY_URL?.trim();
  const base = configured || DEFAULT_PRODUCT_TELEMETRY_URL;
  try {
    const parsed = new URL(base);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return undefined;
    parsed.pathname = `${parsed.pathname.replace(/\/+$/u, "")}/v1/telemetry/heartbeat`;
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function isAutomatedTestEnvironment(environment: NodeJS.ProcessEnv): boolean {
  return Boolean(
    environment.VITEST ||
    environment.NODE_ENV === "test" ||
    environment.CODEXHOST_TELEMETRY_TEST_DISABLED === "1",
  );
}

function utcDay(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

function utcMonth(day: string): string {
  return day.slice(0, 7);
}

function isoWeek(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

function diffUtcDays(fromDay: string, toDay: string): number {
  const fromMs = Date.parse(`${fromDay}T00:00:00Z`);
  const toMs = Date.parse(`${toDay}T00:00:00Z`);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return Number.NaN;
  return Math.round((toMs - fromMs) / 86_400_000);
}

function currentOs(): "darwin" | "win32" | "linux" | undefined {
  return process.platform === "darwin" ||
    process.platform === "win32" ||
    process.platform === "linux"
    ? process.platform
    : undefined;
}

function currentArch(): "arm64" | "x64" | "ia32" | "arm" | undefined {
  return process.arch === "arm64" ||
    process.arch === "x64" ||
    process.arch === "ia32" ||
    process.arch === "arm"
    ? process.arch
    : undefined;
}

function currentUiLanguage(): TelemetryUiLanguage | undefined {
  try {
    const raw = Intl.DateTimeFormat().resolvedOptions().locale;
    return typeof raw === "string" ? normalizeTelemetryUiLanguage(raw) : undefined;
  } catch {
    return undefined;
  }
}

async function readCodexDesktopVersion(dataDir: string): Promise<string | undefined> {
  const filePath = join(dataDir, "diagnostics", "launcher-startup-v1.json");
  try {
    const meta = await stat(filePath);
    if (!meta.isFile() || meta.size > MAX_STARTUP_FILE_BYTES) return undefined;
    const doc = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    if (!doc || typeof doc !== "object" || !Array.isArray((doc as { records?: unknown }).records)) {
      return undefined;
    }
    const records = (doc as { records: unknown[] }).records;
    for (let i = records.length - 1; i >= 0; i -= 1) {
      const entry = records[i];
      if (!entry || typeof entry !== "object") continue;
      const desktop = (entry as { desktop?: unknown }).desktop;
      if (
        desktop &&
        typeof desktop === "object" &&
        typeof (desktop as { version?: unknown }).version === "string"
      ) {
        const version = (desktop as { version: string }).version.trim();
        if (version && /^[0-9A-Za-z._+-]{1,40}$/u.test(version)) return version;
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function validDay(value: unknown): string | undefined {
  return typeof value === "string" && UTC_DAY_PATTERN.test(value) ? value : undefined;
}

export interface HostProductTelemetryOptions {
  runtimePath?: string | undefined;
  environment?: NodeJS.ProcessEnv | undefined;
  dataDirectory?: string | undefined;
  readRuntimeInfo?:
    | (() => Promise<
        { version: string; distribution: "development" | "npm" | "installer" } | undefined
      >)
    | undefined;
  readCodexDesktopVersion?: (() => Promise<string | undefined>) | undefined;
  readUiLanguage?: (() => TelemetryUiLanguage | undefined) | undefined;
  fetchImpl?: typeof fetch | undefined;
  debugLog?: ((line: string) => void) | undefined;
  now?: (() => number) | undefined;
  initialFlushDelayMs?: number | undefined;
  deltaFlushDelayMs?: number | undefined;
}

/**
 * Zero-ID, locally deduplicated anonymous daily product telemetry owned by the Host Runtime.
 * Sends only stateless aggregate deltas when enabled on official release builds, strictly
 * respecting `CODEXHOST_TELEMETRY=0`, `DO_NOT_TRACK=1`, CI environments, and user opt-out.
 */
export class HostProductTelemetry {
  readonly #environment: NodeJS.ProcessEnv;
  readonly #directory: string;
  readonly #file: string;
  readonly #runtimeInfo: Promise<
    { version: string; distribution: "development" | "npm" | "installer" } | undefined
  >;
  readonly #readDesktopVersion: () => Promise<string | undefined>;
  readonly #readUiLanguage: () => TelemetryUiLanguage | undefined;
  readonly #fetch: typeof fetch;
  readonly #debugLog: (line: string) => void;
  readonly #explicitTransport: boolean;
  readonly #now: () => number;
  readonly #initialDelayMs: number;
  readonly #deltaDelayMs: number;

  #day = "";
  readonly #surfaces = new Set<TelemetrySurface>();
  readonly #harnesses = new Set<TelemetryHarness>();
  readonly #remoteAccess = new Set<TelemetryRemoteAccessChannel>();

  #loaded: Promise<PersistedTelemetryFile> | undefined;
  #flushTimer: NodeJS.Timeout | undefined;
  #rolloverTimer: NodeJS.Timeout | undefined;
  #inFlight: Promise<boolean> | undefined;
  #abortController = new AbortController();
  #closed = false;

  constructor(options: HostProductTelemetryOptions = {}) {
    this.#environment = options.environment ?? process.env;
    this.#directory = options.dataDirectory ?? codexhostDataDirectory(this.#environment);
    this.#file = join(this.#directory, TELEMETRY_STATE_FILE);
    this.#runtimeInfo = options.readRuntimeInfo
      ? options.readRuntimeInfo().catch(() => undefined)
      : options.runtimePath
        ? readRuntimeMetadata(options.runtimePath, this.#environment).catch(() => undefined)
        : Promise.resolve(undefined);
    this.#readDesktopVersion =
      options.readCodexDesktopVersion ?? (() => readCodexDesktopVersion(this.#directory));
    this.#readUiLanguage = options.readUiLanguage ?? currentUiLanguage;
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
    this.#debugLog = options.debugLog ?? ((line) => process.stderr.write(`${line}\n`));
    this.#explicitTransport = Boolean(
      options.fetchImpl || this.#environment.CODEXHOST_TELEMETRY_URL?.trim(),
    );
    this.#now = options.now ?? Date.now;
    this.#initialDelayMs = options.initialFlushDelayMs ?? INITIAL_FLUSH_DELAY_MS;
    this.#deltaDelayMs = options.deltaFlushDelayMs ?? DELTA_FLUSH_DELAY_MS;
    this.#day = utcDay(this.#now());
  }

  #ensureCurrentDay(): void {
    const today = utcDay(this.#now());
    if (today === this.#day) return;
    this.#day = today;
    this.#harnesses.clear();
    this.#remoteAccess.clear();
  }

  start(): void {
    if (this.#closed) return;
    this.#scheduleFlush(this.#initialDelayMs);
    if (!this.#rolloverTimer) {
      this.#rolloverTimer = setInterval(() => {
        if (this.#closed) return;
        this.#ensureCurrentDay();
        this.#scheduleFlush(this.#initialDelayMs);
      }, ROLLOVER_CHECK_INTERVAL_MS);
      this.#rolloverTimer.unref();
    }
  }

  close(): void {
    this.#closed = true;
    if (this.#flushTimer) {
      clearTimeout(this.#flushTimer);
      this.#flushTimer = undefined;
    }
    if (this.#rolloverTimer) {
      clearInterval(this.#rolloverTimer);
      this.#rolloverTimer = undefined;
    }
    this.#abortController.abort();
  }

  recordSurface(surface: TelemetrySurface): void {
    if (this.#closed) return;
    this.#ensureCurrentDay();
    if (!this.#surfaces.has(surface)) {
      this.#surfaces.add(surface);
      this.#scheduleFlush(this.#deltaDelayMs);
    }
  }

  recordHarness(harnessId: string): void {
    if (this.#closed) return;
    this.#ensureCurrentDay();
    const normalized = normalizeTelemetryHarnessId(harnessId);
    if (!this.#harnesses.has(normalized)) {
      this.#harnesses.add(normalized);
      this.#scheduleFlush(this.#deltaDelayMs);
    }
  }

  recordSignal(signal: ProductTelemetrySignalParams): void {
    if (this.#closed) return;
    this.#ensureCurrentDay();
    let changed = false;
    for (const s of signal.surfaces ?? []) {
      if (!this.#surfaces.has(s)) {
        this.#surfaces.add(s);
        changed = true;
      }
    }
    for (const h of signal.harnesses ?? []) {
      if (!this.#harnesses.has(h)) {
        this.#harnesses.add(h);
        changed = true;
      }
    }
    for (const r of signal.remoteAccess ?? []) {
      if (!this.#remoteAccess.has(r)) {
        this.#remoteAccess.add(r);
        changed = true;
      }
    }
    if (changed) this.#scheduleFlush(this.#deltaDelayMs);
  }

  async getSettings(): Promise<ProductTelemetrySettings> {
    const state = await this.#loadState();
    const forcedOffByEnv =
      isTelemetryDisabledByEnvironment(this.#environment) || isCiEnvironment(this.#environment);
    return {
      enabled: state.enabled && !forcedOffByEnv,
      forcedOffByEnv,
    };
  }

  async setEnabled(enabled: boolean): Promise<ProductTelemetrySettings> {
    const state = await this.#loadState();
    const next: PersistedTelemetryFile = { ...state, enabled };
    await this.#saveState(next);
    this.#loaded = Promise.resolve(next);
    const forcedOffByEnv =
      isTelemetryDisabledByEnvironment(this.#environment) || isCiEnvironment(this.#environment);
    if (enabled && !forcedOffByEnv) {
      this.#scheduleFlush(this.#initialDelayMs);
    }
    return {
      enabled: next.enabled && !forcedOffByEnv,
      forcedOffByEnv,
    };
  }

  #scheduleFlush(delayMs: number): void {
    if (this.#closed || this.#flushTimer) return;
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = undefined;
      void this.flushNow();
    }, delayMs);
    this.#flushTimer.unref();
  }

  async flushNow(): Promise<boolean> {
    if (this.#closed) return false;
    if (this.#inFlight) return this.#inFlight;
    const run = this.#doFlush().finally(() => {
      if (this.#inFlight === run) this.#inFlight = undefined;
    });
    this.#inFlight = run;
    return run;
  }

  async #doFlush(): Promise<boolean> {
    if (this.#closed) return false;
    // Fail-closed in tests and CI environments unless a custom test transport is explicitly provided.
    if (
      !this.#explicitTransport &&
      (isAutomatedTestEnvironment(this.#environment) || isCiEnvironment(this.#environment))
    ) {
      return false;
    }
    const endpoint = resolveProductTelemetryUrl(this.#environment);
    if (!endpoint) return false;

    const [runtimeInfo, state] = await Promise.all([this.#runtimeInfo, this.#loadState()]);
    if (!state.enabled) return false;
    // Official release builds only: local source checkouts (`development`) send zero telemetry
    // unless explicitly pointed at a custom endpoint via `CODEXHOST_TELEMETRY_URL`.
    if (!this.#explicitTransport && runtimeInfo?.distribution === "development") {
      return false;
    }

    this.#ensureCurrentDay();
    const today = this.#day;
    const week = isoWeek(today);
    const month = utcMonth(today);

    const appVersion = runtimeInfo?.version;
    const codexDesktopVersion = this.#surfaces.has("codex-desktop")
      ? await this.#readDesktopVersion()
      : undefined;
    const os = currentOs();
    const arch = currentArch();
    const uiLanguage = this.#readUiLanguage();

    // Local-only deduplication: compute strictly additive deltas against local date markers
    // so the server never needs or receives any client identifier.
    const sameDay = state.sentDay === today;
    const sentSurfaces = new Set(sameDay ? (state.sentSurfaces ?? []) : []);
    const sentHarnesses = new Set(sameDay ? (state.sentHarnesses ?? []) : []);
    const sentRemoteAccess = new Set(sameDay ? (state.sentRemoteAccess ?? []) : []);

    const isNewInstall = state.firstSeenDay === undefined;
    const isDailyActive = state.lastDailyDay !== today;
    const isWeeklyActive = state.lastWeeklyKey !== week;
    const isMonthlyActive = state.lastMonthlyKey !== month;
    const ageDays = state.firstSeenDay ? diffUtcDays(state.firstSeenDay, today) : 0;
    const isRetainedD1 = Boolean(state.firstSeenDay && !state.sentRetainedD1 && ageDays === 1);
    const isRetainedD7 = Boolean(state.firstSeenDay && !state.sentRetainedD7 && ageDays === 7);

    const deltaSurfaces = [...this.#surfaces].filter((s) => !sentSurfaces.has(s)).sort();
    const deltaHarnesses = [...this.#harnesses].filter((h) => !sentHarnesses.has(h)).sort();
    const deltaRemoteAccess = [...this.#remoteAccess]
      .filter((r) => !sentRemoteAccess.has(r))
      .sort();
    const isRemoteAny = this.#remoteAccess.size > 0 && !(sameDay && state.sentRemoteAny);

    const sendAppVersion = Boolean(appVersion && !(sameDay && state.sentAppVersion));
    const sendCodexDesktopVersion = Boolean(
      codexDesktopVersion && !(sameDay && state.sentCodexDesktopVersion),
    );
    const sendEnv = Boolean((os || arch) && !(sameDay && state.sentEnv));
    const sendUiLanguage = Boolean(uiLanguage && !(sameDay && state.sentUiLanguage));

    const rawPayload: Record<string, unknown> = {
      ...(isNewInstall ? { newInstall: true } : {}),
      ...(isDailyActive ? { dailyActive: true } : {}),
      ...(isWeeklyActive ? { weeklyActive: true } : {}),
      ...(isMonthlyActive ? { monthlyActive: true } : {}),
      ...(isRetainedD1 ? { retainedD1: true } : {}),
      ...(isRetainedD7 ? { retainedD7: true } : {}),
      ...(isRemoteAny ? { remoteAny: true } : {}),
      ...(sendAppVersion ? { appVersion } : {}),
      ...(sendCodexDesktopVersion ? { codexDesktopVersion } : {}),
      ...(sendEnv && os ? { os } : {}),
      ...(sendEnv && arch ? { arch } : {}),
      ...(sendUiLanguage ? { uiLanguage } : {}),
      ...(deltaSurfaces.length > 0 ? { surfaces: deltaSurfaces } : {}),
      ...(deltaHarnesses.length > 0 ? { harnesses: deltaHarnesses } : {}),
      ...(deltaRemoteAccess.length > 0 ? { remoteAccess: deltaRemoteAccess } : {}),
    };

    if (Object.keys(rawPayload).length === 0) return false;

    const payload: ProductTelemetryHeartbeat = productTelemetryHeartbeatSchema.parse(rawPayload);
    const serialized = JSON.stringify(payload);

    if (isTelemetryDebugEnabled(this.#environment)) {
      this.#debugLog(`[codexhost:telemetry] POST ${endpoint} ${serialized}`);
    }

    // Zero-ID aggregate counter increment: deduplication already happened locally above, and
    // `productTelemetryHeartbeatSchema` guarantees no client ID, prompt, file path, account,
    // credential, model usage, or private hostname can leave this machine.
    // Disable anytime with CODEXHOST_TELEMETRY=0, DO_NOT_TRACK=1, or CODEXHOST_TELEMETRY_URL=off.
    try {
      const response = await this.#fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: serialized,
        credentials: "omit",
        redirect: "error",
        signal: AbortSignal.any([
          this.#abortController.signal,
          AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        ]),
      });
      await response.body?.cancel();
      if (!response.ok) return false;
    } catch {
      return false;
    }

    for (const s of deltaSurfaces) sentSurfaces.add(s);
    for (const h of deltaHarnesses) sentHarnesses.add(h);
    for (const r of deltaRemoteAccess) sentRemoteAccess.add(r);

    const updated: PersistedTelemetryFile = {
      version: 1,
      enabled: state.enabled,
      firstSeenDay: state.firstSeenDay ?? today,
      lastDailyDay: isDailyActive ? today : state.lastDailyDay,
      lastWeeklyKey: isWeeklyActive ? week : state.lastWeeklyKey,
      lastMonthlyKey: isMonthlyActive ? month : state.lastMonthlyKey,
      sentRetainedD1: state.sentRetainedD1 || isRetainedD1 || undefined,
      sentRetainedD7: state.sentRetainedD7 || isRetainedD7 || undefined,
      sentDay: today,
      sentAppVersion: (sameDay && state.sentAppVersion) || sendAppVersion || undefined,
      sentCodexDesktopVersion:
        (sameDay && state.sentCodexDesktopVersion) || sendCodexDesktopVersion || undefined,
      sentEnv: (sameDay && state.sentEnv) || sendEnv || undefined,
      sentUiLanguage: (sameDay && state.sentUiLanguage) || sendUiLanguage || undefined,
      sentSurfaces: [...sentSurfaces].sort(),
      sentHarnesses: [...sentHarnesses].sort(),
      sentRemoteAccess: [...sentRemoteAccess].sort(),
      sentRemoteAny: (sameDay && state.sentRemoteAny) || isRemoteAny || undefined,
    };

    try {
      await this.#saveState(updated);
      this.#loaded = Promise.resolve(updated);
    } catch {
      // Never propagate persistence failures from optional telemetry.
    }
    return true;
  }

  #loadState(): Promise<PersistedTelemetryFile> {
    this.#loaded ??= this.#readOrCreateState();
    return this.#loaded;
  }

  async #readOrCreateState(): Promise<PersistedTelemetryFile> {
    try {
      const meta = await stat(this.#file);
      if (meta.isFile() && meta.size <= MAX_STATE_FILE_BYTES) {
        const parsed = JSON.parse(await readFile(this.#file, "utf8")) as unknown;
        if (parsed && typeof parsed === "object") {
          const doc = parsed as Record<string, unknown>;
          const enabled = typeof doc.enabled === "boolean" ? doc.enabled : true;
          if (doc.version === 1) {
            return {
              version: 1,
              enabled,
              firstSeenDay: validDay(doc.firstSeenDay),
              lastDailyDay: validDay(doc.lastDailyDay),
              lastWeeklyKey: typeof doc.lastWeeklyKey === "string" ? doc.lastWeeklyKey : undefined,
              lastMonthlyKey:
                typeof doc.lastMonthlyKey === "string" ? doc.lastMonthlyKey : undefined,
              sentRetainedD1: doc.sentRetainedD1 === true ? true : undefined,
              sentRetainedD7: doc.sentRetainedD7 === true ? true : undefined,
              sentDay: validDay(doc.sentDay),
              sentAppVersion: doc.sentAppVersion === true ? true : undefined,
              sentCodexDesktopVersion: doc.sentCodexDesktopVersion === true ? true : undefined,
              sentEnv: doc.sentEnv === true ? true : undefined,
              sentUiLanguage: doc.sentUiLanguage === true ? true : undefined,
              sentSurfaces: stringList(doc.sentSurfaces),
              sentHarnesses: stringList(doc.sentHarnesses),
              sentRemoteAccess: stringList(doc.sentRemoteAccess),
              sentRemoteAny: doc.sentRemoteAny === true ? true : undefined,
            };
          }
        }
      }
    } catch {
      // First run or unreadable file: start with a clean zero-ID local deduplication state.
    }
    return { version: 1, enabled: true };
  }

  async #saveState(state: PersistedTelemetryFile): Promise<void> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.#file}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
        flag: "wx",
        mode: 0o600,
      });
      await rename(temporary, this.#file);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

export async function handleProductTelemetryRequest(
  telemetry: HostProductTelemetry | undefined,
  request: JsonRpcRequest,
): Promise<JsonValue> {
  const reply = await handleProductTelemetryClientRequest(
    telemetry,
    request.method,
    request.params,
  );
  if ("error" in reply) {
    return rpcError(request, reply.error.code, reply.error.message);
  }
  return rpcEnvelope(request, { result: reply.result });
}

export async function handleProductTelemetryClientRequest(
  telemetry: HostProductTelemetry | undefined,
  method: string,
  input: unknown,
): Promise<ConsoleHostReply> {
  if (!telemetry) {
    return { error: { code: -32090, message: "Product telemetry is unavailable" } };
  }
  if (method === PRODUCT_TELEMETRY_GET_METHOD) {
    const settings = await telemetry.getSettings();
    return { result: jsonValueSchema.parse(settings) };
  }
  if (method === PRODUCT_TELEMETRY_SET_METHOD) {
    const parsed = productTelemetrySetParamsSchema.safeParse(input);
    if (!parsed.success) {
      return { error: { code: -32602, message: "Invalid telemetry settings" } };
    }
    const settings = await telemetry.setEnabled(parsed.data.enabled);
    return { result: jsonValueSchema.parse(settings) };
  }
  if (method === PRODUCT_TELEMETRY_SIGNAL_METHOD) {
    const parsed = productTelemetrySignalParamsSchema.safeParse(input);
    if (!parsed.success) {
      return { error: { code: -32602, message: "Invalid telemetry signal" } };
    }
    telemetry.recordSignal(parsed.data);
    return { result: { recorded: true } };
  }
  return { error: { code: -32601, message: "Unknown telemetry method" } };
}
