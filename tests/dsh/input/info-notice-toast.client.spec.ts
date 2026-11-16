// @vitest-environment jsdom
import { act, createElement } from "react";
import { useSyncExternalStore } from "react";
import type { ComponentProps, ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Toast } from "../../../apps/web-ui/packages/client/ui-primitives/src/Toast.tsx";
import { InputBar } from "../../../apps/web-ui/packages/client/ui-conversation/src/client/skeleton/InputBar.tsx";
import { SessionInputShell } from "../../../apps/web-ui/packages/client/ui-conversation/src/client/input/facade.ts";

const cleanups: Array<() => void> = [];
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // jsdom has no font-loading set: the control row listens for its event.
  if (document.fonts === undefined)
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: { addEventListener() {}, removeEventListener() {} },
    });
  // The composer's control row measures itself; jsdom has no observer.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanups
    .splice(0)
    .reverse()
    .forEach((dispose) => dispose());
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function translate(dictionary: object) {
  return ((key: string, values: Record<string, unknown> = {}) => {
    let text = (dictionary as Record<string, string>)[key] ?? key;
    for (const [name, value] of Object.entries(values))
      text = text.replace(`{${name}}`, String(value));
    return text;
  }) as ComponentProps<typeof InputBar>["t"];
}

/** jsdom reports no layout: give the composer surface a box so it renders live. */
function stubGeometry() {
  const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, "getClientRects");
  Object.defineProperty(Element.prototype, "getClientRects", {
    configurable: true,
    value: () => [{ width: 320, height: 120 }] as unknown as DOMRectList,
  });
  const bounding = Object.getOwnPropertyDescriptor(Element.prototype, "getBoundingClientRect");
  Object.defineProperty(Element.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ top: 0, bottom: 120, left: 0, right: 320, width: 320, height: 120 }) as DOMRect,
  });
  cleanups.push(() => {
    if (descriptor === undefined) Reflect.deleteProperty(Element.prototype, "getClientRects");
    else Object.defineProperty(Element.prototype, "getClientRects", descriptor);
    if (bounding === undefined) Reflect.deleteProperty(Element.prototype, "getBoundingClientRect");
    else Object.defineProperty(Element.prototype, "getBoundingClientRect", bounding);
  });
}

function shell() {
  const input = new SessionInputShell({
    actx: {} as never,
    defaultSink: async () => ({ kind: "success" }),
  });
  cleanups.push(() => {
    input.dispose();
  });
  return input;
}

/** A live notices hook over one shell's store, stable across renders. */
function noticesHookOf(input: SessionInputShell) {
  return (select: (value: ReturnType<SessionInputShell["notices"]["getSnapshot"]>) => unknown) =>
    useSyncExternalStore(
      input.notices.subscribe,
      () => select(input.notices.getSnapshot()),
      () => select(null),
    );
}

async function mount(element: ReactElement) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  cleanups.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  await act(async () => root.render(element));
  return { container, render: async (next: ReactElement) => act(async () => root.render(next)) };
}

function propsOf(
  input: SessionInputShell,
  sessionFacts: { promptError?: { error: { code: string; message: string } } } = {},
) {
  const useNotices = noticesHookOf(input);
  return {
    sessionId: "one",
    useInput: (select: (state: unknown) => unknown) => select(input.snapshot),
    inputActions: input.actions,
    keyboard: input,
    useSession: (select: (state: object) => unknown) =>
      select({ running: false, removed: false, ...sessionFacts }),
    useBusyEnter: (select: (value: string) => unknown) => select("queue"),
    useFileUploads: (select: (value: object) => unknown) => select({}),
    useNotices,
    useMenuLauncher: (select: (value: undefined) => unknown) => select(undefined),
    useStopShortcut: (select: (value: string[]) => unknown) => select([]),
    useProjection: () => undefined,
    resolveDraftAttachments: () => [],
    renderSlot: () => null,
    stop: vi.fn(),
    t: translate({}),
  } as unknown as ComponentProps<typeof InputBar>;
}

it("Toast announces through role=alert by default; transient confirmations opt into status", async () => {
  const onDone = vi.fn();
  await mount(createElement(Toast, { text: "failure", onDone }));
  expect(document.body.querySelector("[role='alert']")?.textContent).toContain("failure");
  await mount(createElement(Toast, { text: "confirmation", role: "status", onDone }));
  expect(document.body.querySelector("[role='status']")?.textContent).toContain("confirmation");
});

it("info notices expire after the shell's ttl even though nothing clears them earlier", () => {
  vi.useFakeTimers();
  const input = shell();
  input.notify("info", "added");
  const seq = input.notices.getSnapshot()?.seq;
  expect(seq).toBeDefined();
  act(() => vi.advanceTimersByTime(4000));
  expect(input.notices.getSnapshot()).toBeNull();
});

it("an expired info timer cannot clear the error notice that replaced it (seq guard)", () => {
  vi.useFakeTimers();
  const input = shell();
  input.notify("info", "added");
  const infoSeq = input.notices.getSnapshot()?.seq ?? 0;
  // The error write cancels the pending info expiry; even if it fired, the
  // seq guard forbids clearing a successor.
  input.notify("error", "broken");
  expect(input.notices.getSnapshot()?.level).toBe("error");
  act(() => vi.advanceTimersByTime(4000));
  expect(input.notices.getSnapshot()?.level).toBe("error");
  // A stale clear names a replaced notice and must do nothing:
  input.clearNotice(infoSeq);
  expect(input.notices.getSnapshot()?.text).toBe("broken");
});

it("clearNotice only clears the notice it names", () => {
  vi.useFakeTimers();
  const input = shell();
  input.notify("info", "first");
  const first = input.notices.getSnapshot()?.seq ?? 0;
  input.notify("info", "second");
  input.clearNotice(first);
  expect(input.notices.getSnapshot()?.text).toBe("second");
  act(() => vi.advanceTimersByTime(4000));
  expect(input.notices.getSnapshot()).toBeNull();
});

it("dispose cancels the pending expiry", () => {
  vi.useFakeTimers();
  const input = shell();
  input.notify("info", "added");
  input.dispose();
  act(() => vi.advanceTimersByTime(8000));
  expect(input.notices.getSnapshot()?.level).toBe("info");
});

it("a staggered successor gets its own full lifetime, not the replaced notice's deadline", () => {
  vi.useFakeTimers();
  const input = shell();
  input.notify("info", "first");
  // The successor arrives late in the first notice's window:
  act(() => vi.advanceTimersByTime(3000));
  input.notify("info", "second");
  // At the first notice's original deadline the successor must survive:
  act(() => vi.advanceTimersByTime(1000));
  expect(input.notices.getSnapshot()?.text).toBe("second");
  // It expires on its own schedule:
  act(() => vi.advanceTimersByTime(3000));
  expect(input.notices.getSnapshot()).toBeNull();
});

it("equal seqs across shells never share a toast: a switch remounts with the new shell's notice", async () => {
  vi.useFakeTimers();
  stubGeometry();
  const a = shell();
  const b = shell();
  const { render } = await mount(createElement(InputBar, propsOf(a)));
  await act(async () => {
    a.notify("info", "from A");
  });
  // Clear-then-restore: A's text lands after the announce restore delay:
  await act(async () => {
    vi.advanceTimersByTime(100);
  });
  expect(document.body.querySelector("[role='none']")?.textContent).toContain("from A");
  expect(document.body.querySelector("[role='status']")?.textContent).toContain("from A");
  // One second of the fake clock passes before B's notice exists, so the two
  // shells hold the same seq but staggered deadlines:
  act(() => vi.advanceTimersByTime(1000));
  await act(async () => {
    b.notify("info", "from B");
  });
  // Switching the mounted composer to shell B remounts the toast under B's
  // owner-prefixed key — B's text, B's own timing:
  await render(createElement(InputBar, propsOf(b)));
  expect(document.body.querySelector("[role='none']")?.textContent).toContain("from B");
  expect(document.body.querySelector("[role='status']")?.textContent).toBe("");
  await act(async () => {
    vi.advanceTimersByTime(100);
  });
  expect(document.body.querySelector("[role='status']")?.textContent).toContain("from B");
  // A's expiry lands at its own deadline and only clears A's store:
  await act(async () => {
    vi.advanceTimersByTime(2800);
  });
  await render(createElement(InputBar, propsOf(b)));
  expect(a.notices.getSnapshot()).toBeNull();
  expect(b.notices.getSnapshot()?.text).toBe("from B");
  expect(document.body.querySelector("[role='none']")?.textContent).toContain("from B");
  expect(document.body.querySelector("[role='status']")?.textContent).toContain("from B");
  // B then expires on its own full window:
  await act(async () => {
    vi.advanceTimersByTime(1200);
  });
  await render(createElement(InputBar, propsOf(b)));
  expect(document.body.querySelector("[role='none']")).toBeNull();
  expect(document.body.querySelector("[role='status']")?.textContent).toBe("");
  expect(b.notices.getSnapshot()).toBeNull();
});

it("announces info through the persistent live region and renders a visual toast that leaves with the shell expiry", async () => {
  vi.useFakeTimers();
  stubGeometry();
  const input = shell();
  const { render } = await mount(createElement(InputBar, propsOf(input)));
  // ARIA22: the live region pre-exists, empty, before any notice text:
  const region = document.body.querySelector("[role='status']");
  expect(region).not.toBeNull();
  expect(region?.textContent).toBe("");
  await act(async () => {
    input.notify("info", "Added to the current draft");
  });
  // The region is cleared first, then the text is restored on a follow-up
  // task; the visible success toast is role=none (purely visual):
  expect(document.body.querySelector("[role='status']")?.textContent).toBe("");
  expect(document.body.querySelector("[role='none']")?.textContent).toContain(
    "Added to the current draft",
  );
  await act(async () => {
    vi.advanceTimersByTime(100);
  });
  expect(document.body.querySelector("[role='status']")?.textContent).toContain(
    "Added to the current draft",
  );
  expect(input.notices.getSnapshot()?.level).toBe("info");
  // The toast's own fade completion and the shell expiry both land at ~4s;
  // either path must leave no resident banner behind, and the region returns
  // to its empty pre-notice state:
  await act(async () => {
    vi.advanceTimersByTime(4000);
  });
  await render(createElement(InputBar, propsOf(input)));
  expect(document.body.querySelector("[role='none']")).toBeNull();
  expect(document.body.querySelector("[role='status']")?.textContent).toBe("");
  expect(input.notices.getSnapshot()).toBeNull();
});

it("re-announces identical consecutive texts via clear-then-restore", async () => {
  vi.useFakeTimers();
  stubGeometry();
  const input = shell();
  const { render } = await mount(createElement(InputBar, propsOf(input)));
  const regionText = () => document.body.querySelector("[role='status']")?.textContent ?? "";
  await act(async () => {
    input.notify("info", "Added");
  });
  expect(regionText()).toBe("");
  await act(async () => {
    vi.advanceTimersByTime(100);
  });
  expect(regionText()).toBe("Added");
  // Same text again: only the seq changed. The region must still mutate —
  // clear now, restore on the follow-up task — for a second announcement:
  await act(async () => {
    input.notify("info", "Added");
  });
  expect(regionText()).toBe("");
  await act(async () => {
    vi.advanceTimersByTime(100);
  });
  expect(regionText()).toBe("Added");
  // Then the ordinary expiry clears it outright:
  await act(async () => {
    vi.advanceTimersByTime(4100);
  });
  await render(createElement(InputBar, propsOf(input)));
  expect(regionText()).toBe("");
  expect(input.notices.getSnapshot()).toBeNull();
});

it("suppresses the info toast while the error toast owns the top slot", async () => {
  vi.useFakeTimers();
  stubGeometry();
  const input = shell();
  const { render } = await mount(
    createElement(
      InputBar,
      propsOf(input, { promptError: { error: { code: "x/y", message: "boom" } } }),
    ),
  );
  await act(async () => {
    input.notify("info", "Added to the current draft");
  });
  expect(document.body.querySelector("[role='alert']")?.textContent).toContain("boom");
  // The visual toast is suppressed; the persistent live region is cleared
  // first and still restores the notice text for announcement:
  expect(document.body.querySelector("[role='status']")?.textContent).toBe("");
  expect(document.body.querySelector("[role='none']")).toBeNull();
  await act(async () => {
    vi.advanceTimersByTime(100);
  });
  expect(document.body.querySelector("[role='status']")?.textContent).toContain(
    "Added to the current draft",
  );
  // The suppressed notice still expires on schedule:
  await act(async () => {
    vi.advanceTimersByTime(4000);
  });
  await render(createElement(InputBar, propsOf(input)));
  expect(input.notices.getSnapshot()).toBeNull();
  expect(document.body.querySelector("[role='none']")).toBeNull();
  expect(document.body.querySelector("[role='status']")?.textContent).toBe("");
});
