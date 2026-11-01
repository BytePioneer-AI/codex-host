/** Strict Web Remote wire parsing owned by the Modern DSH transport. */

import { createHash } from "node:crypto";

import { sanitizeDiagnosticTail } from "@codexhost/harness-adapter";

export interface ModernRemoteFailure {
  readonly code: string;
  readonly message: string;
  readonly details: Record<string, unknown>;
}

export type ModernRemoteResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ModernRemoteFailure };

export type ModernRemoteStreamFrame =
  | { readonly type: "item"; readonly streamId: string; readonly value: unknown }
  | { readonly type: "error"; readonly streamId: string; readonly error: ModernRemoteFailure }
  | { readonly type: "end"; readonly streamId: string };

export const MODERN_REMOTE_MUX_PATH = "/api/remote.mux";

const ENDPOINT_SEGMENT = /^[A-Za-z0-9_$.-]+$/u;
const COOKIE_NAME = /^dsh-auth-[A-Za-z0-9_-]+$/u;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;
const BOOTSTRAP_TOKEN = /^[A-Za-z0-9_-]{43}$/u;
const COOKIE_SIGNATURE_BYTES = 32;
const COOKIE_PAYLOAD_VERSION = 1;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isFailure(value: unknown): value is ModernRemoteFailure {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["code", "message", "details"]) &&
    typeof value.code === "string" &&
    typeof value.message === "string" &&
    isRecord(value.details)
  );
}

function assertTypertEndpoint(endpoint: string): void {
  const parts = endpoint.split("/");
  if (
    parts.some(
      (part) => part === "" || part === "." || part === ".." || !ENDPOINT_SEGMENT.test(part),
    )
  ) {
    throw new TypeError("Invalid Modern DSH Remote endpoint");
  }
}

export function assertModernUnaryEndpoint(endpoint: string): void {
  if (endpoint === "$events") throw new TypeError("Invalid Modern DSH Remote endpoint");
  assertTypertEndpoint(endpoint);
}

export function assertModernStreamEndpoint(endpoint: string): void {
  if (endpoint === "$events") return;
  assertTypertEndpoint(endpoint);
}

export function parseLaunchUrl(line: string): URL {
  const match = /^dsh web: (\S+)$/u.exec(line);
  if (!match?.[1]) throw new TypeError("Modern DSH Web emitted an invalid readiness line");

  let url: URL;
  try {
    url = new URL(match[1]);
  } catch {
    throw new TypeError("Modern DSH Web emitted an invalid readiness URL");
  }
  const tokens = url.searchParams.getAll("token");
  const keys = [...url.searchParams.keys()];
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.port === "" ||
    url.port === "0" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.hash !== "" ||
    keys.length !== 1 ||
    keys[0] !== "token" ||
    tokens.length !== 1 ||
    !BOOTSTRAP_TOKEN.test(tokens[0] ?? "")
  ) {
    throw new TypeError("Modern DSH Web readiness URL is not an authenticated loopback root");
  }
  if (match[1] !== `${url.origin}/?token=${tokens[0]}`) {
    throw new TypeError("Modern DSH Web readiness URL is not canonical");
  }
  return url;
}

function cookieName(authority: string): string {
  return `dsh-auth-${createHash("sha256").update(authority).digest("base64url")}`;
}

function decodeBase64Url(value: string): Buffer {
  if (!BASE64URL.test(value)) {
    throw new TypeError("Modern DSH Web returned an invalid session cookie");
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) {
    throw new TypeError("Modern DSH Web returned an invalid session cookie");
  }
  return decoded;
}

function parseCookiePayload(
  value: string,
  authority: string,
): {
  readonly issuedAt: number;
  readonly expiresAt: number;
} {
  const parts = value.split(".");
  if (parts.length !== 3 || parts[0] !== "v1" || !parts[1] || !parts[2]) {
    throw new TypeError("Modern DSH Web returned an invalid session cookie");
  }
  const signature = decodeBase64Url(parts[2]);
  if (signature.byteLength !== COOKIE_SIGNATURE_BYTES) {
    throw new TypeError("Modern DSH Web returned an invalid session cookie");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(decodeBase64Url(parts[1])),
    );
  } catch {
    throw new TypeError("Modern DSH Web returned an invalid session cookie");
  }
  if (
    !isRecord(payload) ||
    !hasExactKeys(payload, ["version", "authority", "issuedAt", "expiresAt"]) ||
    payload.version !== COOKIE_PAYLOAD_VERSION ||
    payload.authority !== authority ||
    !Number.isSafeInteger(payload.issuedAt) ||
    !Number.isSafeInteger(payload.expiresAt) ||
    (payload.expiresAt as number) <= (payload.issuedAt as number)
  ) {
    throw new TypeError("Modern DSH Web returned an invalid session cookie");
  }
  return payload as { readonly issuedAt: number; readonly expiresAt: number };
}

export function parseSessionCookie(headers: Headers, authority: string): string {
  const all = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
  const values = all.length > 0 ? all : ([headers.get("set-cookie")].filter(Boolean) as string[]);
  if (values.length !== 1) {
    throw new TypeError("Modern DSH Web returned an invalid session cookie");
  }

  const sections = (values[0] as string).split(";").map((section) => section.trim());
  const pair = sections.shift();
  const separator = pair?.indexOf("=") ?? -1;
  if (!pair || separator <= 0)
    throw new TypeError("Modern DSH Web returned an invalid session cookie");
  const name = pair.slice(0, separator);
  const value = pair.slice(separator + 1);
  const payload = parseCookiePayload(value, authority);
  const attributes = new Map<string, string | true>();
  for (const section of sections) {
    const at = section.indexOf("=");
    const key = (at === -1 ? section : section.slice(0, at)).toLowerCase();
    if (key === "" || attributes.has(key)) {
      throw new TypeError("Modern DSH Web returned an invalid session cookie");
    }
    attributes.set(key, at === -1 ? true : section.slice(at + 1));
  }
  const expectedAttributes = ["expires", "httponly", "max-age", "path", "samesite"];
  const maxAge = Number(attributes.get("max-age"));
  const expires = String(attributes.get("expires"));
  const now = Date.now();
  if (
    !COOKIE_NAME.test(name) ||
    name !== cookieName(authority) ||
    attributes.size !== expectedAttributes.length ||
    expectedAttributes.some((attribute) => !attributes.has(attribute)) ||
    attributes.get("path") !== "/" ||
    attributes.get("httponly") !== true ||
    String(attributes.get("samesite")).toLowerCase() !== "strict" ||
    !/^[1-9]\d*$/u.test(String(attributes.get("max-age"))) ||
    !Number.isSafeInteger(maxAge) ||
    !Number.isSafeInteger(maxAge * 1_000) ||
    payload.expiresAt - payload.issuedAt !== maxAge * 1_000 ||
    !Number.isFinite(Date.parse(expires)) ||
    expires !== new Date(payload.expiresAt).toUTCString() ||
    payload.issuedAt > now ||
    payload.expiresAt <= now ||
    attributes.has("domain")
  ) {
    throw new TypeError("Modern DSH Web returned an invalid session cookie");
  }
  return `${name}=${value}`;
}

export function parseUnaryResponse<T>(value: unknown, rpcId: string): ModernRemoteResult<T> {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["type", "rpcId", "result"]) ||
    value.type !== "server-response" ||
    value.rpcId !== rpcId ||
    !isRecord(value.result)
  ) {
    throw new TypeError("Modern DSH Web returned an invalid server-response envelope");
  }
  const result = value.result;
  if (
    result.ok === true &&
    (hasExactKeys(result, ["ok"]) || hasExactKeys(result, ["ok", "value"]))
  ) {
    return { ok: true, value: result.value as T };
  }
  if (result.ok === false && hasExactKeys(result, ["ok", "error"]) && isFailure(result.error)) {
    return { ok: false, error: result.error };
  }
  throw new TypeError("Modern DSH Web returned an invalid Remote result");
}

export function parseStreamFrame(text: string): ModernRemoteStreamFrame {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new TypeError("Modern DSH Web emitted a non-JSON Remote stream frame");
  }
  if (!isRecord(value)) {
    throw new TypeError("Modern DSH Web emitted an invalid Remote stream frame");
  }
  if (
    value.type === "item" &&
    typeof value.streamId === "string" &&
    value.streamId !== "" &&
    (hasExactKeys(value, ["type", "streamId"]) ||
      hasExactKeys(value, ["type", "streamId", "value"]))
  ) {
    return { type: "item", streamId: value.streamId, value: value.value };
  }
  if (
    value.type === "error" &&
    typeof value.streamId === "string" &&
    value.streamId !== "" &&
    hasExactKeys(value, ["type", "streamId", "error"]) &&
    isFailure(value.error)
  ) {
    return { type: "error", streamId: value.streamId, error: value.error };
  }
  if (
    value.type === "end" &&
    typeof value.streamId === "string" &&
    value.streamId !== "" &&
    hasExactKeys(value, ["type", "streamId"])
  ) {
    return { type: "end", streamId: value.streamId };
  }
  throw new TypeError("Modern DSH Web emitted an invalid Remote stream frame");
}

export function redactModernCredential(value: string): string {
  return sanitizeDiagnosticTail(
    value
      .replace(/([?&]token=)[^\s&)]*/giu, "$1<redacted>")
      .replace(/(dsh-auth-[A-Za-z0-9_-]+=)v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gu, "$1<redacted>"),
  );
}

export function sanitizeModernRemoteFailure(failure: ModernRemoteFailure): ModernRemoteFailure {
  return {
    code: redactModernCredential(failure.code),
    message: redactModernCredential(failure.message),
    details: {},
  };
}
