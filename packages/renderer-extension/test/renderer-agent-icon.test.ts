import { describe, expect, it, vi } from "vitest";

import { createRendererAgentIcon } from "../src/renderer-agent-icon.js";

describe("Renderer Agent icons", () => {
  it("renders OMP with the bundled image asset", () => {
    const image = {
      src: "",
      alt: "unset",
      draggable: true,
      style: {},
    } as unknown as HTMLImageElement;
    const ownerDocument = {
      createElement(tagName: string) {
        expect(tagName).toBe("img");
        return image;
      },
    } as unknown as Document;

    expect(createRendererAgentIcon("omp", 16, ownerDocument)).toBe(image);
    expect(image.src).toMatch(/^data:image\/svg\+xml,/);
    expect(image.alt).toBe("");
    expect(image.draggable).toBe(false);
    expect(image.style.width).toBe("16px");
    expect(image.style.height).toBe("16px");
    expect(image.style.borderRadius).toBe("22.37%");
  });

  it("renders Grok with the bundled image asset", () => {
    const image = {
      src: "",
      alt: "unset",
      draggable: true,
      style: {},
    } as unknown as HTMLImageElement;
    const ownerDocument = {
      createElement(tagName: string) {
        expect(tagName).toBe("img");
        return image;
      },
    } as unknown as Document;

    expect(createRendererAgentIcon("grok", 16, ownerDocument)).toBe(image);
    expect(image.src).toMatch(/grok-agent\.png$/);
    expect(image.alt).toBe("");
    expect(image.draggable).toBe(false);
    expect(image.style.width).toBe("16px");
    expect(image.style.height).toBe("16px");
    expect(image.style.borderRadius).toBe("22.37%");
  });

  it("renders Cursor as an inline SVG mark", () => {
    const svg = { setAttribute: vi.fn(), style: {} as CSSStyleDeclaration, append: vi.fn() };
    const path = { setAttribute: vi.fn() };
    const ownerDocument = {
      createElementNS(_namespace: string, tagName: string) {
        return tagName === "svg" ? svg : path;
      },
    } as unknown as Document;

    expect(createRendererAgentIcon("cursor", 16, ownerDocument)).toBe(svg);
    expect(svg.setAttribute).toHaveBeenCalledWith("viewBox", "0 0 24 24");
    expect(svg.style.width).toBe("16px");
    expect(path.setAttribute).toHaveBeenCalledWith("d", expect.stringContaining("M4 3.2"));
  });
});
