import { afterEach, expect, it, vi } from "vitest";
import { mountRendererComposerIndicators } from "../src/renderer-composer-indicators.js";

class FakeElement {
  children: FakeElement[] = [];
  style: Record<string, string> = {};
  classList = { add: vi.fn() };
  hidden = false;
  title = "";
  textContent = "";
  scrollWidth = 60;
  clientWidth = 60;
  nextElementSibling: FakeElement | null = null;
  parentElement: FakeElement | null = null;
  setAttribute = vi.fn();
  remove = vi.fn();
  addEventListener = vi.fn();
  append(...children: FakeElement[]) {
    this.children.push(...children);
  }
  replaceChildren() {
    this.children = [];
  }
  insertBefore(child: FakeElement) {
    this.append(child);
    child.parentElement = this;
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("renders localized countdowns, refreshes each minute, hides expired/absent data and disposes", () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  const disconnect = vi.fn();
  let resize = () => {};
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe() {}
      disconnect = disconnect;
    },
  );
  const doc = {
    querySelector: () => true,
    createElement: () => new FakeElement(),
    createElementNS: () => new FakeElement(),
  };
  const control = mountRendererComposerIndicators({ ownerDocument: doc } as unknown as Element);
  const anchor = new FakeElement();
  anchor.parentElement = new FakeElement();
  control.place(anchor as unknown as HTMLElement);
  const indicators = [
    {
      kind: "countdown" as const,
      id: "cache",
      expiresAtUnix: 1000 + 48 * 60,
      label: { en: "Prompt cache", "zh-CN": "提示词缓存" },
    },
  ];
  control.render(indicators, "zh-CN");
  const root = control.root as unknown as FakeElement;
  expect(root.hidden).toBe(false);
  expect(root.children[0]?.setAttribute).toHaveBeenCalledWith(
    "aria-label",
    "提示词缓存 · 剩余 48 分钟",
  );
  expect(root.children[0]?.addEventListener).toHaveBeenCalledWith(
    "mouseenter",
    expect.any(Function),
  );
  expect(root.children[0]?.children[1]?.textContent).toBe("48m");
  expect(root.children[0]?.children[0]?.setAttribute).toHaveBeenCalledWith("aria-hidden", "true");
  vi.advanceTimersByTime(60_000);
  expect(root.children[0]?.children[1]?.textContent).toBe("47m");
  root.clientWidth = 20;
  resize();
  expect(root.style.visibility).toBe("hidden");
  root.clientWidth = 60;
  resize();
  expect(root.style.visibility).toBe("visible");
  control.render([], "en");
  expect(root.hidden).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
  control.render(indicators, "en");
  expect(root.children[0]?.setAttribute).toHaveBeenCalledWith(
    "aria-label",
    "Prompt cache · 47m remaining",
  );
  vi.advanceTimersByTime(47 * 60_000);
  expect(root.hidden).toBe(true);
  expect(root.children).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
  control.dispose();
  expect(disconnect).toHaveBeenCalledOnce();
  expect(root.remove).toHaveBeenCalled();
});
