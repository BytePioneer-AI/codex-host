import { describe, expect, it, vi } from "vitest";

import darkSvg from "../../src/assets/codexhost-otter-dark.svg?raw";
import lightSvg from "../../src/assets/codexhost-otter-light.svg?raw";
import historicalRail from "../../src/assets/history/codexhost-rail-v1.svg?raw";

import {
  CODEXHOST_OTTER_DARK_DETAIL_PATH,
  CODEXHOST_OTTER_PATH,
} from "../../src/assets/codexhost-otter.js";
import { createRendererSettingsBrandGlyph } from "../../src/settings/icons.js";

class FakeSvgElement {
  readonly attributes = new Map<string, string>();
  readonly children: FakeSvgElement[] = [];
  readonly classList = { add: vi.fn() };

  constructor(readonly tagName: string) {}

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  append(...children: FakeSvgElement[]): void {
    this.children.push(...children);
  }
}

function withSvgDocument(test: () => void): void {
  vi.stubGlobal("document", {
    createElementNS: (_namespace: string, name: string) => new FakeSvgElement(name),
  });
  try {
    test();
  } finally {
    vi.unstubAllGlobals();
  }
}

function expectRailMark(icon: SVGElement, size: number): void {
  const svg = icon as unknown as FakeSvgElement;
  expect(svg.tagName).toBe("svg");
  expect(svg.attributes.get("viewBox")).toBe("12.8 12.2 40 40");
  expect(historicalRail).toContain(`viewBox="${svg.attributes.get("viewBox")}"`);
  expect(svg.attributes.get("width")).toBe(String(size));
  expect(svg.attributes.get("height")).toBe(String(size));
  expect(svg.attributes.get("aria-hidden")).toBe("true");
  expect(svg.attributes.get("focusable")).toBe("false");
  expect(svg.attributes.get("data-codexhost-mark")).toBe("ch-navigation");
  expect(svg.children).toHaveLength(2);
  const [ring, module] = svg.children;
  expect(ring?.tagName).toBe("path");
  expect(historicalRail).toContain(`d="${ring?.attributes.get("d")}"`);
  expect(ring?.attributes.get("fill")).toBe("none");
  expect(ring?.attributes.get("stroke")).toBe("currentColor");
  expect(ring?.attributes.get("stroke-width")).toBe("3.2");
  expect(ring?.attributes.get("stroke-linecap")).toBe("round");
  expect(module?.tagName).toBe("rect");
  expect(module?.attributes.get("fill")).toBe("currentColor");
  expect(module?.attributes.get("stroke")).toBe("none");
  const historicalSquare = historicalRail.match(/<rect\b[^>]+/u)?.[0];
  for (const attribute of ["x", "y", "width", "height", "rx"]) {
    expect(historicalSquare).toContain(`${attribute}="${module?.attributes.get(attribute)}"`);
  }
  for (const shape of svg.children) {
    expect(shape.attributes.has("transform")).toBe(false);
    expect(shape.attributes.has("style")).toBe(false);
  }
  expect(svg.classList.add).toHaveBeenCalledWith("codexhost-settings-icon");
}

describe("CodexHost navigation rail CH mark", () => {
  for (const size of [16, 20, 22, 24]) {
    it(`preserves historical geometry with a lighter monochrome ring at ${size}px`, () => {
      withSvgDocument(() => expectRailMark(createRendererSettingsBrandGlyph(size), size));
    });
  }

  it("keeps the retained otter SVG exports aligned with their source paths", () => {
    const light = lightSvg;
    const dark = darkSvg;
    expect(light).toContain(`d="${CODEXHOST_OTTER_PATH}"`);
    expect(light).toContain('fill="currentColor"');
    expect(light.match(/<path\b/gu)).toHaveLength(1);
    expect(dark).toContain(`d="${CODEXHOST_OTTER_PATH}"`);
    expect(dark).toContain(`d="${CODEXHOST_OTTER_DARK_DETAIL_PATH}"`);
    expect(dark).toContain('fill="#697680"');
    expect(dark).toContain('fill="#b8c0c6"');
    expect(dark.match(/<path\b/gu)).toHaveLength(2);
    for (const svg of [light, dark]) {
      expect(svg).toContain('viewBox="0 0 384 384"');
      expect(svg).not.toMatch(/<(?:image|mask|circle|rect)\b/u);
    }
  });
});
