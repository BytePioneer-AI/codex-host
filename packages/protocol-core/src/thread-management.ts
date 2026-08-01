import { createHash } from "node:crypto";

import type { JsonObject, JsonRpcRequest, JsonValue } from "@codexhost/shared-contracts";

const HOST_CURSOR_PREFIX = "codexhost:thread-list:v1:";
const MAX_CURSOR_LENGTH = 65_536;
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
const UINT32_MAX = 4_294_967_295;

const THREAD_LIST_FIELDS = new Set([
  "ancestorThreadId",
  "archived",
  "cursor",
  "cwd",
  "isPinned",
  "limit",
  "modelProviders",
  "parentThreadId",
  "searchTerm",
  "sortDirection",
  "sortKey",
  "sourceKinds",
  "useStateDbOnly",
]);

const THREAD_SOURCE_KINDS = new Set([
  "cli",
  "vscode",
  "exec",
  "appServer",
  "subAgent",
  "subAgentReview",
  "subAgentCompact",
  "subAgentThreadSpawn",
  "subAgentOther",
  "unknown",
]);

export type ThreadListSortDirection = "asc" | "desc";
export type ThreadListSortKey = "created_at" | "updated_at" | "recency_at";

export interface ThreadListExternalAnchor {
  timestamp: number;
  threadId: string;
}

export interface HostThreadListCursor {
  queryFingerprint: string;
  sortDirection: ThreadListSortDirection;
  officialCursor: string | null;
  officialDone: boolean;
  externalAnchor: ThreadListExternalAnchor | null;
  externalDone: boolean;
}

export interface DecodedThreadListRequest {
  params: JsonObject;
  archived: boolean;
  cwd: string[] | null;
  isPinned: boolean | null;
  limit: number;
  modelProviders: string[] | null;
  parentThreadId: string | null;
  ancestorThreadId: string | null;
  searchTerm: string | null;
  sortDirection: ThreadListSortDirection;
  sortKey: ThreadListSortKey;
  sourceKinds: string[] | null;
  useStateDbOnly: boolean;
  queryFingerprint: string;
  cursor: HostThreadListCursor | null;
  supportsExternal: boolean;
}

export interface DecodedThreadManagementRequest {
  threadId: string;
}

export interface DecodedThreadMetadataUpdateRequest extends DecodedThreadManagementRequest {
  isPinned?: boolean | null;
  gitInfo?: {
    branch?: string | null;
    originUrl?: string | null;
    sha?: string | null;
  } | null;
}

export interface OfficialThreadListPage {
  data: JsonObject[];
  nextCursor: string | null;
  backwardsCursor: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function paramsObject(request: JsonRpcRequest, method: string): Record<string, unknown> {
  if (request.params === undefined && method === "thread/list") return {};
  if (!isRecord(request.params)) throw new Error(`${method} params must be an object`);
  return request.params;
}

function nullableText(value: unknown, name: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new Error(`${name} must be text or null`);
  return value;
}

function nullableBoolean(value: unknown, name: string): boolean | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "boolean") throw new Error(`${name} must be boolean or null`);
  return value;
}

function nullableTextArray(value: unknown, name: string): string[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${name} must be a text array or null`);
  }
  return [...value] as string[];
}

function decodeCwd(value: unknown): string[] | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return [value];
  return nullableTextArray(value, "thread/list params.cwd");
}

function decodeLimit(value: unknown): number {
  if (value === undefined || value === null) return DEFAULT_PAGE_SIZE;
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > UINT32_MAX) {
    throw new Error("thread/list params.limit must be a uint32 or null");
  }
  return Math.min(value as number, MAX_PAGE_SIZE);
}

function decodeSortDirection(value: unknown): ThreadListSortDirection {
  if (value === undefined || value === null) return "desc";
  if (value !== "asc" && value !== "desc") {
    throw new Error("thread/list params.sortDirection must be 'asc', 'desc', or null");
  }
  return value;
}

function decodeSortKey(value: unknown): ThreadListSortKey {
  if (value === undefined || value === null) return "created_at";
  if (value !== "created_at" && value !== "updated_at" && value !== "recency_at") {
    throw new Error("thread/list params.sortKey is unsupported");
  }
  return value;
}

function queryFingerprint(value: JsonObject): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function cursorPayload(value: HostThreadListCursor): JsonObject {
  return {
    formatVersion: 1,
    queryFingerprint: value.queryFingerprint,
    sortDirection: value.sortDirection,
    officialCursor: value.officialCursor,
    officialDone: value.officialDone,
    externalAnchor: value.externalAnchor
      ? { timestamp: value.externalAnchor.timestamp, threadId: value.externalAnchor.threadId }
      : null,
    externalDone: value.externalDone,
  };
}

function parseCursorPayload(value: unknown): HostThreadListCursor {
  if (!isRecord(value) || value.formatVersion !== 1) throw new Error("Host cursor is invalid");
  const { queryFingerprint: fingerprint, sortDirection, officialCursor, officialDone } = value;
  const { externalAnchor, externalDone } = value;
  if (
    typeof fingerprint !== "string" ||
    !/^[a-f0-9]{64}$/u.test(fingerprint) ||
    (sortDirection !== "asc" && sortDirection !== "desc") ||
    (officialCursor !== null && typeof officialCursor !== "string") ||
    typeof officialDone !== "boolean" ||
    typeof externalDone !== "boolean"
  ) {
    throw new Error("Host cursor is invalid");
  }
  let anchor: ThreadListExternalAnchor | null = null;
  if (externalAnchor !== null) {
    if (
      !isRecord(externalAnchor) ||
      !Number.isSafeInteger(externalAnchor.timestamp) ||
      typeof externalAnchor.threadId !== "string" ||
      externalAnchor.threadId.length === 0
    ) {
      throw new Error("Host cursor is invalid");
    }
    anchor = {
      timestamp: externalAnchor.timestamp as number,
      threadId: externalAnchor.threadId,
    };
  }
  return {
    queryFingerprint: fingerprint,
    sortDirection,
    officialCursor: officialCursor as string | null,
    officialDone,
    externalAnchor: anchor,
    externalDone,
  };
}

export function encodeHostThreadListCursor(value: HostThreadListCursor): string {
  const parsed = parseCursorPayload(cursorPayload(value));
  return `${HOST_CURSOR_PREFIX}${Buffer.from(JSON.stringify(cursorPayload(parsed))).toString(
    "base64url",
  )}`;
}

export function decodeHostThreadListCursor(
  value: string,
  expected: { queryFingerprint: string; sortDirection: ThreadListSortDirection },
): HostThreadListCursor {
  if (value.length > MAX_CURSOR_LENGTH || !value.startsWith(HOST_CURSOR_PREFIX)) {
    throw new Error("thread/list cursor is not a codexhost cursor");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(
      Buffer.from(value.slice(HOST_CURSOR_PREFIX.length), "base64url").toString("utf8"),
    );
  } catch {
    throw new Error("thread/list cursor is invalid");
  }
  const cursor = parseCursorPayload(decoded);
  if (
    cursor.queryFingerprint !== expected.queryFingerprint ||
    cursor.sortDirection !== expected.sortDirection
  ) {
    throw new Error("thread/list cursor does not match the current query");
  }
  return cursor;
}

export function decodeThreadListRequest(request: JsonRpcRequest): DecodedThreadListRequest | null {
  if (request.method !== "thread/list") return null;
  const params = paramsObject(request, request.method);
  const archived = nullableBoolean(params.archived, "thread/list params.archived") ?? false;
  const cwd = decodeCwd(params.cwd);
  const isPinned = nullableBoolean(params.isPinned, "thread/list params.isPinned");
  const modelProviders = nullableTextArray(
    params.modelProviders,
    "thread/list params.modelProviders",
  );
  const parentThreadId = nullableText(params.parentThreadId, "thread/list params.parentThreadId");
  const ancestorThreadId = nullableText(
    params.ancestorThreadId,
    "thread/list params.ancestorThreadId",
  );
  if (parentThreadId !== null && ancestorThreadId !== null) {
    throw new Error("thread/list cannot combine parentThreadId and ancestorThreadId");
  }
  const searchTerm = nullableText(params.searchTerm, "thread/list params.searchTerm");
  const sortDirection = decodeSortDirection(params.sortDirection);
  const sortKey = decodeSortKey(params.sortKey);
  const sourceKinds = nullableTextArray(params.sourceKinds, "thread/list params.sourceKinds");
  if (sourceKinds?.some((kind) => !THREAD_SOURCE_KINDS.has(kind))) {
    throw new Error("thread/list params.sourceKinds contains an unsupported value");
  }
  if (params.useStateDbOnly !== undefined && typeof params.useStateDbOnly !== "boolean") {
    throw new Error("thread/list params.useStateDbOnly must be boolean");
  }
  const fingerprint = queryFingerprint({
    ancestorThreadId,
    archived,
    cwd,
    isPinned,
    modelProviders,
    parentThreadId,
    searchTerm,
    sortKey,
    sourceKinds,
    useStateDbOnly: params.useStateDbOnly === true,
  });
  const cursorText = nullableText(params.cursor, "thread/list params.cursor");
  const hasUnknownFields = Object.keys(params).some((name) => !THREAD_LIST_FIELDS.has(name));
  const isHostCursor = cursorText?.startsWith(HOST_CURSOR_PREFIX) === true;
  const supportsExternal = !hasUnknownFields && (cursorText === null || isHostCursor);
  const cursor =
    supportsExternal && cursorText
      ? decodeHostThreadListCursor(cursorText, {
          queryFingerprint: fingerprint,
          sortDirection,
        })
      : null;
  return {
    params: { ...(params as JsonObject) },
    archived,
    cwd,
    isPinned,
    limit: decodeLimit(params.limit),
    modelProviders,
    parentThreadId,
    ancestorThreadId,
    searchTerm,
    sortDirection,
    sortKey,
    sourceKinds,
    useStateDbOnly: params.useStateDbOnly === true,
    queryFingerprint: fingerprint,
    cursor,
    supportsExternal,
  };
}

export function decodeThreadArchiveRequest(
  request: JsonRpcRequest,
): DecodedThreadManagementRequest | null {
  if (request.method !== "thread/archive" && request.method !== "thread/unarchive") return null;
  const params = paramsObject(request, request.method);
  if (typeof params.threadId !== "string" || params.threadId.length === 0) {
    throw new Error(`${request.method} params.threadId must be non-empty text`);
  }
  return { threadId: params.threadId };
}

export function decodeThreadMetadataUpdateRequest(
  request: JsonRpcRequest,
): DecodedThreadMetadataUpdateRequest | null {
  if (request.method !== "thread/metadata/update") return null;
  const params = paramsObject(request, request.method);
  if (typeof params.threadId !== "string" || params.threadId.length === 0) {
    throw new Error("thread/metadata/update params.threadId must be non-empty text");
  }
  const isPinned = nullableBoolean(params.isPinned, "thread/metadata/update params.isPinned");
  let gitInfo: DecodedThreadMetadataUpdateRequest["gitInfo"];
  if (params.gitInfo === null) {
    gitInfo = null;
  } else if (params.gitInfo !== undefined) {
    if (!isRecord(params.gitInfo)) {
      throw new Error("thread/metadata/update params.gitInfo must be an object or null");
    }
    gitInfo = {};
    for (const name of ["branch", "originUrl", "sha"] as const) {
      const value = params.gitInfo[name];
      if (value !== undefined && value !== null && typeof value !== "string") {
        throw new Error(`thread/metadata/update params.gitInfo.${name} must be text or null`);
      }
      if (value !== undefined) gitInfo[name] = value as string | null;
    }
  }
  const decoded: DecodedThreadMetadataUpdateRequest = { threadId: params.threadId };
  if (params.isPinned !== undefined) decoded.isPinned = isPinned;
  if (params.gitInfo !== undefined) decoded.gitInfo = gitInfo ?? null;
  return decoded;
}

function optionalCursor(value: unknown, name: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new Error(`Official thread/list ${name} is invalid`);
  return value;
}

export function decodeOfficialThreadListPage(value: JsonValue): OfficialThreadListPage {
  if (!isRecord(value) || !Array.isArray(value.data) || value.data.some((row) => !isRecord(row))) {
    throw new Error("Official thread/list response is invalid");
  }
  return {
    data: value.data.map((row) => ({ ...(row as JsonObject) })),
    nextCursor: optionalCursor(value.nextCursor, "nextCursor"),
    backwardsCursor: optionalCursor(value.backwardsCursor, "backwardsCursor"),
  };
}
