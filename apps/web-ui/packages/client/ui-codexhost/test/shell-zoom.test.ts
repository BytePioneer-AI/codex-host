import { describe, expect, it, vi } from "vitest";
import { ShortcutRegistry } from "../../shortcuts/src/client/registry.ts";
import type { ShortcutCommandId, ShortcutPlatform } from "../../shortcuts/src/protocol.ts";
import type {
  ShortcutContext,
  ShortcutFixedInput,
  ShortcutGesture,
  Shortcuts,
} from "../../shortcuts/src/client/types.ts";
import {
  DEFAULT_ZOOM_PERCENT,
  ShellZoomController,
  formatZoomShortcutHint,
  registerShellZoomShortcuts,
  resolveShellZoomShortcut,
  type ShellZoomBridge,
  type ShellZoomState,
} from "../src/client/shell-zoom.ts";

function gesture(overrides: Partial<ShortcutGesture> = {}): ShortcutGesture {
  return {
    code: "Equal",
    key: "=",
    control: false,
    alt: false,
    shift: false,
    meta: true,
    repeat: false,
    composing: false,
    defaultPrevented: false,
    ...overrides,
  };
}

describe("resolveShellZoomShortcut", () => {
  it.each<{
    name: string;
    platform: ShortcutPlatform;
    input: Partial<ShortcutGesture>;
    expected: 1 | -1 | 0 | null;
  }>([
    {
      name: "macOS Command + =",
      platform: "macos",
      input: { code: "Equal", key: "=", meta: true },
      expected: 1,
    },
    {
      name: "macOS Command + Shift + = (+)",
      platform: "macos",
      input: { code: "Equal", key: "+", shift: true, meta: true },
      expected: 1,
    },
    {
      name: "macOS Command + -",
      platform: "macos",
      input: { code: "Minus", key: "-", meta: true },
      expected: -1,
    },
    {
      name: "macOS Command + 0",
      platform: "macos",
      input: { code: "Digit0", key: "0", meta: true },
      expected: 0,
    },
    {
      name: "Windows Ctrl + =",
      platform: "windows",
      input: { code: "Equal", key: "=", control: true, meta: false },
      expected: 1,
    },
    {
      name: "Windows Ctrl + -",
      platform: "windows",
      input: { code: "Minus", key: "-", control: true, meta: false },
      expected: -1,
    },
    {
      name: "Windows Ctrl + 0",
      platform: "windows",
      input: { code: "Digit0", key: "0", control: true, meta: false },
      expected: 0,
    },
    {
      name: "Numpad Add / Subtract / 0 with NumLock off fallback",
      platform: "windows",
      input: { code: "NumpadAdd", key: "+", control: true, meta: false },
      expected: 1,
    },
    {
      name: "NumpadSubtract fallback when key differs",
      platform: "macos",
      input: { code: "NumpadSubtract", key: "Subtract", meta: true },
      expected: -1,
    },
    {
      name: "Numpad0 NumLock-off Insert key fallback",
      platform: "windows",
      input: { code: "Numpad0", key: "Insert", control: true, meta: false },
      expected: 0,
    },
    {
      name: "German layout Ctrl + + (BracketRight)",
      platform: "windows",
      input: { code: "BracketRight", key: "+", control: true, meta: false },
      expected: 1,
    },
    {
      name: "German layout Ctrl + - (Slash)",
      platform: "windows",
      input: { code: "Slash", key: "-", control: true, meta: false },
      expected: -1,
    },
    {
      name: "German layout Ctrl + Shift + 0 produces '=' (zoom in, not reset)",
      platform: "windows",
      input: { code: "Digit0", key: "=", shift: true, control: true, meta: false },
      expected: 1,
    },
    {
      name: "JIS layout Cmd + Shift + Semicolon (+)",
      platform: "macos",
      input: { code: "Semicolon", key: "+", shift: true, meta: true },
      expected: 1,
    },
    {
      name: "AZERTY unshifted Digit0 ('à') falls back to reset",
      platform: "windows",
      input: { code: "Digit0", key: "à", shift: false, control: true, meta: false },
      expected: 0,
    },
    {
      name: "US Ctrl+Shift+- does not fall back when Shift is pressed",
      platform: "windows",
      input: { code: "Minus", key: "_", shift: true, control: true, meta: false },
      expected: null,
    },
    {
      name: "ignores Control on macOS when Command is absent",
      platform: "macos",
      input: { code: "Equal", key: "=", control: true, meta: false },
      expected: null,
    },
    {
      name: "ignores Command+Control chord on macOS",
      platform: "macos",
      input: { code: "Equal", key: "=", control: true, meta: true },
      expected: null,
    },
    {
      name: "ignores Alt-modified combinations",
      platform: "macos",
      input: { code: "Equal", key: "≠", alt: true, meta: true },
      expected: null,
    },
    {
      name: "ignores IME composing input",
      platform: "macos",
      input: { code: "Equal", key: "=", meta: true, composing: true },
      expected: null,
    },
    {
      name: "ignores events already prevented by local controls or shortcut recorder",
      platform: "windows",
      input: { code: "Equal", key: "=", control: true, meta: false, defaultPrevented: true },
      expected: null,
    },
  ])("$name", ({ platform, input, expected }) => {
    expect(resolveShellZoomShortcut(gesture(input), platform)).toBe(expected);
  });
});

function createFixedHarness(platform: ShortcutPlatform) {
  const registry = new ShortcutRegistry("web", platform);
  const listeners = new Set<(input: ShortcutFixedInput) => void>();
  const service: Pick<
    Shortcuts,
    "registerFixed" | "observeFixedInput" | "describeBinding" | "platform"
  > = {
    platform,
    registerFixed: (command) => registry.registerFixed(command),
    observeFixedInput: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    describeBinding: (binding) => registry.describeBinding(binding),
  };
  return {
    registry,
    service,
    emit(input: ShortcutGesture, context: ShortcutContext) {
      let consumed = false;
      for (const listener of listeners) {
        listener({
          type: "keydown",
          gesture: { ...input, defaultPrevented: input.defaultPrevented || consumed },
          context,
          consume: () => {
            consumed = true;
          },
        });
      }
      return consumed;
    },
  };
}

describe("registerShellZoomShortcuts", () => {
  it("registers fixed rows, detects conflicts, and consumes repeat without extra steps", () => {
    const { registry, service, emit } = createFixedHarness("macos");
    const step = vi.fn().mockResolvedValue({ percent: 110, ladder: [] });
    const setPercent = vi.fn().mockResolvedValue({ percent: 100, ladder: [] });

    const dispose = registerShellZoomShortcuts(
      service,
      { step, setPercent },
      { zoomIn: () => "Zoom in", zoomOut: () => "Zoom out", reset: () => "Reset zoom" },
    );

    const rows = registry.fixedCatalog.getSnapshot();
    expect(rows.map((row) => [row.id, row.group, row.keys])).toEqual([
      ["shell.zoom.in", "application", ["⌘", "="]],
      ["shell.zoom.out", "application", ["⌘", "-"]],
      ["shell.zoom.reset", "application", ["⌘", "0"]],
    ]);

    expect(
      service.describeBinding({ code: "Equal", modifiers: ["primary", "shift"] }).conflicts,
    ).toEqual(["shell.zoom.in" as ShortcutCommandId]);
    expect(
      service.describeBinding({ code: "NumpadAdd", modifiers: ["primary"] }).conflicts,
    ).toEqual(["shell.zoom.in" as ShortcutCommandId]);
    expect(
      service.describeBinding({ code: "NumpadSubtract", modifiers: ["primary"] }).conflicts,
    ).toEqual(["shell.zoom.out" as ShortcutCommandId]);
    expect(service.describeBinding({ code: "Numpad0", modifiers: ["primary"] }).conflicts).toEqual([
      "shell.zoom.reset" as ShortcutCommandId,
    ]);

    const ctx: ShortcutContext = { region: "editable", modal: "settings", target: null };
    expect(emit(gesture({ code: "Equal", key: "+", shift: true, meta: true }), ctx)).toBe(true);
    expect(step).toHaveBeenCalledTimes(1);
    expect(step).toHaveBeenCalledWith(1);

    // Repeat still consumes so macOS doesn't beep, without re-stepping.
    expect(emit(gesture({ code: "Equal", key: "=", meta: true, repeat: true }), ctx)).toBe(true);
    expect(step).toHaveBeenCalledTimes(1);

    expect(emit(gesture({ code: "Digit0", key: "0", meta: true }), ctx)).toBe(true);
    expect(setPercent).toHaveBeenCalledWith(DEFAULT_ZOOM_PERCENT);

    dispose();
    expect(registry.fixedCatalog.getSnapshot()).toEqual([]);
  });

  it("formats Windows keycaps with Ctrl + separator consistently", () => {
    const { registry, service } = createFixedHarness("windows");
    const dispose = registerShellZoomShortcuts(
      service,
      {
        step: vi.fn().mockResolvedValue({ percent: 100, ladder: [] }),
        setPercent: vi.fn().mockResolvedValue({ percent: 100, ladder: [] }),
      },
      { zoomIn: () => "Zoom in", zoomOut: () => "Zoom out", reset: () => "Reset zoom" },
    );
    expect(registry.fixedCatalog.getSnapshot().map((row) => row.keys)).toEqual([
      ["Ctrl", "+", "="],
      ["Ctrl", "+", "-"],
      ["Ctrl", "+", "0"],
    ]);
    expect(formatZoomShortcutHint(service)).toBe("Ctrl+= / Ctrl+- / Ctrl+0");
    dispose();
  });

  it("yields character-matched zoom keys when the physical key is bound to another command", () => {
    const { registry, service, emit } = createFixedHarness("windows");
    const openRef = vi.fn();
    const customCmd = vi.fn();
    const step = vi.fn().mockResolvedValue({ percent: 90, ladder: [] });
    const setPercent = vi.fn().mockResolvedValue({ percent: 100, ladder: [] });

    const unregisterOpen = registry.register({
      id: "shortcuts.open" as ShortcutCommandId,
      label: () => "Keyboard shortcuts",
      aliases: [],
      defaults: {
        "web:windows": { code: "Slash", modifiers: ["primary"] },
      },
      regions: ["page", "editable"],
      modals: [],
      resolve: () => ({ status: "handled", run: openRef }),
    });
    const unregisterCustom = registry.register({
      id: "custom.action" as ShortcutCommandId,
      label: () => "Custom action",
      aliases: [],
      defaults: {
        "web:windows": { code: "Digit0", modifiers: ["primary", "shift"] },
      },
      regions: ["page", "editable"],
      modals: [],
      resolve: () => ({ status: "handled", run: customCmd }),
    });

    const dispose = registerShellZoomShortcuts(
      service,
      { step, setPercent },
      { zoomIn: () => "Zoom in", zoomOut: () => "Zoom out", reset: () => "Reset zoom" },
    );
    const ctx: ShortcutContext = { region: "page", modal: null, target: null };

    // European layout: physical Slash produces '-' but primary+Slash is bound to shortcuts.open.
    expect(
      emit(gesture({ code: "Slash", key: "-", control: true, meta: false, shift: false }), ctx),
    ).toBe(false);
    expect(step).not.toHaveBeenCalled();

    // German layout: physical Digit0+Shift produces '=' but primary+shift+Digit0 has a binding.
    expect(
      emit(gesture({ code: "Digit0", key: "=", control: true, meta: false, shift: true }), ctx),
    ).toBe(false);
    expect(step).not.toHaveBeenCalled();

    // Once those physical bindings are removed, character-matched zoom takes effect.
    unregisterOpen();
    unregisterCustom();

    expect(
      emit(gesture({ code: "Slash", key: "-", control: true, meta: false, shift: false }), ctx),
    ).toBe(true);
    expect(step).toHaveBeenCalledWith(-1);

    expect(
      emit(gesture({ code: "Digit0", key: "=", control: true, meta: false, shift: true }), ctx),
    ).toBe(true);
    expect(step).toHaveBeenCalledWith(1);

    dispose();
  });
});

describe("ShellZoomController", () => {
  it("applies silent dropdown updates and tracks external bridge notifications", async () => {
    const listeners = new Set<(state: ShellZoomState) => void>();
    let current: ShellZoomState = { percent: 100, ladder: [50, 100, 150] };
    const bridge: ShellZoomBridge = {
      getState: () => current,
      refresh: vi.fn(async () => current),
      setPercent: vi.fn(async (percent) => {
        current = { ...current, percent };
        return current;
      }),
      step: vi.fn(async () => current),
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };

    const controller = new ShellZoomController(bridge);
    expect(controller.getSnapshot()).toEqual({ percent: 100, ladder: [50, 100, 150] });

    await controller.setPercent(150);
    expect(bridge.setPercent).toHaveBeenCalledWith(150, { silent: true });
    expect(controller.getSnapshot().percent).toBe(150);

    for (const listener of listeners) listener({ percent: 50, ladder: [50, 100, 150] });
    expect(controller.getSnapshot().percent).toBe(50);

    controller.dispose();
    for (const listener of listeners) listener({ percent: 100, ladder: [50, 100, 150] });
    expect(controller.getSnapshot().percent).toBe(50);
  });
});
