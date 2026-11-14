// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, createElement } from "react";
import type { ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SelectionActions } from "../../../apps/web-ui/packages/client/ui-chat/src/client/chat/SelectionActions.tsx";

/** Ranges and the text Desktop extracts from them, recorded from its own serializer. */
const DESKTOP = JSON.parse(
  readFileSync(
    resolve(
      import.meta.dirname,
      "../../../packages/shared-contracts/test/fixtures/desktop-selection-text.json",
    ),
    "utf8",
  ),
) as {
  readonly cases: readonly {
    readonly name: string;
    readonly html: string;
    readonly desktop: string;
  }[];
};

const desktopText = (name: string): { html: string; desktop: string } => {
  const found = DESKTOP.cases.find((entry) => entry.name === name);
  if (found === undefined) throw new Error(`missing Desktop case ${name}`);
  return found;
};

const cleanups: Array<() => void> = [];
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(() => {
  cleanups
    .splice(0)
    .reverse()
    .forEach((dispose) => dispose());
  vi.unstubAllGlobals();
});

const labels = { addToChat: "Add to chat" };

/** jsdom has neither range geometry nor animation frames: supply both. */
function stubFrames() {
  const previous = Reflect.get(globalThis, "requestAnimationFrame");
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  cleanups.push(() => {
    if (previous === undefined) Reflect.deleteProperty(globalThis, "requestAnimationFrame");
  });
}

/** jsdom has no media queries: report the requested pointer/hover capability. */
function stubPointer(touch: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({ matches: query === "(hover: none)" ? touch : !touch })),
  );
  cleanups.push(() => {
    vi.unstubAllGlobals();
  });
}

/** jsdom has no range geometry: every measured rect reports the same box. */
function stubGeometry() {
  const rect = () =>
    ({ top: 100, bottom: 120, left: 40, right: 200, width: 160, height: 20 }) as DOMRect;
  for (const target of [Range.prototype, Element.prototype]) {
    const descriptor = Object.getOwnPropertyDescriptor(target, "getClientRects");
    Object.defineProperty(target, "getClientRects", {
      configurable: true,
      value: () => [rect()],
    });
    const bounding = Object.getOwnPropertyDescriptor(target, "getBoundingClientRect");
    Object.defineProperty(target, "getBoundingClientRect", { configurable: true, value: rect });
    cleanups.push(() => {
      if (descriptor === undefined) Reflect.deleteProperty(target, "getClientRects");
      else Object.defineProperty(target, "getClientRects", descriptor);
      if (bounding === undefined) Reflect.deleteProperty(target, "getBoundingClientRect");
      else Object.defineProperty(target, "getBoundingClientRect", bounding);
    });
  }
}

/** Build one transcript with a finished answer, a streaming answer and chrome. */
function transcript() {
  const column = document.createElement("div");
  column.innerHTML = [
    '<div data-selection-answer><p id="done">A finished answer body.</p></div>',
    '<div data-selection-answer><div id="slice"><p>alpha</p><p>beta</p></div><div id="list"><ul><li>one</li><li>two</li></ul><table><tr><td>a</td><td>b</td></tr></table></div><ol id="ordered" start="3"><li>one</li><li value="9">two</li></ol></div>',
    '<div data-selection-answer data-selection-answer-streaming><p id="live">Still streaming.</p></div>',
    '<div data-selection-answer><div data-code-block-controls><button id="chrome">Copy</button></div><p id="code">code body</p></div>',
  ].join("");
  document.body.append(column);
  cleanups.push(() => {
    column.remove();
  });
  return column;
}

async function mount(onAdd: (text: string) => void) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  cleanups.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  await act(async () => {
    root.render(
      createElement(SelectionActions, {
        labels,
        onAdd,
        container: () => document.querySelector("[data-selection-answer]")?.parentElement ?? null,
      }) as ReactElement,
    );
  });
}

/**
 * Select one recorded fragment's content in the transcript and return the text
 * the action would attach.
 * @param html - the answer body, exactly as the Desktop case recorded it.
 */
async function attachedText(html: string): Promise<string | undefined> {
  stubFrames();
  stubGeometry();
  stubPointer(false);
  const column = document.createElement("div");
  column.innerHTML = `<div data-selection-answer>${html}</div>`;
  document.body.append(column);
  cleanups.push(() => {
    column.remove();
  });
  const onAdd = vi.fn();
  await mount(onAdd);
  const host = column.querySelector("[data-selection-answer] #whole");
  if (host === null) throw new Error("missing selection host");
  const range = document.createRange();
  range.selectNodeContents(host);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  await act(async () => {
    document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
    document.dispatchEvent(new Event("pointerup", { bubbles: true }));
  });
  await act(async () => action()?.click());
  return onAdd.mock.calls[0]?.[0] as string | undefined;
}

/** Select one element's text, then report the pointer release a drag would end with. */
async function select(id: string) {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`missing ${id}`);
  const range = document.createRange();
  range.selectNodeContents(element);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  await act(async () => {
    document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
    document.dispatchEvent(new Event("pointerup", { bubbles: true }));
  });
}

function action(): HTMLElement | null {
  return document.querySelector("[data-selection-actions] button");
}

it("offers the action for a selection inside one finished answer", async () => {
  stubFrames();
  stubGeometry();
  stubPointer(false);
  transcript();
  const onAdd = vi.fn();
  await mount(onAdd);
  await select("done");
  expect(action()?.textContent).toBe("Add to chat");
  await act(async () => action()?.click());
  expect(onAdd).toHaveBeenCalledWith("A finished answer body.");
  // Choosing the action clears the selection and its popover.
  expect(document.querySelector("[data-selection-actions]")).toBeNull();
});

it("reads a selected list and table the way Desktop reads them", async () => {
  stubFrames();
  stubGeometry();
  stubPointer(false);
  transcript();
  const onAdd = vi.fn();
  await mount(onAdd);
  await select("list");
  await act(async () => action()?.click());
  expect(onAdd).toHaveBeenCalledWith(desktopText("list and table").desktop);
});

it("writes no list markers or numbers of its own", async () => {
  stubFrames();
  stubGeometry();
  stubPointer(false);
  transcript();
  const onAdd = vi.fn();
  await mount(onAdd);
  await select("ordered");
  await act(async () => action()?.click());
  const expected = desktopText("ordered list with start and value").desktop;
  expect(expected).toBe("one\ntwo");
  expect(onAdd).toHaveBeenCalledWith(expected);
});

it.each(DESKTOP.cases)(
  "attaches exactly what Desktop attaches for $name",
  async ({ html, desktop }) => {
    expect(await attachedText(html)).toBe(desktop);
  },
);

it("keeps a blank line between two selected paragraphs", async () => {
  stubFrames();
  stubGeometry();
  stubPointer(false);
  transcript();
  const onAdd = vi.fn();
  await mount(onAdd);
  await select("slice");
  await act(async () => action()?.click());
  expect(onAdd).toHaveBeenCalledWith(desktopText("paragraphs").desktop);
});

it("anchors the action above the selection on a pointer platform", async () => {
  stubFrames();
  stubGeometry();
  stubPointer(false);
  transcript();
  await mount(() => {});
  await select("done");
  const popover = document.querySelector<HTMLElement>("[data-selection-actions]");
  // The selection runs to top 100 and right 200; Desktop anchors the action's
  // right edge there, 8px above, and draws it upward.
  expect(popover?.style.top).toBe("92px");
  expect(popover?.style.left).toBe("200px");
  expect(popover?.style.transform).toBe(
    "translateX(clamp(-192px, -100%, calc(816px - 100%))) translateY(-100%) translateZ(0)",
  );
  expect(popover?.dataset.placement).toBe("above");
});

it("keeps the action below the selection on a touch platform", async () => {
  stubFrames();
  stubGeometry();
  stubPointer(true);
  transcript();
  await mount(() => {});
  await select("done");
  const popover = document.querySelector<HTMLElement>("[data-selection-actions]");
  expect(popover?.style.top).toBe("128px");
  expect(popover?.style.transform).not.toContain("translateY");
  expect(popover?.dataset.placement).toBe("below");
});

it("bounds the action by the viewport instead of by its own estimate", async () => {
  stubFrames();
  stubGeometry();
  stubPointer(false);
  transcript();
  await mount(() => {});
  await select("done");
  const popover = document.querySelector<HTMLElement>("[data-selection-actions]");
  // Both edges come from the drawn box: the left clamp uses its real width,
  // the right clamp never lets it reach the margin.
  expect(popover?.style.maxWidth).toBe("1008px");
  expect(popover?.style.transform).toContain("calc(816px - 100%)");
});

it("never offers the action inside a streaming answer", async () => {
  stubFrames();
  stubGeometry();
  stubPointer(false);
  transcript();
  await mount(() => {});
  await select("live");
  expect(action()).toBeNull();
});

it("ignores a selection that starts in code-block chrome", async () => {
  stubFrames();
  stubGeometry();
  stubPointer(false);
  transcript();
  await mount(() => {});
  await select("chrome");
  expect(action()).toBeNull();
});

it("withdraws the action when the pointer goes down elsewhere", async () => {
  stubFrames();
  stubGeometry();
  stubPointer(false);
  transcript();
  await mount(() => {});
  await select("done");
  expect(action()).not.toBeNull();
  await act(async () => {
    document.dispatchEvent(new Event("pointerdown", { bubbles: true }));
  });
  expect(action()).toBeNull();
});
