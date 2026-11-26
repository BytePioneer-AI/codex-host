/**
 * Window and tab visibility gate for pausing decorative CSS animations while
 * the page is not visible. Combines `document.hidden` (browser tabs and
 * occluded WebViews) with the desktop shell's hidden/minimized flag via
 * logical OR so neither source can prematurely clear the other.
 * @module @deepseek-ai/dsh-client-web/src/window-visibility
 */

/** Root `<html>` attribute that pauses CSS animations in `base.css`. */
export const WINDOW_HIDDEN_ATTRIBUTE = "data-codexhost-window-hidden";

/** CustomEvent dispatched on `window` by the desktop shell when its hidden state changes. */
export const SHELL_WINDOW_HIDDEN_EVENT = "codexhost:window-hidden-change";

/** Minimal root element surface needed to toggle the hidden attribute. */
export interface WindowVisibilityRootElement {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

/** Minimal document surface watched by {@link installWindowVisibilityGate}. */
export interface WindowVisibilityDocument {
  readonly hidden: boolean;
  readonly documentElement: WindowVisibilityRootElement | null;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

/** Detail payload carried by {@link SHELL_WINDOW_HIDDEN_EVENT}. */
export interface ShellWindowHiddenEventDetail {
  readonly hidden?: boolean;
}

/** Minimal window surface watched for desktop-shell visibility updates. */
export interface WindowVisibilityTarget {
  __codexhostWindowHidden?: boolean;
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
}

/** Optional seams for {@link installWindowVisibilityGate}. */
export interface WindowVisibilityGateOptions {
  readonly document?: WindowVisibilityDocument;
  readonly window?: WindowVisibilityTarget;
}

/**
 * Keep `document.documentElement[data-codexhost-window-hidden]` synchronized
 * with both `document.hidden` and desktop-shell hide/minimize notifications.
 * Unfocused visible windows (for example on a secondary display) remain
 * unpaused because neither `blur` nor focus loss sets this attribute.
 * @param options - Optional document/window seams for testing or custom owners.
 * @returns Disposer that detaches listeners and clears the attribute when not shell-hidden.
 */
export function installWindowVisibilityGate(options?: WindowVisibilityGateOptions): () => void {
  const doc = options?.document ?? (typeof document !== "undefined" ? document : undefined);
  if (doc === undefined) return () => {};
  const win =
    options !== undefined && "window" in options
      ? options.window
      : typeof window !== "undefined"
        ? (window as WindowVisibilityTarget)
        : undefined;

  let shellHidden = Boolean(win?.__codexhostWindowHidden);

  const sync = (): void => {
    const root = doc.documentElement;
    if (root === null) return;
    if (shellHidden || doc.hidden) {
      root.setAttribute(WINDOW_HIDDEN_ATTRIBUTE, "");
    } else {
      root.removeAttribute(WINDOW_HIDDEN_ATTRIBUTE);
    }
  };

  const onVisibilityChange = (): void => {
    sync();
  };

  const onShellHiddenChange = (event: Event): void => {
    const detail = (event as CustomEvent<ShellWindowHiddenEventDetail | undefined>).detail;
    shellHidden =
      typeof detail?.hidden === "boolean" ? detail.hidden : Boolean(win?.__codexhostWindowHidden);
    sync();
  };

  doc.addEventListener("visibilitychange", onVisibilityChange);
  win?.addEventListener(SHELL_WINDOW_HIDDEN_EVENT, onShellHiddenChange);
  sync();

  return () => {
    doc.removeEventListener("visibilitychange", onVisibilityChange);
    win?.removeEventListener(SHELL_WINDOW_HIDDEN_EVENT, onShellHiddenChange);
    if (!Boolean(win?.__codexhostWindowHidden)) {
      doc.documentElement?.removeAttribute(WINDOW_HIDDEN_ATTRIBUTE);
    }
  };
}
