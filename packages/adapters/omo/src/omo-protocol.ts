/**
 * Wire protocol for OmO's classic stdio RPC transport (`omo --mode rpc`).
 *
 * Records are JSON objects, one per line, with LF (0x0A) as the only delimiter.
 * `node:readline` is not compliant here: it also splits on U+2028 and U+2029,
 * which are valid unescaped inside JSON strings.
 *
 * Frames are additive. A record whose `type` is `"response"` answers a command;
 * every other string type is an event, and an event type this client does not
 * recognise must be ignored rather than treated as a fault.
 *
 * This module only owns framing and capability negotiation. Spawning, command
 * correlation, and process lifetime belong to omo-rpc-session.ts.
 */

/** Protocol version this adapter speaks. */
export const OMO_PROTOCOL_VERSION = 1;

/**
 * Oldest OmO build this adapter is tested against. The floor is an adapter
 * support boundary, not the upstream compatibility rule: OmO decides protocol
 * compatibility from `protocolVersion` plus advertised capabilities, and newer
 * builds (5.x, 6.x, later) pass this gate as long as they keep protocol 1.
 */
export const OMO_MINIMUM_SERVER_VERSION = "5.1.83";

/** Upstream caps one encoded JSONL record at 16 MiB. */
export const OMO_MAX_FRAME_BYTES = 16 * 1024 * 1024;

/**
 * Capabilities without which the classic P0 path cannot work. Protocol 1 needs
 * none; later modules probe optional commands through hasCapability() instead.
 */
export const OMO_REQUIRED_CAPABILITIES: readonly string[] = Object.freeze([]);

/** Command frame written to the engine's stdin. `id` correlates the response. */
export interface OmoRequestFrame {
  readonly id: string;
  readonly type: string;
  readonly [key: string]: unknown;
}

/**
 * Response frame. Unknown fields are preserved: the protocol is additive, and
 * later revisions may attach metadata (for example `errorData`) to a response.
 */
export interface OmoResponseFrame {
  readonly type: "response";
  readonly id: string;
  readonly success: boolean;
  readonly error?: string;
  readonly errorCode?: string;
  readonly command?: string;
  readonly data?: unknown;
  readonly [key: string]: unknown;
}

/** Event frame. The set of event types is open-ended, so unknown types are data. */
export interface OmoEventFrame {
  readonly type: string;
  readonly [key: string]: unknown;
}

export type OmoFrame = OmoResponseFrame | OmoEventFrame;

export function isOmoResponseFrame(frame: OmoFrame): frame is OmoResponseFrame {
  return frame.type === "response";
}

export type OmoProtocolErrorKind =
  | "invalid_frame"
  | "invalid_json"
  | "invalid_encoding"
  | "truncated_frame"
  | "frame_too_large"
  | "framing_failed"
  | "invalid_protocol_info"
  | "incompatible_protocol"
  | "incompatible_server_version"
  | "missing_capability";

/** Typed wire-protocol failure. Callers match on `kind`, never on the message. */
export class OmoProtocolError extends Error {
  readonly kind: OmoProtocolErrorKind;

  constructor(kind: OmoProtocolErrorKind, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "OmoProtocolError";
    this.kind = kind;
  }
}

const textDecoder = new TextDecoder("utf-8", { fatal: true });
const semverPattern = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u;
const minimumSemver = requireSemver(OMO_MINIMUM_SERVER_VERSION);

/**
 * Incremental JSONL framer for engine stdout.
 *
 * Chunks may split a frame anywhere, including inside a multi-byte character.
 * Bytes are buffered until LF, then decoded and parsed as one frame, so a split
 * never corrupts UTF-8. Empty lines (including CRLF terminators) are skipped;
 * anything else that is not a JSON object fails with a typed error.
 */
export class OmoJsonlFramer {
  readonly #chunks: Buffer[] = [];
  #pendingBytes = 0;
  #failed = false;
  #failure: OmoProtocolError | null = null;

  /**
   * The failure that made this framer unusable, or null while it is healthy.
   * A chunk that completes frames and then fails keeps those frames in
   * {@link push}'s return value; the failure is recorded here so the caller can
   * deliver them before ending the stream, and the next call throws.
   */
  get failure(): OmoProtocolError | null {
    return this.#failure;
  }

  /** Buffers one chunk and returns every frame completed by it, in order. */
  push(chunk: Uint8Array): OmoFrame[] {
    if (this.#failed) {
      throw new OmoProtocolError("framing_failed", "OmO RPC framing already failed");
    }
    const frames: OmoFrame[] = [];
    try {
      const bytes = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      let offset = 0;
      while (offset < bytes.length) {
        const newline = bytes.indexOf(0x0a, offset);
        const end = newline === -1 ? bytes.length : newline;
        if (end > offset) {
          this.#chunks.push(bytes.subarray(offset, end));
          this.#pendingBytes += end - offset;
          if (this.#pendingBytes > OMO_MAX_FRAME_BYTES) {
            throw new OmoProtocolError(
              "frame_too_large",
              `OmO RPC frame exceeds the ${OMO_MAX_FRAME_BYTES}-byte limit`,
            );
          }
        }
        if (newline === -1) break;
        const frame = this.#takeFrame();
        if (frame) frames.push(frame);
        offset = newline + 1;
      }
      return frames;
    } catch (error) {
      const failure =
        error instanceof OmoProtocolError
          ? error
          : new OmoProtocolError("framing_failed", "OmO RPC framing failed", { cause: error });
      this.#failed = true;
      this.#failure = failure;
      this.#chunks.length = 0;
      this.#pendingBytes = 0;
      // Frames this chunk already completed stay valid and are delivered before
      // the failure; a chunk that completed none throws so nothing goes silent.
      if (frames.length === 0) throw failure;
      return frames;
    }
  }

  /**
   * Signals the end of the stream. A non-empty remainder means the peer closed
   * in the middle of a frame; that is a protocol error, not a partial value.
   */
  finish(): OmoFrame[] {
    if (this.#failed) {
      throw new OmoProtocolError("framing_failed", "OmO RPC framing already failed");
    }
    if (this.#pendingBytes === 0) return [];
    const pending = this.#pendingBytes;
    this.#failed = true;
    this.#chunks.length = 0;
    this.#pendingBytes = 0;
    throw new OmoProtocolError(
      "truncated_frame",
      `OmO RPC stream ended with ${pending} bytes of an incomplete frame`,
    );
  }

  #takeFrame(): OmoFrame | undefined {
    const pending = this.#pendingBytes;
    if (pending === 0) return undefined;
    const chunks = this.#chunks.splice(0, this.#chunks.length);
    this.#pendingBytes = 0;
    const [first] = chunks;
    let bytes = chunks.length === 1 && first !== undefined ? first : Buffer.concat(chunks, pending);
    if (bytes.length > 0 && bytes[bytes.length - 1] === 0x0d) {
      bytes = bytes.subarray(0, bytes.length - 1);
    }
    if (bytes.length === 0) return undefined;

    let text: string;
    try {
      text = textDecoder.decode(bytes);
    } catch (error) {
      throw new OmoProtocolError("invalid_encoding", "OmO RPC frame is not valid UTF-8", {
        cause: error,
      });
    }

    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (error) {
      throw new OmoProtocolError("invalid_json", "OmO RPC frame is not valid JSON", {
        cause: error,
      });
    }
    return parseOmoFrame(value);
  }
}

/** Validates one decoded JSON value as a response or an additive event frame. */
export function parseOmoFrame(value: unknown): OmoFrame {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new OmoProtocolError(
      "invalid_frame",
      "OmO RPC frame must be a JSON object with a string type",
    );
  }
  if (value.type !== "response") {
    return value as OmoEventFrame;
  }
  if (typeof value.id !== "string" || typeof value.success !== "boolean") {
    throw new OmoProtocolError(
      "invalid_frame",
      "OmO RPC response requires a string id and a boolean success",
    );
  }
  for (const field of ["error", "errorCode", "command"] as const) {
    if (field in value && typeof value[field] !== "string") {
      throw new OmoProtocolError(
        "invalid_frame",
        `OmO RPC response field '${field}' must be a string`,
      );
    }
  }
  return { ...value, type: "response" } as OmoResponseFrame;
}

/** Typed view of a `get_protocol_info` answer. */
export interface OmoProtocolInfo {
  readonly protocolVersion: number;
  readonly serverVersion: string;
  readonly capabilities: readonly string[];
  /** Normalised from top-level `dynamic_versions` or `method_classes.dynamic_versions`. */
  readonly dynamicVersions: Readonly<Record<string, number>>;
  readonly engineOrdinal?: readonly number[];
  readonly mode?: string;
  hasCapability(name: string): boolean;
}

/**
 * Parses and validates the `data` object of a successful `get_protocol_info`
 * response. Unknown fields are ignored so an additive engine still negotiates.
 */
export function parseOmoProtocolInfo(value: unknown): OmoProtocolInfo {
  if (!isRecord(value)) {
    throw new OmoProtocolError(
      "invalid_protocol_info",
      "get_protocol_info data must be a JSON object",
    );
  }

  const { protocolVersion, serverVersion, capabilities } = value;
  if (
    typeof protocolVersion !== "number" ||
    !Number.isSafeInteger(protocolVersion) ||
    protocolVersion < 1
  ) {
    throw new OmoProtocolError(
      "invalid_protocol_info",
      "get_protocol_info protocolVersion must be a positive integer",
    );
  }
  if (typeof serverVersion !== "string" || serverVersion.trim().length === 0) {
    throw new OmoProtocolError(
      "invalid_protocol_info",
      "get_protocol_info serverVersion must be a non-empty string",
    );
  }
  if (!Array.isArray(capabilities) || capabilities.some((entry) => typeof entry !== "string")) {
    throw new OmoProtocolError(
      "invalid_protocol_info",
      "get_protocol_info capabilities must be an array of strings",
    );
  }

  const advertised = [...capabilities];
  const dynamicVersions = readDynamicVersions(value);
  const engineOrdinal = readNumericArray(value.engineOrdinal, "engineOrdinal");
  const mode = readOptionalString(value.mode, "mode");

  return {
    protocolVersion,
    serverVersion,
    capabilities: Object.freeze(advertised),
    dynamicVersions: Object.freeze(dynamicVersions),
    ...(engineOrdinal === undefined ? {} : { engineOrdinal: Object.freeze(engineOrdinal) }),
    ...(mode === undefined ? {} : { mode }),
    hasCapability: (name: string) => advertised.includes(name),
  };
}

/**
 * Throws a typed error unless the engine speaks protocol 1, advertises every
 * required capability, and reports at least the tested minimum server version.
 * Newer versions pass: the version check is a floor, never an upper bound.
 */
export function assertCompatible(
  info: OmoProtocolInfo,
  requiredCapabilities: readonly string[] = OMO_REQUIRED_CAPABILITIES,
): void {
  if (info.protocolVersion !== OMO_PROTOCOL_VERSION) {
    throw new OmoProtocolError(
      "incompatible_protocol",
      `OmO RPC protocol version ${info.protocolVersion} is not supported (expected ${OMO_PROTOCOL_VERSION})`,
    );
  }

  const actual = parseSemver(info.serverVersion);
  if (!actual) {
    throw new OmoProtocolError(
      "incompatible_server_version",
      `OmO serverVersion '${info.serverVersion}' is not a semantic version`,
    );
  }
  if (compareSemver(actual, minimumSemver) < 0) {
    throw new OmoProtocolError(
      "incompatible_server_version",
      `OmO serverVersion ${info.serverVersion} is older than the supported minimum ${OMO_MINIMUM_SERVER_VERSION}`,
    );
  }

  const missing = requiredCapabilities.filter((name) => !info.hasCapability(name));
  if (missing.length > 0) {
    throw new OmoProtocolError(
      "missing_capability",
      `OmO engine is missing required capabilities: ${missing.join(", ")}`,
    );
  }
}

interface ParsedSemver {
  readonly core: readonly [number, number, number];
  readonly prerelease: readonly string[];
}

function parseSemver(version: string): ParsedSemver | undefined {
  const match = semverPattern.exec(version.trim());
  if (!match) return undefined;
  const core: [number, number, number] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (!core.every((part) => Number.isSafeInteger(part))) return undefined;
  const prerelease = match[4] === undefined ? [] : match[4].split(".");
  return { core, prerelease };
}

function requireSemver(version: string): ParsedSemver {
  const parsed = parseSemver(version);
  if (!parsed) {
    throw new OmoProtocolError(
      "incompatible_server_version",
      `Configured minimum server version '${version}' is not a semantic version`,
    );
  }
  return parsed;
}

function compareSemver(left: ParsedSemver, right: ParsedSemver): number {
  if (left.core[0] !== right.core[0]) return left.core[0] > right.core[0] ? 1 : -1;
  if (left.core[1] !== right.core[1]) return left.core[1] > right.core[1] ? 1 : -1;
  if (left.core[2] !== right.core[2]) return left.core[2] > right.core[2] ? 1 : -1;
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    if (left.prerelease.length === right.prerelease.length) return 0;
    return left.prerelease.length === 0 ? 1 : -1;
  }
  const shared = Math.min(left.prerelease.length, right.prerelease.length);
  for (const [index, leftPart] of left.prerelease.entries()) {
    const rightPart = right.prerelease[index];
    if (index >= shared || rightPart === undefined) break;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/u.test(leftPart);
    const rightNumeric = /^\d+$/u.test(rightPart);
    if (leftNumeric && rightNumeric) return Number(leftPart) > Number(rightPart) ? 1 : -1;
    if (leftNumeric) return -1;
    if (rightNumeric) return 1;
    return leftPart > rightPart ? 1 : -1;
  }
  if (left.prerelease.length === right.prerelease.length) return 0;
  return left.prerelease.length > right.prerelease.length ? 1 : -1;
}

function readDynamicVersions(value: Record<string, unknown>): Record<string, number> {
  let source = value.dynamic_versions;
  if (source === undefined && isRecord(value.method_classes)) {
    source = value.method_classes.dynamic_versions;
  }
  if (source === undefined) return {};
  if (!isRecord(source)) {
    throw new OmoProtocolError(
      "invalid_protocol_info",
      "get_protocol_info dynamic_versions must be a JSON object",
    );
  }
  const versions: Record<string, number> = {};
  for (const [name, version] of Object.entries(source)) {
    // Additive metadata: keep numeric versions and ignore values a later
    // revision may attach to the same map.
    if (typeof version === "number" && Number.isFinite(version)) versions[name] = version;
  }
  return versions;
}

function readNumericArray(value: unknown, field: string): number[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((entry) => typeof entry !== "number" || !Number.isFinite(entry))
  ) {
    throw new OmoProtocolError(
      "invalid_protocol_info",
      `get_protocol_info ${field} must be a non-empty array of numbers`,
    );
  }
  return [...value];
}

function readOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new OmoProtocolError(
      "invalid_protocol_info",
      `get_protocol_info ${field} must be a string`,
    );
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
