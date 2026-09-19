import { describe, expect, it } from "vitest";

import {
  applyRendererTriggerChipSqueezeRoot,
  applyRendererTriggerChipSqueezeTrigger,
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
  it("exposes max-width budgets that fit a squeezed composer footer", () => {
    expect(rendererModelTriggerMaxWidth()).toBe("min(200px, 26vw)");
    expect(rendererPermissionModeTriggerMaxWidth()).toBe("min(160px, 24vw)");
    expect(rendererUsageTriggerMaxWidth()).toBe("min(140px, 22vw)");
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
