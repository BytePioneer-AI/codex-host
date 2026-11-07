import { describe, expect, it, vi } from "vitest";

import coloredSvg from "../src/assets/codexhost-otter-color.svg?raw";
import { CODEXHOST_OTTER_PATH } from "../src/assets/codexhost-otter.js";
import { createRendererColoredBrandMark } from "../src/renderer-brand-mark.js";

class FakeElement {
  readonly attributes = new Map<string, string>();
  readonly style: Record<string, string> = {};
  readonly children: FakeElement[] = [];
  className = "";
  src = "";
  alt = "";
  draggable = true;

  constructor(readonly tagName: string) {}

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  append(child: FakeElement): void {
    this.children.push(child);
  }
}

describe("settings and console colored brand mark", () => {
  for (const size of [24, 28, 34]) {
    it(`renders the colored vector in a theme-owned wrapper at ${size}px`, () => {
      const createElement = vi.fn((tag: string) => new FakeElement(tag));
      const ownerDocument = { createElement } as unknown as Document;
      const mark = createRendererColoredBrandMark(ownerDocument, size) as unknown as FakeElement;
      expect(mark.tagName).toBe("span");
      expect(mark.className).toBe("codexhost-colored-brand");
      expect(mark.style.width).toBe(`${size}px`);
      expect(mark.style.height).toBe(`${size}px`);
      expect(mark.attributes.get("aria-hidden")).toBe("true");
      expect(mark.attributes.get("data-codexhost-mark")).toBe("otter-colored");
      expect(mark.children).toHaveLength(1);
      const image = mark.children[0];
      expect(image?.tagName).toBe("img");
      expect(image?.className).toBe("codexhost-colored-brand__image");
      expect(image?.src).toBeTruthy();
      expect(image?.alt).toBe("");
      expect(image?.draggable).toBe(false);
      expect(createElement).toHaveBeenCalledTimes(2);
    });
  }

  it("preserves the original silhouette with the Web navy/green palette", () => {
    const geometries = [...coloredSvg.matchAll(/\bd="([^"]+)"/gu)].map((match) => match[1]);
    expect(geometries).toHaveLength(2);
    expect(geometries.join(" ")).toBe(CODEXHOST_OTTER_PATH);
    expect(coloredSvg).toContain('fill="#082e59"');
    expect(coloredSvg).toContain('fill="#19a785"');
    expect(coloredSvg).not.toMatch(/<(?:image|mask|circle|rect)\b/u);
  });
});
