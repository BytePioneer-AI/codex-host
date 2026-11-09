// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { MarkdownText } from "@deepseek-ai/dsh-client-ui-primitives/src/markdown/MarkdownText.tsx";
import { MarkdownDelegateProvider } from "@deepseek-ai/dsh-client-ui-primitives/src/markdown/MarkdownDelegate.tsx";

const labels = { code: { copyLabel: "Copy", copiedLabel: "Copied" }, footnotes: "Footnotes" };
afterEach(() => vi.unstubAllGlobals());

it.each(["pathImages", "fileImages"] as const)(
  "keeps %s load tags across rerenders but not remounts",
  async (kind) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const url = "https://host/api/file?path=%2Ftmp%2Fimage.png";
    const resolve = () => url;
    const source = "![local](/tmp/image.png)\n\n![remote](https://example.com/image.png)";
    const render = (text: string, key: string) =>
      act(async () => {
        root.render(
          createElement(MarkdownDelegateProvider, {
            fileImages:
              kind === "fileImages"
                ? {
                    resolve,
                    labels: {
                      open: "Open",
                      loading: "Loading",
                      failed: "Failed",
                      dialog: "Image",
                      close: "Close",
                    },
                  }
                : undefined,
            children: createElement(MarkdownText, {
              key,
              text,
              labels,
              pathImages: kind === "pathImages" ? { resolve } : undefined,
            }),
          }),
        );
      });
    const image = () => container.querySelector<HTMLImageElement>('img[alt="local"]')!;
    try {
      await render(source, "first");
      const first = image().src;
      expect(new URL(first).searchParams.get("load")).toMatch(/^\d+$/);
      expect(new URL(first).searchParams.get("path")).toBe("/tmp/image.png");
      await render(source + "\n\nMore prose", "first");
      expect(image().src).toBe(first);
      await render(source, "second");
      expect(image().src).not.toBe(first);
      expect(container.querySelector<HTMLImageElement>('img[alt="remote"]')?.src).toBe(
        "https://example.com/image.png",
      );
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  },
);
