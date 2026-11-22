/** Canvas presentation of a streamed tab, with input captured for the remote page. */
import {
  SIDEBAR_BROWSER_FRAME_HEADER_BYTES,
  type SidebarBrowserClientMessage,
  type SidebarBrowserFrameHeader,
  type SidebarBrowserMouseButton,
  type SidebarBrowserServerMessage,
} from "@codexhost/shared-contracts/sidebar-browser";
import type { BrowserPresentation } from "../view/BrowserPresentation.ts";
import css from "./Remote.module.css";
import { TouchScroll } from "./TouchScroll.ts";

type ViewerMessage = Extract<
  SidebarBrowserClientMessage,
  { type: "viewport" | "visible" | "mouse" | "wheel" | "key" | "text" }
>;

const BUTTONS: readonly SidebarBrowserMouseButton[] = ["left", "middle", "right"];
const IS_MAC = /Mac|iPhone|iPad/u.test(navigator.platform);
/** The viewer's shortcut modifier; the CodexHost machine maps it to its own. */
const PRIMARY_KEY = IS_MAC ? "Meta" : "Control";

/** Owns the canvas and focus target; the frame owns the connection. */
export class RemotePresentation implements BrowserPresentation {
  private canvas: HTMLCanvasElement | undefined;
  private picture: SidebarBrowserFrameHeader | undefined;
  private viewportMessage: Extract<ViewerMessage, { type: "viewport" }> | undefined;
  private visibleValue = false;
  private readonly heldKeys = new Set<string>();
  private editables: Extract<SidebarBrowserServerMessage, { type: "editable" }> | undefined;

  /**
   * @param send - forwards viewer state and input to the connection.
   * @param inputLabel - accessible name of the keyboard focus target.
   */
  constructor(
    private readonly send: (message: ViewerMessage) => void,
    private readonly inputLabel: string,
  ) {}

  /** Latest viewport and visibility, replayed when the connection reopens. */
  get current(): readonly ViewerMessage[] {
    return [
      ...(this.viewportMessage === undefined ? [] : [this.viewportMessage]),
      { type: "visible", visible: this.visibleValue },
    ];
  }

  mount(viewportId: string): () => void {
    const host = document.getElementById(viewportId);
    if (host === null) throw new Error("remote presentation: viewport is not mounted");
    const lifetime = new AbortController();
    const { signal } = lifetime;
    const root = document.createElement("div");
    root.className = css.root as string;
    const canvas = document.createElement("canvas");
    canvas.className = css.canvas as string;
    canvas.dataset.sidebarBrowserFrame = "remote";
    canvas.tabIndex = 0;
    canvas.setAttribute("aria-label", this.inputLabel);
    const input = document.createElement("textarea");
    input.className = css.input as string;
    input.setAttribute("aria-label", this.inputLabel);
    input.autocapitalize = "off";
    input.spellcheck = false;
    root.append(canvas, input);
    host.append(root);
    this.canvas = canvas;
    this.picture = undefined;

    const measure = (): void => {
      if (this.canvas !== canvas) return;
      const bounds = root.getBoundingClientRect();
      const width = Math.round(bounds.width);
      const height = Math.round(bounds.height);
      if (width > 0 && height > 0) {
        const previous = this.viewportMessage;
        if (previous?.width !== width || previous.height !== height) {
          this.viewportMessage = { type: "viewport", width, height };
          this.send(this.viewportMessage);
        }
      }
      this.setVisible(
        width > 0 &&
          height > 0 &&
          document.visibilityState === "visible" &&
          root.closest("[inert]") === null,
      );
    };
    let pendingMeasure: ReturnType<typeof setTimeout> | undefined;
    const scheduleMeasure = (): void => {
      clearTimeout(pendingMeasure);
      pendingMeasure = setTimeout(measure, 80);
    };
    const resize = new ResizeObserver(scheduleMeasure);
    resize.observe(root);
    // Inert tab sections mark a collapsed dock immediately, even while it still
    // has its full size and is sliding out. Floating tabs can remain visible.
    const visibility = new MutationObserver(measure);
    for (let ancestor = root.parentElement; ancestor !== null; ancestor = ancestor.parentElement)
      visibility.observe(ancestor, { attributeFilter: ["inert"] });
    window.addEventListener("resize", scheduleMeasure, { signal });
    document.addEventListener("visibilitychange", measure, { signal });
    measure();

    this.captureInput(root, canvas, input, signal);
    return () => {
      lifetime.abort();
      resize.disconnect();
      visibility.disconnect();
      clearTimeout(pendingMeasure);
      this.releaseKeys();
      root.remove();
      if (this.canvas === canvas) {
        this.canvas = undefined;
        this.setVisible(false);
      }
    };
  }

  /**
   * Draw one frame at its physical resolution, sized to its CSS viewport.
   * @param frame - header and encoded image.
   * @param header - decoded frame header.
   * @param current - whether the frame still belongs to the active connection.
   */
  async draw(
    frame: ArrayBuffer,
    header: SidebarBrowserFrameHeader,
    current: () => boolean,
  ): Promise<void> {
    const canvas = this.canvas;
    if (canvas === undefined) return;
    const image = await createImageBitmap(
      new Blob([frame.slice(SIDEBAR_BROWSER_FRAME_HEADER_BYTES)], {
        type: header.format === "png" ? "image/png" : "image/jpeg",
      }),
    );
    try {
      if (!current() || this.canvas !== canvas) return;
      if (canvas.width !== image.width) canvas.width = image.width;
      if (canvas.height !== image.height) canvas.height = image.height;
      canvas.style.width = `${String(header.width)}px`;
      canvas.style.height = `${String(header.height)}px`;
      canvas.getContext("2d")?.drawImage(image, 0, 0);
      this.picture = header;
    } finally {
      image.close();
    }
  }

  setEditables(editables: typeof this.editables): void {
    this.editables = editables;
    // A reconnect must paint a picture before using the new connection's hit areas.
    if (editables === undefined) this.picture = undefined;
  }

  /** Forget the canvas; the frame closes the connection. */
  dispose(): void {
    this.canvas = undefined;
    this.setVisible(false);
  }

  private setVisible(visible: boolean): void {
    if (visible === this.visibleValue) return;
    this.visibleValue = visible;
    this.send({ type: "visible", visible });
  }

  private point(event: MouseEvent): { x: number; y: number } {
    const canvas = this.canvas;
    const size = this.picture;
    if (canvas === undefined || size === undefined) return { x: event.offsetX, y: event.offsetY };
    const bounds = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - bounds.left) * size.width) / (bounds.width || 1),
      y: ((event.clientY - bounds.top) * size.height) / (bounds.height || 1),
    };
  }

  private captureInput(
    root: HTMLElement,
    canvas: HTMLCanvasElement,
    input: HTMLTextAreaElement,
    signal: AbortSignal,
  ): void {
    const on = <K extends keyof HTMLElementEventMap>(
      target: HTMLElement,
      type: K,
      listener: (event: HTMLElementEventMap[K]) => void,
      passive = true,
    ): void => {
      target.addEventListener(type, listener, { signal, passive });
    };
    let touch: TouchScroll | undefined;
    let pointerType = "mouse";
    const focusAt = (event: MouseEvent): void => {
      const at = this.point(event);
      const editable =
        this.editables !== undefined &&
        this.editables.generation === this.picture?.generation &&
        this.editables.regions.some(
          (region) =>
            at.x >= region.x &&
            at.y >= region.y &&
            at.x < region.x + region.width &&
            at.y < region.y + region.height,
        );
      // Canvas focus accepts navigation keys without opening the viewer's virtual keyboard.
      // Editable focus must stay inside the user's gesture because iOS rejects async requests.
      (editable ? input : canvas).focus({ preventScroll: true });
    };

    // Mouse events carry the browser's native double/triple-click count; pointer events do not.
    for (const action of ["down", "up"] as const)
      on(
        canvas,
        `mouse${action}`,
        (event) => {
          event.preventDefault();
          // Some touch browsers still emit compatibility mouse events after a tap.
          if (pointerType !== "mouse") return;
          if (action === "down") focusAt(event);
          this.send({
            type: "mouse",
            action,
            ...this.point(event),
            button: BUTTONS[event.button] ?? "left",
            clickCount: Math.min(3, Math.max(1, event.detail)),
          });
        },
        false,
      );
    on(
      canvas,
      "pointerdown",
      (event) => {
        pointerType = event.pointerType;
        if (event.pointerType === "mouse") focusAt(event);
        canvas.setPointerCapture(event.pointerId);
        if (event.pointerType !== "mouse") {
          // Touch taps are forwarded below; suppress their compatibility mouse events.
          event.preventDefault();
          touch = new TouchScroll(event.pointerId, this.point(event), event.clientX, event.clientY);
        }
      },
      false,
    );
    on(canvas, "pointermove", (event) => {
      if (event.pointerType === "mouse") {
        this.send({
          type: "mouse",
          action: "move",
          ...this.point(event),
          button: "none",
          clickCount: 0,
        });
        return;
      }
      if (touch?.id !== event.pointerId) return;
      const wheel = touch.move(event.clientX, event.clientY);
      if (wheel !== undefined) this.send(wheel);
    });
    on(canvas, "pointerup", (event) => {
      if (event.pointerType === "mouse" || touch?.id !== event.pointerId) return;
      const tapped = touch.tapped;
      touch = undefined;
      if (!tapped) return;
      const at = this.point(event);
      focusAt(event);
      for (const action of ["down", "up"] as const)
        this.send({ type: "mouse", action, ...at, button: "left", clickCount: 1 });
    });
    on(canvas, "pointercancel", () => {
      touch = undefined;
    });
    on(
      canvas,
      "wheel",
      (event) => {
        event.preventDefault();
        const scale =
          event.deltaMode === WheelEvent.DOM_DELTA_LINE
            ? 16
            : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
              ? (this.picture?.height ?? 800)
              : 1;
        this.send({
          type: "wheel",
          ...this.point(event),
          deltaX: event.deltaX * scale,
          deltaY: event.deltaY * scale,
        });
      },
      false,
    );
    on(
      canvas,
      "contextmenu",
      (event) => {
        event.preventDefault();
      },
      false,
    );

    const remoteKey = (event: KeyboardEvent): string | undefined => {
      if (event.isComposing || event.key === "Process" || event.key === "Unidentified")
        return undefined;
      // Printable keys without a shortcut modifier arrive as text, which keeps IME and layouts.
      if (event.key.length === 1 && !event.ctrlKey && !event.metaKey) return undefined;
      return event.key === PRIMARY_KEY ? "ControlOrMeta" : event.key;
    };
    on(
      root,
      "keydown",
      (event) => {
        const key = remoteKey(event);
        if (key === undefined) return;
        // The viewer's paste shortcut produces a paste event carrying its clipboard.
        if ((event.key === "v" || event.key === "V") && (IS_MAC ? event.metaKey : event.ctrlKey))
          return;
        event.preventDefault();
        this.heldKeys.add(key);
        this.send({ type: "key", action: "down", key, code: event.code });
      },
      false,
    );
    on(
      root,
      "keyup",
      (event) => {
        const key = remoteKey(event);
        if (key === undefined || !this.heldKeys.delete(key)) return;
        event.preventDefault();
        this.send({ type: "key", action: "up", key, code: event.code });
      },
      false,
    );
    const commit = (text: string): void => {
      input.value = "";
      if (text !== "") this.send({ type: "text", text });
    };
    on(input, "compositionend", (event) => {
      commit(event.data);
    });
    on(input, "input", (event) => {
      if (!(event as InputEvent).isComposing) commit(input.value);
    });
    on(
      input,
      "paste",
      (event) => {
        event.preventDefault();
        commit(event.clipboardData?.getData("text/plain") ?? "");
      },
      false,
    );
    for (const target of [canvas, input])
      on(target, "blur", () => {
        this.releaseKeys();
      });
  }

  /** Keys held when focus leaves would otherwise stay pressed in the remote page. */
  private releaseKeys(): void {
    for (const key of this.heldKeys) this.send({ type: "key", action: "up", key, code: "" });
    this.heldKeys.clear();
  }
}
