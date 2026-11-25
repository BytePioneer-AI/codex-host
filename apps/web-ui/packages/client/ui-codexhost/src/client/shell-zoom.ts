/** Desktop-shell native zoom controller and unified keyboard shortcut registration. */
import type {
  ShortcutBinding,
  ShortcutCommandId,
  ShortcutGesture,
  ShortcutPlatform,
  Shortcuts,
} from "@deepseek-ai/dsh-client-shortcuts/client";
import { createSnapshotStore } from "@deepseek-ai/dsh-client-store";

export const DEFAULT_ZOOM_PERCENT = 100;
export const DEFAULT_ZOOM_LADDER: readonly number[] = [
  50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200,
];

const ZOOM_COMMAND_IDS: ReadonlySet<string> = new Set([
  "shell.zoom.in",
  "shell.zoom.out",
  "shell.zoom.reset",
]);

export interface ShellZoomState {
  readonly percent: number;
  readonly ladder: readonly number[];
}

export interface ShellZoomUpdateOptions {
  readonly silent?: boolean;
}

export interface ShellZoomBridge {
  getState(): ShellZoomState;
  refresh(): Promise<ShellZoomState>;
  setPercent(percent: number, options?: ShellZoomUpdateOptions): Promise<ShellZoomState>;
  step(delta: -1 | 1, options?: ShellZoomUpdateOptions): Promise<ShellZoomState>;
  subscribe(listener: (state: ShellZoomState) => void): () => void;
}

type BridgeWindow = Window & {
  __codexhostZoom?: Partial<ShellZoomBridge>;
};

export function getShellZoomBridge(
  targetWindow: Window | undefined = typeof window === "undefined" ? undefined : window,
): ShellZoomBridge | undefined {
  const candidate = (targetWindow as BridgeWindow | undefined)?.__codexhostZoom;
  if (
    candidate === undefined ||
    typeof candidate.getState !== "function" ||
    typeof candidate.refresh !== "function" ||
    typeof candidate.setPercent !== "function" ||
    typeof candidate.step !== "function" ||
    typeof candidate.subscribe !== "function"
  ) {
    return undefined;
  }
  return candidate as ShellZoomBridge;
}

/**
 * Resolve one locally arbitrated keyboard gesture into a zoom direction.
 * Character `key` matches first (covering non-US layouts such as German/JIS),
 * with physical `code` fallback only when Shift is unpressed (covering AZERTY and Numpad).
 * @param gesture - arbitrated keyboard input snapshot.
 * @param platform - host operating system selecting Command vs Control.
 * @returns `1` zoom in, `-1` zoom out, `0` reset to 100%, or `null` when unrelated.
 */
export function resolveShellZoomShortcut(
  gesture: ShortcutGesture,
  platform: ShortcutPlatform,
): 1 | -1 | 0 | null {
  if (gesture.defaultPrevented || gesture.composing || gesture.alt) return null;
  const primary =
    platform === "macos" ? gesture.meta && !gesture.control : gesture.control && !gesture.meta;
  if (!primary) return null;

  if (gesture.key === "=" || gesture.key === "+") return 1;
  if (gesture.key === "-") return -1;
  if (gesture.key === "0") return 0;

  if (!gesture.shift) {
    if (gesture.code === "Equal" || gesture.code === "NumpadAdd") return 1;
    if (gesture.code === "Minus" || gesture.code === "NumpadSubtract") return -1;
    if (gesture.code === "Digit0" || gesture.code === "Numpad0") return 0;
  }
  return null;
}

function isReservedPhysicalZoomGesture(gesture: ShortcutGesture): boolean {
  if (gesture.code === "Equal") return true;
  return (
    !gesture.shift &&
    (gesture.code === "Minus" ||
      gesture.code === "Digit0" ||
      gesture.code === "NumpadAdd" ||
      gesture.code === "NumpadSubtract" ||
      gesture.code === "Numpad0")
  );
}

function hasNonZoomBinding(
  shortcuts: Pick<Shortcuts, "describeBinding">,
  gesture: ShortcutGesture,
): boolean {
  const modifiers: ("primary" | "shift")[] = gesture.shift ? ["primary", "shift"] : ["primary"];
  try {
    return shortcuts
      .describeBinding({ code: gesture.code, modifiers })
      .conflicts.some((id) => !ZOOM_COMMAND_IDS.has(id));
  } catch {
    return false;
  }
}

export function formatZoomShortcutHint(shortcuts?: Pick<Shortcuts, "describeBinding">): string {
  if (shortcuts !== undefined) {
    return (
      [
        { code: "Equal", modifiers: ["primary"] },
        { code: "Minus", modifiers: ["primary"] },
        { code: "Digit0", modifiers: ["primary"] },
      ] satisfies readonly ShortcutBinding[]
    )
      .map((binding) => shortcuts.describeBinding(binding).keys.join(""))
      .join(" / ");
  }
  const isMac =
    (typeof document !== "undefined" &&
      document.documentElement?.getAttribute("data-platform") === "darwin") ||
    (typeof navigator !== "undefined" && /mac/i.test(navigator.platform ?? ""));
  return isMac ? "⌘= / ⌘- / ⌘0" : "Ctrl+= / Ctrl+- / Ctrl+0";
}

export class ShellZoomController {
  private readonly store;
  private readonly unsubBridge: () => void;
  private disposed = false;

  constructor(private readonly bridge: ShellZoomBridge) {
    const initial = normalizeSnapshot(bridge.getState());
    this.store = createSnapshotStore<ShellZoomState>(initial);
    this.unsubBridge = bridge.subscribe((next) => {
      if (!this.disposed) this.store.set(normalizeSnapshot(next));
    });
    void bridge
      .refresh()
      .then((next) => {
        if (!this.disposed) this.store.set(normalizeSnapshot(next));
      })
      .catch(() => {});
  }

  readonly subscribe = (listener: () => void): (() => void) => this.store.subscribe(listener);
  readonly getSnapshot = (): ShellZoomState => this.store.getSnapshot();

  async setPercent(percent: number): Promise<void> {
    if (this.disposed) return;
    try {
      const next = await this.bridge.setPercent(percent, { silent: true });
      if (!this.disposed) this.store.set(normalizeSnapshot(next));
    } catch {
      // Native zoom failures preserve the last confirmed zoom state.
    }
  }

  dispose(): void {
    this.disposed = true;
    this.unsubBridge();
  }
}

export function registerShellZoomShortcuts(
  shortcuts: Pick<
    Shortcuts,
    "registerFixed" | "observeFixedInput" | "describeBinding" | "platform"
  >,
  bridge: Pick<ShellZoomBridge, "step" | "setPercent">,
  labels: {
    zoomIn: () => string;
    zoomOut: () => string;
    reset: () => string;
  },
): () => void {
  const fixedDisposers = [
    shortcuts.registerFixed({
      id: "shell.zoom.in" as ShortcutCommandId,
      label: labels.zoomIn,
      keys: shortcuts.describeBinding({ code: "Equal", modifiers: ["primary"] }).keys,
      bindings: [
        { code: "Equal", modifiers: ["primary"] },
        { code: "Equal", modifiers: ["primary", "shift"] },
        { code: "NumpadAdd", modifiers: ["primary"] },
      ],
      group: "application",
    }),
    shortcuts.registerFixed({
      id: "shell.zoom.out" as ShortcutCommandId,
      label: labels.zoomOut,
      keys: shortcuts.describeBinding({ code: "Minus", modifiers: ["primary"] }).keys,
      bindings: [
        { code: "Minus", modifiers: ["primary"] },
        { code: "NumpadSubtract", modifiers: ["primary"] },
      ],
      group: "application",
    }),
    shortcuts.registerFixed({
      id: "shell.zoom.reset" as ShortcutCommandId,
      label: labels.reset,
      keys: shortcuts.describeBinding({ code: "Digit0", modifiers: ["primary"] }).keys,
      bindings: [
        { code: "Digit0", modifiers: ["primary"] },
        { code: "Numpad0", modifiers: ["primary"] },
      ],
      group: "application",
    }),
  ];

  const stopObserving = shortcuts.observeFixedInput((input) => {
    if (input.type !== "keydown") return;
    const action = resolveShellZoomShortcut(input.gesture, shortcuts.platform);
    if (action === null) return;
    // Character-matched keys on non-reserved physical codes yield when that
    // physical combination is bound to another command (e.g. primary+Slash for
    // shortcuts reference on European layouts where Slash produces '-').
    if (
      !isReservedPhysicalZoomGesture(input.gesture) &&
      hasNonZoomBinding(shortcuts, input.gesture)
    ) {
      return;
    }
    input.consume();
    if (input.gesture.repeat) return;
    const request = action === 0 ? bridge.setPercent(DEFAULT_ZOOM_PERCENT) : bridge.step(action);
    void request.catch(() => {});
  });

  return () => {
    stopObserving();
    for (const dispose of fixedDisposers.reverse()) dispose();
  };
}

function normalizeSnapshot(raw: ShellZoomState | undefined): ShellZoomState {
  const ladder =
    Array.isArray(raw?.ladder) && raw.ladder.length > 0 ? raw.ladder : DEFAULT_ZOOM_LADDER;
  const percent =
    typeof raw?.percent === "number" && Number.isFinite(raw.percent)
      ? raw.percent
      : DEFAULT_ZOOM_PERCENT;
  return { percent, ladder };
}
