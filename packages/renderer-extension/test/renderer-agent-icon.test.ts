import { describe, expect, it } from "vitest";

import { createRendererAgentIcon } from "../src/renderer-agent-icon.js";
import antigravityAgentIconUrl from "../src/assets/antigravity-agent.svg";
import kiroAgentIconUrl from "../src/assets/kiro-agent.svg";
import codeBuddyAgentIconUrl from "../src/assets/codebuddy-agent.svg";
import cursorAgentIconUrl from "../src/assets/cursor-agent.svg";
import hermesAgentIconUrl from "../src/assets/hermes-agent.png";

describe("Renderer Agent icons", () => {
  it("renders OpenCode with the bundled official square mark", () => {
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

    expect(createRendererAgentIcon("opencode", 16, ownerDocument)).toBe(image);
    expect(image.src).toMatch(/opencode-agent\.png$/);
    expect(image.alt).toBe("");
    expect(image.draggable).toBe(false);
    expect(image.style.width).toBe("16px");
    expect(image.style.height).toBe("16px");
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

  it("renders Hermes on a light plate so its dark official mark stays visible", () => {
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

    expect(createRendererAgentIcon("hermes", 16, ownerDocument)).toBe(image);
    expect(image.src).toBe(hermesAgentIconUrl);
    expect(image.style).toMatchObject({
      width: "16px",
      height: "16px",
      padding: "1px",
      borderRadius: "22.37%",
      background: "#d8d8e8",
    });
  });

  it.each([
    ["antigravity", antigravityAgentIconUrl],
    ["kiro-cli", kiroAgentIconUrl],
    ["codebuddy", codeBuddyAgentIconUrl],
    ["cursor-cli", cursorAgentIconUrl],
  ] as const)("renders %s with the bundled SVG asset", (agent, assetUrl) => {
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

    expect(createRendererAgentIcon(agent, 16, ownerDocument)).toBe(image);
    expect(image.src).toBe(assetUrl);
    expect(image.alt).toBe("");
    expect(image.draggable).toBe(false);
    expect(image.style.width).toBe("16px");
    expect(image.style.height).toBe("16px");
  });
});
