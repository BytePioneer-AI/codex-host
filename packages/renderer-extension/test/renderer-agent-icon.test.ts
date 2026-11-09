import { harnessPluginDescriptorSchema } from "@codexhost/shared-contracts";
import { describe, expect, it, vi } from "vitest";
import {
  compatibleRendererPluginPresentation,
  createRendererAgentIcon,
  rendererAgentLabel,
} from "../src/renderer-agent-icon.js";

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

  it("keeps the original SVG rendering, viewport and inherited text color", () => {
    const svg = { style: {}, setAttribute: vi.fn(), append: vi.fn() };
    const path = { setAttribute: vi.fn() };
    const document = {
      createElementNS(namespace: string, tag: string) {
        expect(namespace).toBe("http://www.w3.org/2000/svg");
        return tag === "svg" ? svg : path;
      },
    } as unknown as Document;
    const vector = {
      viewBox: "0 0 24 24",
      color: "currentColor",
      paths: [{ d: "M1 1h22v22H1z", fillRule: "evenodd" as const }],
    };
    expect(
      createRendererAgentIcon(plugin.id, 14, document, {
        ...plugin,
        iconStyle: { vector },
      }),
    ).toBe(svg);
    expect(svg.style).toMatchObject({ width: "14px", height: "14px", fill: "currentColor" });
    expect(svg.setAttribute).toHaveBeenCalledWith("viewBox", vector.viewBox);
    expect(path.setAttribute).toHaveBeenCalledWith("d", vector.paths[0]?.d);
    expect(path.setAttribute).toHaveBeenCalledWith("fill-rule", "evenodd");
    expect(svg.append).toHaveBeenCalledWith(path);
  });

  it("restores missing old-Host styling only for matching identity and image bytes", () => {
    const reference = { ...plugin, iconStyle: { borderRadius: 22.37 } };
    const remote = { ...plugin, name: "Remote name", version: "old" };
    expect(compatibleRendererPluginPresentation(remote, reference)).toEqual({
      ...remote,
      iconStyle: reference.iconStyle,
    });
    expect(compatibleRendererPluginPresentation({ ...remote, icon: undefined }, reference)).toEqual(
      { ...remote, icon: undefined },
    );
    expect(
      compatibleRendererPluginPresentation(remote, {
        ...reference,
        icon: "data:image/svg+xml;base64,PHN2ZyB4Lz4=",
      }),
    ).toBe(remote);
    expect(
      compatibleRendererPluginPresentation(remote, {
        ...reference,
        id: harnessPluginDescriptorSchema.parse({ ...plugin, id: "other-plugin" }).id,
      }),
    ).toBe(remote);
    expect(
      compatibleRendererPluginPresentation(
        { ...remote, iconStyle: { background: "#123456" } },
        reference,
      ),
    ).toEqual({ ...remote, iconStyle: { background: "#123456" } });
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
