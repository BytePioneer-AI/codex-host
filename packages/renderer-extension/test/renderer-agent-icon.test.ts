import { harnessPluginDescriptorSchema } from "@codexhost/shared-contracts";
import { describe, expect, it, vi } from "vitest";
import { createRendererAgentIcon, rendererAgentLabel } from "../src/renderer-agent-icon.js";

const plugin = harnessPluginDescriptorSchema.parse({
  id: "previously-unknown",
  name: "Independent Harness",
  version: "1",
  icon: "data:image/svg+xml;base64,PHN2Zy8+",
});

describe("Renderer plugin presentation", () => {
  it("uses the target Host descriptor without inline SVG or bundled external artwork", () => {
    const image = {
      src: "",
      alt: "unset",
      draggable: true,
      style: {},
    } as unknown as HTMLImageElement;
    const document = {
      createElement(tag: string) {
        expect(tag).toBe("img");
        return image;
      },
    } as Document;
    expect(createRendererAgentIcon(plugin.id, 16, document, plugin)).toBe(image);
    expect(image.src).toBe(plugin.icon);
    expect(image.alt).toBe("");
    expect(image.draggable).toBe(false);
    expect(image.style).toMatchObject({ width: "16px", height: "16px" });
    expect(rendererAgentLabel(plugin.id, plugin)).toBe("Independent Harness");
    expect(rendererAgentLabel(plugin.id)).toBe(plugin.id);
    expect(rendererAgentLabel(plugin.id, { ...plugin, name: "Remote name" })).toBe("Remote name");
  });

  it("keeps monochrome artwork at its original size and inherits the text color", () => {
    const element = { style: {}, setAttribute: vi.fn() } as unknown as HTMLElement;
    const document = {
      createElement(tag: string) {
        expect(tag).toBe("span");
        return element;
      },
    } as Document;
    expect(
      createRendererAgentIcon(plugin.id, 14, document, {
        ...plugin,
        iconStyle: { monochrome: true },
      }),
    ).toBe(element);
    expect(element.style).toMatchObject({
      width: "14px",
      height: "14px",
      backgroundColor: "currentColor",
      mask: `url("${plugin.icon}") center / contain no-repeat`,
    });
  });

  it("preserves plugin-owned plate, padding and rounded corners", () => {
    const image = { style: {} } as unknown as HTMLImageElement;
    const document = { createElement: () => image } as unknown as Document;
    createRendererAgentIcon(plugin.id, 26, document, {
      ...plugin,
      iconStyle: { background: "#d8d8e8", borderRadius: 22.37, paddingRatio: 0.0625 },
    });
    expect(image.style).toMatchObject({
      background: "#d8d8e8",
      borderRadius: "22.37%",
      boxSizing: "border-box",
      padding: "2px",
    });
  });

  it("keeps a missing plugin identity visible rather than disguising it as Codex", () => {
    const element = { style: {}, textContent: "", setAttribute() {} } as unknown as HTMLElement;
    const document = {
      createElement(tag: string) {
        expect(tag).toBe("span");
        return element;
      },
    } as Document;
    expect(createRendererAgentIcon("missing-plugin", 16, document)).toBe(element);
    expect(element.textContent).toBe("M");
    expect(rendererAgentLabel("missing-plugin")).toBe("missing-plugin");
    expect(rendererAgentLabel("codex")).toBe("Codex");
  });
});
