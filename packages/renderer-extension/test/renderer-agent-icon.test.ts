import { describe, expect, it } from "vitest";

import { createRendererAgentIcon } from "../src/renderer-agent-icon.js";

describe("Renderer Agent icons", () => {
  it("renders OpenCode with the native block mark", () => {
    const paths: Array<{ attributes: Record<string, string> }> = [];
    const svg = {
      style: {},
      setAttribute: () => undefined,
      append: (path: { attributes: Record<string, string> }) => paths.push(path),
    };
    const ownerDocument = {
      createElementNS(_namespace: string, tagName: string) {
        if (tagName === "svg") return svg;
        const path = {
          attributes: {} as Record<string, string>,
          setAttribute(name: string, value: string) {
            this.attributes[name] = value;
          },
        };
        return path;
      },
    } as unknown as Document;

    expect(createRendererAgentIcon("opencode", 16, ownerDocument)).toBe(svg);
    expect(paths).toHaveLength(1);
    expect(paths[0]?.attributes["fill-rule"]).toBe("evenodd");
  });

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
});
