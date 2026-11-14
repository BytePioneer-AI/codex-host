// @vitest-environment jsdom
import { act, createElement } from "react";
import type { ComponentProps, ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { InputBar } from "../../../apps/web-ui/packages/client/ui-conversation/src/client/skeleton/InputBar.tsx";
import { SessionInputShell } from "../../../apps/web-ui/packages/client/ui-conversation/src/client/input/facade.ts";
import { en, zh } from "../../../apps/web-ui/packages/client/ui-conversation/src/client/locales.ts";

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

async function mount(props: unknown): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  cleanups.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  const element = createElement(InputBar, props as ComponentProps<typeof InputBar>);
  await act(async () => root.render(element as ReactElement));
  return container;
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

function propsOf(input: SessionInputShell, dictionary: object) {
  return {
    sessionId: "one",
    useInput: (select: (state: unknown) => unknown) => select(input.snapshot),
    inputActions: input.actions,
    keyboard: input,
    useSession: (select: (state: object) => unknown) => select({ running: false, removed: false }),
    useBusyEnter: (select: (value: string) => unknown) => select("queue"),
    useFileUploads: (select: (value: object) => unknown) => select({}),
    useNotices: (select: (value: null) => unknown) => select(null),
    useMenuLauncher: (select: (value: undefined) => unknown) => select(undefined),
    useStopShortcut: (select: (value: string[]) => unknown) => select([]),
    useProjection: () => undefined,
    resolveDraftAttachments: () => [],
    renderSlot: () => null,
    stop: vi.fn(),
    t: translate(dictionary),
  };
}

it.each([
  [en, "1.", "Remove annotation 1"],
  [zh, "1.", "移除批注 1"],
] as const)(
  "shows one numbered annotation chip above the draft",
  async (dictionary, number, remove) => {
    stubGeometry();
    const input = shell();
    input.addResponseAnnotation({ text: "keep the drain loop" });
    const container = await mount(propsOf(input, dictionary));
    const row = container.querySelector("[data-composer-annotations]");
    expect(row).not.toBeNull();
    expect(row?.textContent).toContain(number);
    expect(row?.textContent).toContain("keep the drain loop");
    expect(row?.querySelector("button[aria-label]")?.getAttribute("aria-label")).toBe(remove);
  },
);

it("removing a chip detaches that annotation from the draft", async () => {
  stubGeometry();
  const input = shell();
  input.addResponseAnnotation({ text: "first" });
  input.addResponseAnnotation({ text: "second" });
  const container = await mount(propsOf(input, en));
  const remove = container.querySelector<HTMLButtonElement>(
    "[data-composer-annotations] button[aria-label]",
  );
  await act(async () => remove?.click());
  expect(input.snapshot.responseAnnotations.map((entry) => entry.text)).toEqual(["second"]);
});

it("opens the annotation card from its chip", async () => {
  stubGeometry();
  const input = shell();
  input.addResponseAnnotation({ text: "keep the drain loop", annotation: "why we keep it" });
  const container = await mount(propsOf(input, en));
  const chip = container.querySelector<HTMLButtonElement>("[data-composer-annotations] button");
  await act(async () => chip?.click());
  const card = document.querySelector("[role='dialog']");
  expect(card?.textContent).toContain("Selected text:");
  expect(card?.textContent).toContain("keep the drain loop");
  expect(card?.textContent).toContain("Your comment:");
  expect(card?.textContent).toContain("why we keep it");
});

it("renders no annotation row without annotations", async () => {
  stubGeometry();
  const container = await mount(propsOf(shell(), en));
  expect(container.querySelector("[data-composer-annotations]")).toBeNull();
});
