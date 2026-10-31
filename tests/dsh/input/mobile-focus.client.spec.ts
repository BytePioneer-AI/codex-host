// @vitest-environment jsdom
import { act, createElement, useSyncExternalStore, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { SessionInputShell } from "../../../apps/web-ui/packages/client/ui-conversation/src/client/input/facade.ts";
import { InputBar } from "../../../apps/web-ui/packages/client/ui-conversation/src/client/skeleton/InputBar.tsx";

vi.mock(
  "../../../apps/web-ui/packages/client/ui-conversation/src/client/skeleton/control-row-layout.ts",
  () => ({ observeControlRow: vi.fn() }),
);

const cleanup: Array<() => void> = [];
afterEach(() => {
  cleanup.splice(0).forEach((dispose) => dispose());
  vi.unstubAllGlobals();
});

const devices = [
  {
    name: "iPhone",
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 Version/18.6 Mobile/15E148 Safari/604.1",
    platform: "iPhone",
    maxTouchPoints: 5,
    automatic: false,
  },
  {
    name: "Android phone",
    userAgent:
      "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 Chrome/119.0.0.0 Mobile Safari/537.36",
    platform: "Linux armv8l",
    maxTouchPoints: 0,
    automatic: false,
  },
  {
    name: "Android tablet",
    userAgent:
      "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 Chrome/119.0.0.0 Safari/537.36",
    platform: "Linux armv8l",
    maxTouchPoints: 5,
    automatic: false,
  },
  {
    name: "desktop-mode iPad",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.6 Safari/605.1.15",
    platform: "MacIntel",
    maxTouchPoints: 5,
    automatic: false,
  },
  {
    name: "Mac",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.6 Safari/605.1.15",
    platform: "MacIntel",
    maxTouchPoints: 0,
    automatic: true,
  },
  {
    name: "Windows touchscreen",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/119.0.0.0 Safari/537.36",
    platform: "Win32",
    maxTouchPoints: 5,
    automatic: true,
  },
];

it.each(devices)(
  "respects automatic focus policy on $name without disabling explicit focus",
  async ({ userAgent, platform, maxTouchPoints, automatic }) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    // jsdom has no Range geometry; Lexical reads it when committing selection.
    const rangeRect = Object.getOwnPropertyDescriptor(Range.prototype, "getBoundingClientRect");
    Object.defineProperty(Range.prototype, "getBoundingClientRect", {
      configurable: true,
      value: () => new DOMRect(),
    });
    onTestFinished(() => {
      if (rangeRect === undefined) Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
      else Object.defineProperty(Range.prototype, "getBoundingClientRect", rangeRect);
    });
    for (const [name, value] of Object.entries({ userAgent, platform, maxTouchPoints })) {
      const descriptor = Object.getOwnPropertyDescriptor(navigator, name);
      Object.defineProperty(navigator, name, { configurable: true, value });
      onTestFinished(() => {
        if (descriptor === undefined) Reflect.deleteProperty(navigator, name);
        else Object.defineProperty(navigator, name, descriptor);
      });
    }
    const input = new SessionInputShell({
      actx: {} as never,
      defaultSink: async () => ({ kind: "success" }),
      commandAttachments: {
        serialize: async () => [],
        release: () => {},
        unsupportedNotice: () => "unsupported",
      },
    });
    input.actions.setDraft("draft");
    const outside = document.createElement("input");
    const container = document.createElement("div");
    document.body.append(outside, container);
    outside.focus();
    const root = createRoot(container);
    cleanup.push(() => {
      act(() => root.unmount());
      input.dispose();
      outside.remove();
      container.remove();
    });
    const props = {
      sessionId: "one",
      useInput: (select: (state: typeof input.snapshot) => unknown) =>
        select(useSyncExternalStore(input.state.subscribe, input.state.getSnapshot)),
      inputActions: input.actions,
      keyboard: input,
      useSession: (select: (state: object) => unknown) =>
        select({ running: false, removed: false }),
      useBusyEnter: (select: (value: string) => unknown) => select("queue"),
      useFileUploads: (select: (value: object) => unknown) => select({}),
      useNotices: (select: (value: null) => unknown) => select(null),
      useMenuLauncher: (select: (value: undefined) => unknown) => select(undefined),
      useStopShortcut: (select: (value: string[]) => unknown) => select([]),
      useProjection: () => undefined,
      resolveDraftAttachments: () => [],
      renderSlot: () => null,
      stop: vi.fn(),
      t: (key: string) => key,
    } as unknown as ComponentProps<typeof InputBar>;
    const render = async (overrides: Partial<typeof props> = {}) => {
      await act(async () => root.render(createElement(InputBar, { ...props, ...overrides })));
    };
    await render();
    const editor = container.querySelector<HTMLElement>("[data-composer-input]");
    expect(editor).not.toBeNull();
    expect(document.activeElement).toBe(automatic ? editor : outside);
    await act(async () => outside.focus());
    await render({ sessionId: "two" as never });
    expect(document.activeElement).toBe(automatic ? editor : outside);
    await act(async () => outside.focus());
    await render({ blocked: { reason: "blocked" } });
    expect(document.activeElement).toBe(outside);
    await render();
    expect(document.activeElement).toBe(automatic ? editor : outside);
    await act(async () => {
      outside.focus();
      editor?.focus();
    });
    expect(document.activeElement).toBe(editor);
  },
);
