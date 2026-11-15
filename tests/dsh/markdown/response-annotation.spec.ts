// @vitest-environment jsdom
import { act, createElement } from "react";
import type { ComponentProps, ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MarkdownText } from "../../../apps/web-ui/packages/client/ui-primitives/src/markdown/MarkdownText.tsx";
import type { MarkdownResponseAnnotations } from "../../../apps/web-ui/packages/client/ui-primitives/src/markdown/MarkdownText.tsx";

const cleanups: Array<() => void> = [];
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(() => {
  cleanups
    .splice(0)
    .reverse()
    .forEach((dispose) => dispose());
  vi.unstubAllGlobals();
});

const labels = {
  code: { copyLabel: "Copy", copiedLabel: "Copied" },
  footnotes: "Footnotes",
};

const annotationLabels = {
  label: (index: number) => `Annotation ${String(index)}`,
  railLabel: (index: number) => `${String(index)}.`,
  railTitle: (index: number, excerpt: string) => `Annotation ${String(index)}: ${excerpt}`,
  remove: (index: number) => `Remove annotation ${String(index)}`,
  selectedText: "Selected text:",
  userComment: "Your comment:",
};

const OWNER: MarkdownResponseAnnotations = {
  labels: annotationLabels,
  resolve: (index) =>
    ({ 1: { text: "keep the drain loop" }, 2: { text: "drop the retry", annotation: "why?" } })[
      index
    ],
};

async function mount(element: ReactElement) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  cleanups.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  await act(async () => root.render(element));
  return container;
}

function renderMarkdown(
  text: string,
  responseAnnotations: MarkdownResponseAnnotations | null = OWNER,
  streaming = false,
) {
  return mount(
    createElement(MarkdownText, {
      text,
      labels,
      streaming,
      ...(responseAnnotations === null ? {} : { responseAnnotations }),
    } as ComponentProps<typeof MarkdownText>),
  );
}

it("renders the bare directive in prose as the annotation label", async () => {
  const container = await renderMarkdown(
    'A :codex-annotation{index="1"}, B :codex-annotation{index="2"}.',
  );
  const buttons = [...container.querySelectorAll("[aria-expanded]")];
  expect(buttons.map((button) => button.textContent)).toEqual(["Annotation 1", "Annotation 2"]);
  await act(async () => buttons[0]?.click());
  const card = document.querySelector("[role='dialog']");
  expect(card?.textContent).toContain("Selected text:");
  expect(card?.textContent).toContain("keep the drain loop");
});

it("resolves the same directive while the reply is streaming", async () => {
  const container = await renderMarkdown('See :codex-annotation{index="2"} here.', OWNER, true);
  expect(container.querySelector("[aria-expanded]")?.textContent).toBe("Annotation 2");
});

it("keeps a backticked directive as code, as Desktop does", async () => {
  const container = await renderMarkdown('See `:codex-annotation{index="1"}` here.');
  expect(container.querySelector("[aria-expanded]")).toBeNull();
  expect(container.querySelector("code")?.textContent).toBe(':codex-annotation{index="1"}');
});

it("keeps a fenced directive and other code literal", async () => {
  const container = await renderMarkdown(
    ["```text", ':codex-annotation{index="1"}', "```", "", "Run `npm run build`."].join("\n"),
  );
  expect(container.querySelector("[aria-expanded]")).toBeNull();
  expect(container.textContent).toContain(':codex-annotation{index="1"}');
  expect(container.textContent).toContain("npm run build");
});

it("renders nothing for an index this Turn no longer resolves", async () => {
  const container = await renderMarkdown('Gone :codex-annotation{index="9"} here.');
  expect(container.querySelector("button")).toBeNull();
  expect(container.textContent).toBe("Gone  here.");
});

it("renders nothing when the surface carries no annotations to resolve", async () => {
  const container = await renderMarkdown('Gone :codex-annotation{index="1"} here.', null);
  expect(container.querySelector("[aria-expanded]")).toBeNull();
  expect(container.textContent).toBe("Gone  here.");
});

it("draws nothing for a directive whose index is not canonical", async () => {
  // Desktop recognizes these as directives too; its handler then refuses a
  // position that is not a canonical positive integer, so nothing is drawn.
  const container = await renderMarkdown(
    'A :codex-annotation{index="01"}, B :codex-annotation{index="0"}.',
  );
  expect(container.querySelector("[aria-expanded]")).toBeNull();
  expect(container.textContent).toBe("A , B .");
});

it("keeps an escaped directive as the text the user wrote", async () => {
  const container = await renderMarkdown('Escaped \\:codex-annotation{index="1"}');
  expect(container.querySelector("[aria-expanded]")).toBeNull();
  expect(container.textContent).toBe('Escaped :codex-annotation{index="1"}');
});

it("keeps an anchored directive's text instead of dropping it", async () => {
  const container = await renderMarkdown(
    '[Keep :codex-annotation{index="1"} label](https://example.com)',
  );
  const anchor = container.querySelector("a");
  expect(anchor?.textContent).toBe("Keep Annotation 1 label");
  expect(anchor?.querySelector("[aria-expanded]")).toBeNull();
});

it.each([false, true])(
  "consumes directive labels and consecutive attributes (streaming=%s)",
  async (streaming) => {
    const container = await renderMarkdown(
      ':codex-annotation[explanation]{index="1"} tail :codex-annotation{index="1"}{ index="2"} tail',
      OWNER,
      streaming,
    );
    const buttons = [...container.querySelectorAll<HTMLElement>("[aria-expanded]")];
    expect(buttons.map((button) => button.textContent)).toEqual(["Annotation 1", "Annotation 2"]);
    expect(container.textContent).toBe("Annotation 1 tail Annotation 2 tail");
    await act(async () => buttons[1]?.click());
    expect(document.querySelector("[role='dialog']")?.textContent).toContain("drop the retry");
  },
);
