import { afterEach, describe, expect, it, vi } from "vitest";

import {
  applyRendererTriggerChipSqueezeRoot,
  applyRendererTriggerChipSqueezeTrigger,
  observeRendererCompactComposer,
  rendererCreditsTriggerMaxWidth,
  rendererModelTriggerMaxWidth,
  rendererPermissionModeTriggerMaxWidth,
  rendererUsageTriggerMaxWidth,
  TRIGGER_CHIP_CLASS,
  TRIGGER_CHIP_ROOT_CLASS,
  TRIGGER_CHIP_SQUEEZE_MIN_WIDTH,
} from "../src/renderer-trigger-chip-style.js";

function fakeElement(): HTMLElement {
  const classNames = new Set<string>();
  return {
    classList: {
      add: (value: string) => {
        classNames.add(value);
      },
      contains: (value: string) => classNames.has(value),
    },
    style: {},
  } as unknown as HTMLElement;
}

describe("Renderer trigger chip squeeze layout", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("follows the composer width and restores the normal layout on expansion", () => {
    let onResize: ResizeObserverCallback | undefined;
    const disconnect = vi.fn();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          onResize = callback;
        }
        observe = vi.fn();
        disconnect = disconnect;
      },
    );
    const attributes = new Set<string>();
    let width = 360;
    const composer = {
      getBoundingClientRect: () => ({ width }),
      toggleAttribute: (name: string, enabled: boolean) => {
        if (enabled) attributes.add(name);
        else attributes.delete(name);
      },
      removeAttribute: (name: string) => attributes.delete(name),
    } as unknown as Element;

    const stop = observeRendererCompactComposer(composer);
    expect(attributes.has("data-codexhost-compact-composer")).toBe(true);
    width = 480;
    onResize?.([{ contentRect: { width: 480 } } as ResizeObserverEntry], {} as ResizeObserver);
    expect(attributes.has("data-codexhost-compact-composer")).toBe(false);
    width = 320;
    onResize?.([{ contentRect: { width: 320 } } as ResizeObserverEntry], {} as ResizeObserver);
    expect(attributes.has("data-codexhost-compact-composer")).toBe(true);
    stop();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(attributes.has("data-codexhost-compact-composer")).toBe(false);
  });

  it.each([
    { width: 420, contentWidth: 386, compact: true },
    { width: 421, contentWidth: 387, compact: false },
    { width: 400, contentWidth: 500, compact: true },
  ])(
    "keeps the initial width decision at $width px when content width differs",
    ({ width, contentWidth, compact }) => {
      let onResize: ResizeObserverCallback | undefined;
      vi.stubGlobal(
        "ResizeObserver",
        class {
          constructor(callback: ResizeObserverCallback) {
            onResize = callback;
          }
          observe = vi.fn();
          disconnect = vi.fn();
        },
      );
      const attributes = new Set<string>();
      const composer = {
        getBoundingClientRect: () => ({ width }),
        toggleAttribute: (name: string, enabled: boolean) => {
          if (enabled) attributes.add(name);
          else attributes.delete(name);
        },
        removeAttribute: (name: string) => attributes.delete(name),
      } as unknown as Element;
      const stop = observeRendererCompactComposer(composer);
      expect(attributes.has("data-codexhost-compact-composer")).toBe(compact);
      onResize?.(
        [{ target: composer, contentRect: { width: contentWidth } } as ResizeObserverEntry],
        {} as ResizeObserver,
      );
      expect(attributes.has("data-codexhost-compact-composer")).toBe(compact);
      stop();
    },
  );

  it("exposes max-width budgets that fit a squeezed composer footer", () => {
    expect(rendererModelTriggerMaxWidth()).toBe("min(200px, 26vw)");
    expect(rendererPermissionModeTriggerMaxWidth()).toBe("min(160px, 24vw)");
    expect(rendererUsageTriggerMaxWidth()).toBe("min(240px, 30vw)");
    expect(rendererCreditsTriggerMaxWidth()).toBe("min(72px, 16vw)");
  });

  it("makes chip roots shrinkable flex items with overflow clipping", () => {
    const root = fakeElement();
    applyRendererTriggerChipSqueezeRoot(root, rendererModelTriggerMaxWidth());
    expect(root.classList.contains(TRIGGER_CHIP_ROOT_CLASS)).toBe(true);
    expect(root.style.flex).toBe("0 1 auto");
    expect(root.style.minWidth).toBe(TRIGGER_CHIP_SQUEEZE_MIN_WIDTH);
    expect(root.style.maxWidth).toBe(rendererModelTriggerMaxWidth());
    expect(root.style.overflow).toBe("hidden");
  });

  it("sizes triggers to the squeezed root so labels can ellipsis", () => {
    const trigger = fakeElement();
    trigger.className = TRIGGER_CHIP_CLASS;
    applyRendererTriggerChipSqueezeTrigger(trigger);
    expect(trigger.style.minWidth).toBe("0");
    expect(trigger.style.width).toBe("100%");
    expect(trigger.style.maxWidth).toBe("100%");
    expect(trigger.style.overflow).toBe("hidden");
  });

  it("tolerates partial Composer control mocks without style or classList", () => {
    expect(() =>
      applyRendererTriggerChipSqueezeRoot({} as HTMLElement, rendererModelTriggerMaxWidth()),
    ).not.toThrow();
    expect(() => applyRendererTriggerChipSqueezeTrigger({} as HTMLElement)).not.toThrow();
  });
});
