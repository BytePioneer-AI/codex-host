import { loadCodexNativeServices } from "./codex-native-services.js";

const DEFAULT_LOCALE_REQUEST_TIMEOUT_MS = 750;

interface NativeLocaleServices {
  appInfo: { getLocaleInfo(): Promise<unknown> };
}

function isNativeLocaleServices(value: unknown): value is NativeLocaleServices {
  if (!isRecord(value) || !Object.hasOwn(value, "appInfo")) return false;
  const appInfo = value.appInfo;
  // Native RPC stubs may be callable proxies rather than plain objects.
  return (
    appInfo != null &&
    typeof (appInfo as NativeLocaleServices["appInfo"]).getLocaleInfo === "function"
  );
}

interface NativeSettingsServices {
  settings: {
    read(key: "localeOverride"): Promise<unknown>;
    write(key: "localeOverride", value: CodexLocaleOverride): Promise<unknown>;
  };
}

function isNativeSettingsServices(value: unknown): value is NativeSettingsServices {
  // The transport root also synthesizes arbitrary callable paths. Only the
  // service registry owns settings; its settings stub itself may be callable.
  if (!isRecord(value) || !Object.hasOwn(value, "settings")) return false;
  const settings = value.settings as NativeSettingsServices["settings"] | null | undefined;
  return typeof settings?.read === "function" && typeof settings?.write === "function";
}

interface LocaleInfoResponse {
  ideLocale: string | undefined;
  systemLocale: string | undefined;
}

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

function parseLocaleOverride(response: unknown): string | null {
  if (!isRecord(response) || !Object.hasOwn(response, "effective")) {
    throw new Error("Codex native locale override response is malformed");
  }
  // Desktop uses effective, which includes native defaults and policy resolution.
  if (response.effective === null) return null;
  const locale = canonicalLocale(response.effective);
  if (!locale) throw new Error("Codex locale override is invalid");
  return locale;
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

function requestNativeLocale<T>(
  ownerWindow: Window,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  matchesServices: (value: unknown) => value is T,
  invoke: (services: T) => Promise<unknown>,
): Promise<unknown> {
  if (signal?.aborted) return Promise.reject(abortError());

  return new Promise((resolve, reject) => {
    let settled = false;
    let nativeRequest: (Promise<unknown> & Partial<Disposable>) | undefined;
    const settle = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      ownerWindow.clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      try {
        nativeRequest?.[Symbol.dispose]?.();
        operation();
      } catch (error) {
        reject(error);
      }
    };
    const onAbort = (): void => settle(() => reject(abortError()));
    const timer = ownerWindow.setTimeout(
      () => settle(() => reject(new Error("Codex locale request timed out"))),
      timeoutMs,
    );
    signal?.addEventListener("abort", onAbort, { once: true });
    void (async () => {
      const native = await loadCodexNativeServices(ownerWindow, matchesServices);
      if (settled) return;
      if (!native) throw new Error("Codex native locale services are unavailable");
      nativeRequest = invoke(native);
      const response = await nativeRequest;
      settle(() => resolve(response));
    })().catch((error: unknown) => settle(() => reject(error)));
  });
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
  await requestNativeLocale(
    ownerWindow,
    options.signal,
    timeoutMs,
    isNativeSettingsServices,
    (native) => native.settings.write("localeOverride", localeOverride),
  );
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
    requestNativeLocale(
      ownerWindow,
      options.signal,
      timeoutMs,
      isNativeSettingsServices,
      (native) => native.settings.read("localeOverride"),
    ).then(parseLocaleOverride),
    requestNativeLocale(ownerWindow, options.signal, timeoutMs, isNativeLocaleServices, (native) =>
      native.appInfo.getLocaleInfo(),
    ).then(parseLocaleInfo),
  ]);
  if (options.signal?.aborted) throw abortError();

  const navigatorLocale = firstNavigatorLocale(ownerWindow);
  const overrideKnown = overrideResult.status === "fulfilled";
  const localeOverride = overrideKnown ? overrideResult.value : undefined;
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
