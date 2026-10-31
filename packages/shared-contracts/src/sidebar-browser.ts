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
  /** The previous frame has been drawn; the next one may be sent. */
  | { readonly type: "ack" };

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

export type SidebarBrowserServerMessage =
  | SidebarBrowserState
  /** The page opened a window; the viewer opens it as another tab. */
  | { readonly type: "open"; readonly url: string };

export type SidebarBrowserFrameFormat = "jpeg" | "png";

/** Binary frame: 1-byte format, CSS width and height as big-endian uint16, then the image. */
export interface SidebarBrowserFrameHeader {
  readonly format: SidebarBrowserFrameFormat;
  readonly width: number;
  readonly height: number;
}
export const SIDEBAR_BROWSER_FRAME_HEADER_BYTES = 5;

export function encodeSidebarBrowserFrameHeader(header: SidebarBrowserFrameHeader): Uint8Array {
  const bytes = new Uint8Array(SIDEBAR_BROWSER_FRAME_HEADER_BYTES);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, header.format === "png" ? 1 : 0);
  view.setUint16(1, header.width);
  view.setUint16(3, header.height);
  return bytes;
}

export function decodeSidebarBrowserFrameHeader(bytes: ArrayBuffer): SidebarBrowserFrameHeader {
  const view = new DataView(bytes, 0, SIDEBAR_BROWSER_FRAME_HEADER_BYTES);
  return {
    format: view.getUint8(0) === 1 ? "png" : "jpeg",
    width: view.getUint16(1),
    height: view.getUint16(3),
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
    case "ack":
      return { type: message.type };
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
