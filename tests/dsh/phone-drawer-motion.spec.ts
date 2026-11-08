// @vitest-environment jsdom
import { act, createElement, useRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { usePhoneDrawerMotion } from "../../apps/web-ui/packages/client/ui-layout/src/client/use-phone-drawer-motion.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  cleanup.splice(0).forEach((dispose) => dispose());
  vi.unstubAllGlobals();
});

function fixture(reduce = false) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const frames = new Map<number, FrameRequestCallback>();
  let id = 0;
  let time = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (key: number) => frames.delete(key));
  const disconnect = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect = disconnect;
    },
  );
  const media = Object.assign(new EventTarget(), { matches: reduce });
  vi.stubGlobal("matchMedia", () => media);
  const change = vi.fn();
  function Drawer({ open, enabled }: { open: boolean; enabled: boolean }) {
    const frame = useRef<HTMLDivElement>(null);
    const drawer = useRef<HTMLDivElement>(null);
    const backdrop = useRef<HTMLButtonElement>(null);
    const present = usePhoneDrawerMotion(frame, drawer, backdrop, enabled, open, change);
    return createElement(
      "div",
      { ref: frame },
      createElement("button", { ref: backdrop }),
      createElement(
        "div",
        { ref: drawer, "data-present": present },
        createElement("div", { "data-phone-drawer-edge": true }),
      ),
    );
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = (open: boolean, enabled = true) =>
    act(() => root.render(createElement(Drawer, { open, enabled })));
  render(false);
  const drawer = container.querySelector<HTMLDivElement>("[data-present]")!;
  Object.defineProperty(drawer, "offsetWidth", { value: 300 });
  const edge = drawer.firstElementChild as HTMLElement;
  edge.setPointerCapture = vi.fn();
  edge.hasPointerCapture = () => true;
  edge.releasePointerCapture = vi.fn();
  const pointer = (type: string, x: number, y: number, timestamp: number) =>
    act(() => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperties(
        event,
        Object.fromEntries(
          Object.entries({
            pointerId: 1,
            isPrimary: true,
            button: 0,
            clientX: x,
            clientY: y,
            timeStamp: timestamp,
          }).map(([key, value]) => [key, { value }]),
        ),
      );
      edge.dispatchEvent(event);
    });
  const advance = (count = 180) =>
    act(() => {
      for (let i = 0; i < count; i++) {
        time += 16;
        const batch = [...frames.values()];
        frames.clear();
        batch.forEach((callback) => callback(time));
      }
    });
  const unmount = () => act(() => root.unmount());
  cleanup.push(() => {
    unmount();
    container.remove();
  });
  return { render, drawer, edge, pointer, advance, frames, disconnect, change, unmount };
}

it("retargets from its current position, keeps direction lock, cancels without navigation and removes work", () => {
  const f = fixture();
  f.render(true);
  f.advance();
  expect(f.drawer.style.transform).toBe("translateX(0px)");
  f.render(false);
  f.advance(3);
  const closing = f.drawer.style.transform;
  f.render(true);
  expect(f.drawer.style.transform).toBe(closing);
  f.advance();
  expect(f.drawer.style.transform).toBe("translateX(0px)");
  f.pointer("pointerdown", 290, 100, 100);
  f.pointer("pointermove", 292, 130, 130);
  f.pointer("pointermove", 80, 130, 160);
  f.pointer("pointerup", 80, 130, 180);
  f.advance();
  expect(f.change).not.toHaveBeenCalled();
  f.pointer("pointerdown", 290, 100, 200);
  f.pointer("pointermove", 200, 101, 250);
  expect(f.drawer.style.transform).toBe("translateX(-90px)");
  f.pointer("pointercancel", 200, 101, 260);
  f.advance();
  expect(f.drawer.style.transform).toBe("translateX(0px)");
  expect(f.change.mock.calls.every(([open]) => open === true)).toBe(true);
  f.pointer("pointerdown", 290, 100, 300);
  f.pointer("pointermove", 80, 101, 350);
  f.pointer("pointerup", 80, 101, 360);
  expect(f.change).toHaveBeenLastCalledWith(false);
  expect(f.frames.size).toBe(1);
  f.unmount();
  expect(f.frames.size).toBe(0);
  expect(f.disconnect).toHaveBeenCalledOnce();
  f.change.mockClear();
  f.pointer("pointerdown", 290, 100, 400);
  f.pointer("pointermove", 80, 100, 450);
  expect(f.change).not.toHaveBeenCalled();
});

it("an edge grab interrupts closing in place and a paused release has no stale fling", () => {
  const f = fixture();
  f.render(true);
  f.advance();
  f.render(false);
  f.advance(3);
  const moving = f.drawer.style.transform;
  f.pointer("pointerdown", 290, 100, 0);
  expect(f.drawer.style.transform).toBe(moving);
  f.pointer("pointermove", 320, 100, 30);
  f.render(true);
  f.pointer("pointercancel", 320, 100, 40);
  f.advance();
  expect(f.drawer.style.transform).toBe("translateX(0px)");
  f.pointer("pointerdown", 290, 100, 100);
  f.pointer("pointermove", 200, 100, 145);
  f.pointer("pointerup", 200, 100, 600);
  expect(f.change).toHaveBeenLastCalledWith(true);
  f.advance();
  expect(f.drawer.style.transform).toBe("translateX(0px)");
});

it("reduced motion lands immediately and desktop mode schedules no animation", () => {
  const f = fixture(true);
  f.render(true);
  expect(f.drawer.style.transform).toBe("translateX(0px)");
  expect(f.frames.size).toBe(0);
  f.render(false);
  expect(f.drawer.style.visibility).toBe("hidden");
  expect(f.frames.size).toBe(0);
  f.render(false, false);
  f.render(true, false);
  expect(f.frames.size).toBe(0);
});
