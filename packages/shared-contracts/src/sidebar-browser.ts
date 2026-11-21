/**
 * Sidebar browser stream: a tab belongs to a browser on the CodexHost machine, and viewers receive
 * its pixels and send input over one authenticated WebSocket. `localhost` in such a tab is that
 * machine, and the stream needs no origin beyond the one serving CodexHost.
 *
 * Kept free of runtime dependencies and exported as `@codexhost/shared-contracts/sidebar-browser`
 * so the browser bundle does not inline the full contract package.
 */
export const SIDEBAR_BROWSER_PATH = "/api/sidebar-browser";
/** Query parameter naming the tab a connection attaches to. */
export const SIDEBAR_BROWSER_TAB_PARAM = "tab";
export const SIDEBAR_BROWSER_MAX_URL_LENGTH = 16 * 1024;
const MAX_TAB_KEY_LENGTH = 256;
const MAX_TEXT_LENGTH = 64 * 1024;
const MAX_VIEWPORT = 4096;

export const SIDEBAR_BROWSER_STUN_URLS = [
  "stun:stun.douyucdn.cn:18000",
  "stun:stun.hitv.com:3478",
  "stun:stun.chat.bilibili.com:3478",
  "stun:stun.miwifi.com:3478",
  "stun:global.stun.twilio.com:3478",
  "stun:stun.cloudflare.com:3478",
] as const;

export const SIDEBAR_BROWSER_DIRECT_CONTROL = "control";
export const SIDEBAR_BROWSER_DIRECT_PING = "ping";
export const SIDEBAR_BROWSER_DIRECT_TIMEOUT_MS = 10_000;
export const SIDEBAR_BROWSER_DIRECT_HEARTBEAT_MS = 1_000;
export const SIDEBAR_BROWSER_DIRECT_IDLE_MS = 3_000;
export const SIDEBAR_BROWSER_DIRECT_MESSAGE_BYTES = 16 * 1024;
export const SIDEBAR_BROWSER_DIRECT_FRAME_BYTES = 64 * 1024 * 1024;
export const SIDEBAR_BROWSER_DIRECT_FRAGMENT_HEADER_BYTES = 20;

export function sidebarBrowserFramesChannel(tab: string): string {
  return `frames:${tab}`;
}

export interface SidebarBrowserDirectCandidate {
  readonly candidate: string;
  readonly sdpMid?: string | null;
  readonly sdpMLineIndex?: number | null;
  readonly usernameFragment?: string | null;
}

/** Known client close reasons allowed in service logs. The wire remains tolerant of other values. */
export const SIDEBAR_BROWSER_DIRECT_CANCEL_REASONS: readonly string[] = [
  "background",
  "network-changed",
  "signaling-closed",
];
export const SIDEBAR_BROWSER_DIRECT_CLIENT_FAILURE_REASONS: readonly string[] = [
  "candidate-error",
  "connection-lost",
  "control-close",
  "control-error",
  "control-send",
  "frame-decode",
  "frame-fragment",
  "frame-sequence",
  "frame-window",
  "frame-ack",
  "frames-close",
  "frames-error",
  "frames-fallback",
  "frames-open",
  "heartbeat-timeout",
  "offer-error",
  "ready-timeout",
  "signaling-error",
];

type DirectSignal =
  | {
      readonly type: "direct-candidate";
      readonly attempt: number;
      readonly candidate: SidebarBrowserDirectCandidate | null;
    }
  | { readonly type: "direct-close"; readonly attempt: number; readonly reason: string };

export type SidebarBrowserDirectClientMessage =
  | DirectSignal
  | {
      readonly type: "direct-offer";
      readonly attempt: number;
      readonly sdp: string;
      readonly restart: boolean;
    }
  | { readonly type: "direct-skipped"; readonly reason: string };

export type SidebarBrowserDirectServerMessage =
  | DirectSignal
  | {
      readonly type: "direct-hello";
      readonly peer: string;
      readonly target: string;
      readonly boot: string;
      readonly iceServers: readonly string[];
      readonly offered: boolean;
    }
  | { readonly type: "direct-answer"; readonly attempt: number; readonly sdp: string }
  | { readonly type: "direct-ready"; readonly attempt: number };

export interface SidebarBrowserAck {
  readonly type: "ack";
  readonly sequence: number;
}

export interface SidebarBrowserDirectFragment {
  readonly attempt: number;
  readonly sequence: number;
  readonly offset: number;
  readonly total: number;
  readonly payload: Uint8Array;
}

export type SidebarBrowserMouseButton = "none" | "left" | "middle" | "right";

export type SidebarBrowserClientMessage =
  /** CSS size of the viewer's drawing area. */
  | { readonly type: "viewport"; readonly width: number; readonly height: number }
  /** Frames are sent only while some viewer is visible. */
  | { readonly type: "visible"; readonly visible: boolean }
  | { readonly type: "navigate"; readonly url: string }
  | { readonly type: "back" | "forward" | "reload" }
  | {
      readonly type: "mouse";
      readonly action: "down" | "up" | "move";
      readonly x: number;
      readonly y: number;
      readonly button: SidebarBrowserMouseButton;
      readonly clickCount: number;
    }
  | {
      readonly type: "wheel";
      readonly x: number;
      readonly y: number;
      readonly deltaX: number;
      readonly deltaY: number;
    }
  /**
   * Keys that do not insert text (Enter, arrows, modifiers, shortcuts); text arrives as `text`.
   * The viewer's shortcut modifier is sent as `ControlOrMeta`, which the CodexHost machine maps
   * to its own (Command on macOS), and modifiers held by key events apply to mouse input.
   */
  | {
      readonly type: "key";
      readonly action: "down" | "up";
      readonly key: string;
      readonly code: string;
    }
  /** Committed text, including IME composition results and paste. */
  | { readonly type: "text"; readonly text: string }
  /** The latest presented frame; also acknowledges every earlier frame on this connection. */
  | SidebarBrowserAck
  /** Bind to a ready direct peer, or omit peer to return to the WebSocket. */
  | { readonly type: "transport"; readonly binding: number; readonly peer?: string };

export interface SidebarBrowserState {
  readonly type: "state";
  /** Undefined until the tab has been navigated. */
  readonly url: string | undefined;
  readonly title: string;
  readonly loading: boolean;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  /** Main-frame navigation failure or an unavailable browser. */
  readonly error: string | undefined;
}

/** Editable hit area in the streamed page's CSS viewport; never includes field values. */
export interface SidebarBrowserEditableRegion {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export type SidebarBrowserServerMessage =
  | SidebarBrowserState
  /** Replaces the touch hit areas; applies only to frames of this viewport/geometry generation. */
  | {
      readonly type: "editable";
      readonly generation: number;
      readonly regions: readonly SidebarBrowserEditableRegion[];
    }
  /** The page opened a window; the viewer opens it as another tab. */
  | { readonly type: "open"; readonly url: string }
  | SidebarBrowserTransport;

export type SidebarBrowserTransport =
  | { readonly type: "transport"; readonly binding: number; readonly via: "socket" }
  | {
      readonly type: "transport";
      readonly binding: number;
      readonly via: "direct";
      readonly from: number;
    };

export type SidebarBrowserFrameFormat = "jpeg" | "png";

/** Binary frame: format byte, CSS size (two uint16s), sequence (float64), generation (uint32), then image. */
export interface SidebarBrowserFrameHeader {
  readonly format: SidebarBrowserFrameFormat;
  readonly width: number;
  readonly height: number;
  readonly sequence: number;
  readonly generation: number;
}
export const SIDEBAR_BROWSER_FRAME_HEADER_BYTES = 17;

export function encodeSidebarBrowserFrameHeader(header: SidebarBrowserFrameHeader): Uint8Array {
  const bytes = new Uint8Array(SIDEBAR_BROWSER_FRAME_HEADER_BYTES);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, header.format === "png" ? 1 : 0);
  view.setUint16(1, header.width);
  view.setUint16(3, header.height);
  view.setFloat64(5, header.sequence);
  view.setUint32(13, header.generation);
  return bytes;
}

export function decodeSidebarBrowserFrameHeader(bytes: ArrayBuffer): SidebarBrowserFrameHeader {
  const view = new DataView(bytes, 0, SIDEBAR_BROWSER_FRAME_HEADER_BYTES);
  return {
    format: view.getUint8(0) === 1 ? "png" : "jpeg",
    width: view.getUint16(1),
    height: view.getUint16(3),
    sequence: view.getFloat64(5),
    generation: view.getUint32(13),
  };
}

/** @returns whether the value can address one tab's page on the server. */
export function isSidebarBrowserTabKey(value: string | null): value is string {
  return value !== null && value.length <= MAX_TAB_KEY_LENGTH && /^[\w:.-]+$/u.test(value);
}

const finite = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
const text = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length <= max;
const integer = (value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): value is number =>
  finite(value, min, max) && Number.isInteger(value);
const directId = (value: unknown): value is string => text(value, 128) && /^[\w-]+$/u.test(value);
const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

export function isSidebarBrowserStunUrl(value: unknown): value is string {
  return (
    typeof value === "string" && /^stun:(?:[a-z\d.-]+|\[[a-f\d:.]+\])(?::\d{1,5})?$/iu.test(value)
  );
}

function parseDirectSignal(
  message: Record<string, unknown>,
  attempt: number,
): DirectSignal | undefined {
  if (message.type === "direct-close" && directId(message.reason))
    return { type: message.type, attempt, reason: message.reason };
  if (message.type !== "direct-candidate") return undefined;
  if (message.candidate === null) return { type: message.type, attempt, candidate: null };
  const candidate = record(message.candidate);
  if (!candidate) return undefined;
  const { candidate: line, sdpMid, sdpMLineIndex, usernameFragment } = candidate;
  const optionalText = (value: unknown): value is string | null | undefined =>
    value == null || text(value, 256);
  if (
    !text(line, 4096) ||
    !line.startsWith("candidate:") ||
    /[\r\n]/u.test(line) ||
    !optionalText(sdpMid) ||
    !optionalText(usernameFragment) ||
    (sdpMLineIndex != null && !integer(sdpMLineIndex, 0, 65535))
  )
    return undefined;
  return {
    type: message.type,
    attempt,
    candidate: {
      candidate: line,
      ...(sdpMid === undefined ? {} : { sdpMid }),
      ...(sdpMLineIndex === undefined ? {} : { sdpMLineIndex }),
      ...(usernameFragment === undefined ? {} : { usernameFragment }),
    },
  };
}

export function parseSidebarBrowserDirectClientMessage(
  value: unknown,
): SidebarBrowserDirectClientMessage | undefined {
  const message = record(value);
  if (!message) return undefined;
  if (message.type === "direct-skipped" && directId(message.reason))
    return { type: message.type, reason: message.reason };
  const { attempt, sdp, restart } = message;
  if (!integer(attempt, 1, 0xffffffff)) return undefined;
  if (
    message.type === "direct-offer" &&
    text(sdp, MAX_TEXT_LENGTH) &&
    sdp.length > 0 &&
    typeof restart === "boolean"
  )
    return { type: message.type, attempt, sdp, restart };
  return parseDirectSignal(message, attempt);
}

export function parseSidebarBrowserDirectServerMessage(
  value: unknown,
): SidebarBrowserDirectServerMessage | undefined {
  const message = record(value);
  if (!message) return undefined;
  if (message.type === "direct-hello") {
    const { peer, target, boot, iceServers, offered } = message;
    return directId(peer) &&
      directId(target) &&
      directId(boot) &&
      typeof offered === "boolean" &&
      Array.isArray(iceServers) &&
      iceServers.every(isSidebarBrowserStunUrl)
      ? { type: message.type, peer, target, boot, iceServers, offered }
      : undefined;
  }
  const { attempt, sdp } = message;
  if (!integer(attempt, 1, 0xffffffff)) return undefined;
  if (message.type === "direct-ready") return { type: message.type, attempt };
  if (message.type === "direct-answer" && text(sdp, MAX_TEXT_LENGTH) && sdp.length > 0)
    return { type: message.type, attempt, sdp };
  return parseDirectSignal(message, attempt);
}

export function parseSidebarBrowserTransport(value: unknown): SidebarBrowserTransport | undefined {
  const message = record(value);
  if (message?.type !== "transport" || !integer(message.binding, 1)) return undefined;
  const { binding } = message;
  if (message.via === "socket") return { type: "transport", binding, via: "socket" };
  if (message.via === "direct" && integer(message.from, 1))
    return { type: "transport", binding, via: "direct", from: message.from };
  return undefined;
}

export function parseSidebarBrowserAck(value: unknown): SidebarBrowserAck | undefined {
  const message = record(value);
  return message?.type === "ack" && integer(message.sequence, 1)
    ? { type: "ack", sequence: message.sequence }
    : undefined;
}

export function encodeSidebarBrowserDirectAck(sequence: number): string {
  return JSON.stringify({ type: "ack", sequence } satisfies SidebarBrowserAck);
}

export function decodeSidebarBrowserDirectAck(text: string): SidebarBrowserAck | undefined {
  try {
    return parseSidebarBrowserAck(JSON.parse(text));
  } catch {
    return undefined;
  }
}

function validFragment({
  attempt,
  sequence,
  offset,
  total,
  payload,
}: SidebarBrowserDirectFragment): boolean {
  return (
    integer(attempt, 1, 0xffffffff) &&
    integer(sequence, 1) &&
    integer(total, SIDEBAR_BROWSER_FRAME_HEADER_BYTES + 1, SIDEBAR_BROWSER_DIRECT_FRAME_BYTES) &&
    integer(offset, 0, total - 1) &&
    payload.byteLength > 0 &&
    payload.byteLength <=
      SIDEBAR_BROWSER_DIRECT_MESSAGE_BYTES - SIDEBAR_BROWSER_DIRECT_FRAGMENT_HEADER_BYTES &&
    offset + payload.byteLength <= total
  );
}

/** Big endian: uint32 attempt, float64 sequence, uint32 offset, uint32 total, then frame bytes. */
export function encodeSidebarBrowserDirectFragment(
  fragment: SidebarBrowserDirectFragment,
): Uint8Array<ArrayBuffer> {
  if (!validFragment(fragment)) throw new RangeError("Invalid direct frame fragment");
  const bytes = new Uint8Array(
    SIDEBAR_BROWSER_DIRECT_FRAGMENT_HEADER_BYTES + fragment.payload.byteLength,
  );
  const view = new DataView(bytes.buffer);
  view.setUint32(0, fragment.attempt);
  view.setFloat64(4, fragment.sequence);
  view.setUint32(12, fragment.offset);
  view.setUint32(16, fragment.total);
  bytes.set(fragment.payload, SIDEBAR_BROWSER_DIRECT_FRAGMENT_HEADER_BYTES);
  return bytes;
}

export function decodeSidebarBrowserDirectFragment(
  bytes: ArrayBuffer | Uint8Array,
): SidebarBrowserDirectFragment | undefined {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (
    data.byteLength <= SIDEBAR_BROWSER_DIRECT_FRAGMENT_HEADER_BYTES ||
    data.byteLength > SIDEBAR_BROWSER_DIRECT_MESSAGE_BYTES
  )
    return undefined;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const fragment: SidebarBrowserDirectFragment = {
    attempt: view.getUint32(0),
    sequence: view.getFloat64(4),
    offset: view.getUint32(12),
    total: view.getUint32(16),
    payload: data.subarray(SIDEBAR_BROWSER_DIRECT_FRAGMENT_HEADER_BYTES),
  };
  return validFragment(fragment) ? fragment : undefined;
}

/**
 * Validate one viewer message before it reaches the browser.
 * @returns the message, or undefined when malformed or out of range.
 */
export function parseSidebarBrowserClientMessage(
  value: unknown,
): SidebarBrowserClientMessage | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const message = value as Record<string, unknown>;
  switch (message.type) {
    case "viewport":
      return finite(message.width, 1, MAX_VIEWPORT) && finite(message.height, 1, MAX_VIEWPORT)
        ? { type: "viewport", width: message.width, height: message.height }
        : undefined;
    case "visible":
      return typeof message.visible === "boolean"
        ? { type: "visible", visible: message.visible }
        : undefined;
    case "navigate":
      return text(message.url, SIDEBAR_BROWSER_MAX_URL_LENGTH)
        ? { type: "navigate", url: message.url }
        : undefined;
    case "back":
    case "forward":
    case "reload":
      return { type: message.type };
    case "ack":
      return parseSidebarBrowserAck(message);
    case "transport":
      if (!integer(message.binding, 1)) return undefined;
      if (message.peer === undefined) return { type: "transport", binding: message.binding };
      return directId(message.peer)
        ? { type: "transport", binding: message.binding, peer: message.peer }
        : undefined;
    case "mouse": {
      const action = message.action;
      const button = message.button;
      return (action === "down" || action === "up" || action === "move") &&
        (button === "none" || button === "left" || button === "middle" || button === "right") &&
        finite(message.x, -MAX_VIEWPORT, MAX_VIEWPORT) &&
        finite(message.y, -MAX_VIEWPORT, MAX_VIEWPORT) &&
        finite(message.clickCount, 0, 3)
        ? {
            type: "mouse",
            action,
            x: message.x,
            y: message.y,
            button,
            clickCount: message.clickCount,
          }
        : undefined;
    }
    case "wheel":
      return finite(message.x, -MAX_VIEWPORT, MAX_VIEWPORT) &&
        finite(message.y, -MAX_VIEWPORT, MAX_VIEWPORT) &&
        finite(message.deltaX, -10_000, 10_000) &&
        finite(message.deltaY, -10_000, 10_000)
        ? {
            type: "wheel",
            x: message.x,
            y: message.y,
            deltaX: message.deltaX,
            deltaY: message.deltaY,
          }
        : undefined;
    case "key":
      return (message.action === "down" || message.action === "up") &&
        text(message.key, 32) &&
        message.key !== "" &&
        text(message.code, 32)
        ? {
            type: "key",
            action: message.action,
            key: message.key,
            code: message.code,
          }
        : undefined;
    case "text":
      return text(message.text, MAX_TEXT_LENGTH) && message.text !== ""
        ? { type: "text", text: message.text }
        : undefined;
    default:
      return undefined;
  }
}
