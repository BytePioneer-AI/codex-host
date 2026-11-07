import { describe, expect, it, vi } from "vitest";

import darkSvg from "../../src/assets/codexhost-otter-dark.svg?raw";
import lightSvg from "../../src/assets/codexhost-otter-light.svg?raw";

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

function expectOtter(icon: SVGElement, size: number): void {
  const svg = icon as unknown as FakeSvgElement;
  expect(svg.tagName).toBe("svg");
  expect(svg.attributes.get("viewBox")).toBe("0 0 384 384");
  expect(svg.attributes.get("width")).toBe(String(size));
  expect(svg.attributes.get("height")).toBe(String(size));
  expect(svg.attributes.get("aria-hidden")).toBe("true");
  expect(svg.attributes.get("focusable")).toBe("false");
  expect(svg.attributes.get("data-codexhost-mark")).toBe("otter-navigation");
  expect(svg.children).toHaveLength(2);
  const [detail, silhouette] = svg.children;
  expect(detail?.attributes.get("d")).toBe(CODEXHOST_OTTER_DARK_DETAIL_PATH);
  expect(detail?.attributes.get("fill")).toBe("light-dark(transparent, #b8c0c6)");
  expect(silhouette?.attributes.get("d")).toBe(CODEXHOST_OTTER_PATH);
  expect(silhouette?.attributes.get("fill")).toBe("light-dark(currentColor, #697680)");
  for (const path of svg.children) {
    expect(path.tagName).toBe("path");
    expect(path.attributes.get("fill-rule")).toBe("evenodd");
    expect(path.attributes.has("stroke")).toBe(false);
  }
  expect(svg.classList.add).toHaveBeenCalledWith("codexhost-settings-icon");
}

describe("CodexHost theme-aware otter UI mark", () => {
  for (const size of [20, 22, 24]) {
    it(`renders the original silhouette without a plate at ${size}px`, () => {
      withSvgDocument(() => expectOtter(createRendererSettingsBrandGlyph(size), size));
    });
  }

  it("keeps the viewable SVG exports aligned with the inline UI paths", () => {
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
