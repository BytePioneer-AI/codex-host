const GET_LOCALE_OVERRIDE_URL = "vscode://codex/get-setting";
const GET_LOCALE_INFO_URL = "vscode://codex/locale-info";
const SET_LOCALE_OVERRIDE_URL = "vscode://codex/set-setting";
const DEFAULT_LOCALE_REQUEST_TIMEOUT_MS = 750;

interface ElectronLocaleBridge {
  sendMessageFromView(message: unknown): unknown;
}

interface ElectronLocaleWindow extends Window {
  electronBridge?: ElectronLocaleBridge;
}

interface LocaleOverrideResponse {
  value: string | null;
}

interface LocaleInfoResponse {
  ideLocale: string | undefined;
  systemLocale: string | undefined;
}

interface SetLocaleOverrideResponse {
  success: true;
}

type FixedLocaleRequest =
  | {
      kind: "locale-override";
      url: typeof GET_LOCALE_OVERRIDE_URL;
      body: string;
    }
  | {
      kind: "locale-info";
      url: typeof GET_LOCALE_INFO_URL;
      body?: undefined;
    }
  | {
      kind: "set-locale-override";
      url: typeof SET_LOCALE_OVERRIDE_URL;
      body: string;
    };

export type CodexLocaleOverride = "en-US" | "zh-CN" | null;
export type CodexLocaleReadStatus = "ready" | "fallback";
export type CodexLocaleMode = "explicit" | "automatic" | "unavailable";
export type CodexLocaleSource = "override" | "ide" | "system" | "navigator" | "default";

export interface CodexLocaleSettings {
  readonly status: CodexLocaleReadStatus;
  readonly mode: CodexLocaleMode;
  readonly localeOverride: string | null | undefined;
  readonly ideLocale: string | undefined;
  readonly systemLocale: string | undefined;
  readonly preferredLocale: string;
  readonly source: CodexLocaleSource;
}

export interface CodexLocaleRequestOptions {
  ownerWindow?: Window;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export type ReadCodexLocaleSettingsOptions = CodexLocaleRequestOptions;
export type SetCodexLocaleOverrideOptions = CodexLocaleRequestOptions;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalLocale(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  try {
    return Intl.getCanonicalLocales(value.trim())[0];
  } catch {
    return undefined;
  }
}

function firstNavigatorLocale(ownerWindow: Window): string | undefined {
  for (const candidate of ownerWindow.navigator.languages) {
    const locale = canonicalLocale(candidate);
    if (locale) return locale;
  }
  return canonicalLocale(ownerWindow.navigator.language);
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted", "AbortError");
}

function parseLocaleOverride(value: unknown): LocaleOverrideResponse {
  if (!isRecord(value) || !("value" in value)) {
    throw new Error("Codex locale override response is malformed");
  }
  if (value.value === null) return { value: null };
  const locale = canonicalLocale(value.value);
  if (!locale) throw new Error("Codex locale override is invalid");
  return { value: locale };
}

function optionalLocale(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  const locale = canonicalLocale(value);
  if (!locale) throw new Error(`Codex ${field} is invalid`);
  return locale;
}

function parseLocaleInfo(value: unknown): LocaleInfoResponse {
  if (!isRecord(value)) throw new Error("Codex locale info response is malformed");
  return {
    ideLocale: optionalLocale(value.ideLocale, "IDE locale"),
    systemLocale: optionalLocale(value.systemLocale, "system locale"),
  };
}

function parseSetLocaleOverride(value: unknown): SetLocaleOverrideResponse {
  if (!isRecord(value) || value.success !== true) {
    throw new Error("Codex locale update response is malformed");
  }
  return { success: true };
}

function sendFixedLocaleRequest(
  request: FixedLocaleRequest,
  ownerWindow: Window,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<unknown> {
  const bridge = (ownerWindow as ElectronLocaleWindow).electronBridge;
  if (typeof bridge?.sendMessageFromView !== "function") {
    return Promise.reject(new Error("Codex locale bridge is unavailable"));
  }
  if (signal?.aborted) return Promise.reject(abortError());

  const requestId = ownerWindow.crypto.randomUUID();
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      ownerWindow.clearTimeout(timer);
      ownerWindow.removeEventListener("message", onMessage);
      signal?.removeEventListener("abort", onAbort);
    };
    const settle = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      operation();
    };
    const onAbort = (): void => settle(() => reject(abortError()));
    const onMessage = (event: MessageEvent): void => {
      const message = event.data;
      if (!isRecord(message) || message.type !== "fetch-response") return;
      if (message.requestId !== requestId) return;
      if (
        message.responseType !== "success" ||
        typeof message.status !== "number" ||
        message.status < 200 ||
        message.status >= 300 ||
        typeof message.bodyJsonString !== "string"
      ) {
        settle(() => reject(new Error("Codex locale request failed")));
        return;
      }
      try {
        const body: unknown = JSON.parse(message.bodyJsonString);
        settle(() => resolve(body));
      } catch {
        settle(() => reject(new Error("Codex locale response is not valid JSON")));
      }
    };
    const timer = ownerWindow.setTimeout(
      () => settle(() => reject(new Error("Codex locale request timed out"))),
      timeoutMs,
    );

    ownerWindow.addEventListener("message", onMessage);
    signal?.addEventListener("abort", onAbort, { once: true });
    const message = {
      type: "fetch",
      requestId,
      method: "POST",
      url: request.url,
      ...(request.body === undefined ? {} : { body: request.body }),
      reportUploadProgress: false,
    };
    try {
      Promise.resolve(bridge.sendMessageFromView(message)).catch((error: unknown) => {
        settle(() => reject(error));
      });
    } catch (error) {
      settle(() => reject(error));
    }
  });
}

async function readLocaleOverride(
  ownerWindow: Window,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<LocaleOverrideResponse> {
  const response = await sendFixedLocaleRequest(
    {
      kind: "locale-override",
      url: GET_LOCALE_OVERRIDE_URL,
      body: JSON.stringify({ key: "localeOverride" }),
    },
    ownerWindow,
    signal,
    timeoutMs,
  );
  return parseLocaleOverride(response);
}

async function readLocaleInfo(
  ownerWindow: Window,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<LocaleInfoResponse> {
  const response = await sendFixedLocaleRequest(
    { kind: "locale-info", url: GET_LOCALE_INFO_URL },
    ownerWindow,
    signal,
    timeoutMs,
  );
  return parseLocaleInfo(response);
}

export async function setCodexLocaleOverride(
  localeOverride: CodexLocaleOverride,
  options: SetCodexLocaleOverrideOptions = {},
): Promise<void> {
  if (localeOverride !== null && localeOverride !== "en-US" && localeOverride !== "zh-CN") {
    throw new Error("Unsupported Codex locale override");
  }
  const ownerWindow = options.ownerWindow ?? window;
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOCALE_REQUEST_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Codex locale request timeout must be positive");
  }
  const response = await sendFixedLocaleRequest(
    {
      kind: "set-locale-override",
      url: SET_LOCALE_OVERRIDE_URL,
      body: JSON.stringify({ key: "localeOverride", value: localeOverride }),
    },
    ownerWindow,
    options.signal,
    timeoutMs,
  );
  parseSetLocaleOverride(response);
}

export async function readCodexLocaleSettings(
  options: ReadCodexLocaleSettingsOptions = {},
): Promise<CodexLocaleSettings> {
  const ownerWindow = options.ownerWindow ?? window;
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOCALE_REQUEST_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Codex locale request timeout must be positive");
  }
  if (options.signal?.aborted) throw abortError();

  const [overrideResult, localeInfoResult] = await Promise.allSettled([
    readLocaleOverride(ownerWindow, options.signal, timeoutMs),
    readLocaleInfo(ownerWindow, options.signal, timeoutMs),
  ]);
  if (options.signal?.aborted) throw abortError();

  const navigatorLocale = firstNavigatorLocale(ownerWindow);
  const overrideKnown = overrideResult.status === "fulfilled";
  const localeOverride = overrideKnown ? overrideResult.value.value : undefined;
  const localeInfo: LocaleInfoResponse =
    localeInfoResult.status === "fulfilled"
      ? localeInfoResult.value
      : { ideLocale: undefined, systemLocale: undefined };

  if (typeof localeOverride === "string") {
    return Object.freeze({
      status: "ready",
      mode: "explicit",
      localeOverride,
      ideLocale: localeInfo.ideLocale,
      systemLocale: localeInfo.systemLocale,
      preferredLocale: localeOverride,
      source: "override",
    });
  }

  if (overrideKnown) {
    const preferredLocale =
      localeInfo.ideLocale ?? localeInfo.systemLocale ?? navigatorLocale ?? "en-US";
    const source: CodexLocaleSource = localeInfo.ideLocale
      ? "ide"
      : localeInfo.systemLocale
        ? "system"
        : navigatorLocale
          ? "navigator"
          : "default";
    return Object.freeze({
      status: "ready",
      mode: "automatic",
      localeOverride: null,
      ideLocale: localeInfo.ideLocale,
      systemLocale: localeInfo.systemLocale,
      preferredLocale,
      source,
    });
  }

  return Object.freeze({
    status: "fallback",
    mode: "unavailable",
    localeOverride: undefined,
    ideLocale: localeInfo.ideLocale,
    systemLocale: localeInfo.systemLocale,
    preferredLocale: navigatorLocale ?? "en-US",
    source: navigatorLocale ? "navigator" : "default",
  });
}
