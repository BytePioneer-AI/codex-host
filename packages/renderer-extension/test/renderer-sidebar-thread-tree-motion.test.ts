// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import {
  SIDEBAR_TREE_MOTION_ATTRIBUTE,
  cancelSidebarThreadTreeMotion,
  captureSidebarThreadTreeMotion,
  playSidebarThreadTreeMotion,
} from "../src/renderer-sidebar-thread-tree-motion.js";

const KEY = "data-codexhost-sidebar-tree-key";

interface Played {
  element: Element;
  keyframes: Keyframe[];
  options: KeyframeAnimationOptions;
  animation: { onfinish: (() => void) | null; cancel: () => void };
}

const rects = new WeakMap<Element, DOMRect>();
let played: Played[] = [];
let reducedMotion = false;

/** Places `element` at `top` in a 300px-wide column of 30px rows. */
function place(element: Element, top: number, height = 30): void {
  rects.set(element, new DOMRect(0, top, 300, height));
}

function element(html: string): HTMLElement {
  const holder = document.createElement("div");
  holder.innerHTML = html;
  return holder.firstElementChild as HTMLElement;
}

beforeEach(() => {
  played = [];
  reducedMotion = false;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    return rects.get(this) ?? new DOMRect(0, 0, 0, 0);
  });
  Object.defineProperty(HTMLElement.prototype, "animate", {
    configurable: true,
    value: function (this: Element, keyframes: Keyframe[], options: KeyframeAnimationOptions) {
      const animation = { onfinish: null as (() => void) | null, cancel: vi.fn() };
      played.push({ element: this, keyframes, options, animation });
      return animation;
    },
  });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({ matches: reducedMotion && query.includes("reduce") }),
  });
  document.body.innerHTML = `
    <div data-app-action-sidebar-scroll>
      <div role="list">
        <div role="listitem" id="item">
          <div ${KEY}="row:a">A</div>
          <div ${KEY}="summary:a">2 child sessions</div>
          <div ${KEY}="row:b">B</div>
        </div>
        <div role="listitem" id="below">Below</div>
      </div>
    </div>`;
  const scroll = document.querySelector("[data-app-action-sidebar-scroll]");
  if (scroll) place(scroll, 0, 600);
  place(document.querySelector(`[${KEY}="row:a"]`) as Element, 0);
  place(document.querySelector(`[${KEY}="summary:a"]`) as Element, 30, 24);
  place(document.querySelector(`[${KEY}="row:b"]`) as Element, 54);
  place(document.querySelector("#below") as Element, 84);
});

afterEach(() => {
  cancelSidebarThreadTreeMotion();
  vi.restoreAllMocks();
  delete (HTMLElement.prototype as { animate?: unknown }).animate;
  delete (window as { matchMedia?: unknown }).matchMedia;
});

it("fades in what appears, glides what moves and fades out what leaves", () => {
  const item = document.querySelector<HTMLElement>("#item") as HTMLElement;
  const motion = captureSidebarThreadTreeMotion(item);
  expect(motion).not.toBeNull();

  // Expanding `a`: its summary goes with no motion, `c` appears, `b` and the next row move down.
  item.querySelector(`[${KEY}="summary:a"]`)?.remove();
  const c = element(`<div ${KEY}="row:c">C</div>`);
  item.querySelector(`[${KEY}="row:b"]`)?.before(c);
  place(c, 30);
  place(item.querySelector(`[${KEY}="row:b"]`) as Element, 60);
  place(document.querySelector("#below") as Element, 90);
  playSidebarThreadTreeMotion(motion as NonNullable<typeof motion>);

  const of = (target: Element | null) => played.filter((entry) => entry.element === target);
  expect(of(c)).toMatchObject([
    { keyframes: [{ opacity: 0 }, { opacity: 1 }], options: { duration: 100, easing: "ease-out" } },
  ]);
  const glide = {
    options: { duration: 300, easing: "cubic-bezier(0.19, 1, 0.22, 1)" },
  };
  expect(of(item.querySelector(`[${KEY}="row:b"]`))).toMatchObject([
    {
      keyframes: [{ transform: "translate(0px, -6px)" }, { transform: "translate(0, 0)" }],
      ...glide,
    },
  ]);
  expect(of(document.querySelector("#below"))).toMatchObject([
    {
      keyframes: [{ transform: "translate(0px, -6px)" }, { transform: "translate(0, 0)" }],
      ...glide,
    },
  ]);
  // The row that stayed in place does not move; a summary leaving with its row still there
  // leaves no picture behind.
  expect(of(item.querySelector(`[${KEY}="row:a"]`))).toEqual([]);
  expect(document.querySelector(`[${SIDEBAR_TREE_MOTION_ATTRIBUTE}]`)).toBeNull();
});

it("fades a leaving row out in an inert overlay that is removed afterwards", () => {
  const item = document.querySelector<HTMLElement>("#item") as HTMLElement;
  const motion = captureSidebarThreadTreeMotion(item);
  const leaving = item.querySelector(`[${KEY}="row:b"]`);
  leaving?.remove();
  playSidebarThreadTreeMotion(motion as NonNullable<typeof motion>);

  const overlay = document.querySelector<HTMLElement>(`[${SIDEBAR_TREE_MOTION_ATTRIBUTE}]`);
  expect(overlay?.getAttribute("aria-hidden")).toBe("true");
  const clone = overlay?.firstElementChild as HTMLElement | null;
  expect(clone?.textContent).toBe("B");
  // A picture of the row cannot be found as a row or reached by keyboard.
  expect(
    [...(clone?.attributes ?? [])]
      .map((attribute) => attribute.name)
      .filter((name) => name !== "inert"),
  ).toEqual(["style"]);
  expect(clone?.style.top).toBe("54px");
  const fade = played.find((entry) => entry.element === clone);
  expect(fade?.keyframes).toEqual([{ opacity: "1" }, { opacity: 0 }]);
  fade?.animation.onfinish?.();
  expect(document.querySelector(`[${SIDEBAR_TREE_MOTION_ATTRIBUTE}]`)).toBeNull();
});

it("does not move anything under reduced motion", () => {
  reducedMotion = true;
  expect(captureSidebarThreadTreeMotion(document.querySelector("#item") as HTMLElement)).toBeNull();
});
