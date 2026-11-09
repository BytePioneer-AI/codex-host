// @vitest-environment jsdom
import { act, createElement, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { TabId } from "@deepseek-ai/dsh-client-ui-dockkit";
import {
  TextPreview,
  type TextPreviewProps,
} from "../../../apps/web-ui/packages/client/ui-sidebar-documentpreview/src/client/TextPreview.tsx";
import { createTextStore } from "../../../apps/web-ui/packages/client/ui-sidebar-documentpreview/src/client/store.ts";
import { TextBody } from "../../../apps/web-ui/packages/client/ui-sidebar-documentpreview/src/client/text/TextBody.tsx";
import { textBodyDefinition } from "../../../apps/web-ui/packages/client/ui-sidebar-documentpreview/src/client/text/index.ts";
import type { DocumentPreviewProps } from "../../../apps/web-ui/packages/client/ui-sidebar-documentpreview/src/client/document/contract.ts";

const TAB = "tab" as TabId;
const cleanup: Array<() => void> = [];
afterEach(() => {
  cleanup.splice(0).forEach((dispose) => dispose());
  vi.unstubAllGlobals();
});

async function harness(sourceLines = true, line?: number, drawSourceLines = sourceLines) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const store = createTextStore().create();
  const loadPage = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  cleanup.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  const definition = { ...textBodyDefinition(() => "Text"), sourceLines };
  const navigation = { revision: 1, params: line === undefined ? undefined : { line } };
  const useTabInfo = () => ({
    tab: {
      id: TAB,
      contentId: "dsh-resource://file/session/s-1/notes.txt",
      navigation,
      signal: new AbortController().signal,
      actions: { bindCommands: () => () => {} },
    },
  });
  const props = {
    useTabInfo,
    useResource: () => ({ status: "live", value: { version: "v1", absolutePath: "/notes.txt" } }),
    useStore: (select: (state: ReturnType<typeof store.getSnapshot>) => unknown) =>
      select(useSyncExternalStore(store.subscribe, store.getSnapshot)),
    actions: store.actions,
    loadPage,
    loadAll: vi.fn(),
    reloadAll: vi.fn(),
    reloadPages: vi.fn(),
    prepareRenderer: vi.fn(),
    addResource: vi.fn(),
    setResources: vi.fn(),
    useDocumentPreviews: () => [definition],
    renderSlot: (key: string, owner: DocumentPreviewProps) => {
      if (key !== "sidebar.right.tab.document") return null;
      if (drawSourceLines)
        return createElement(TextBody, { ...owner, useTabInfo } as DocumentPreviewProps);
      return createElement(
        "div",
        null,
        owner.content.kind === "text"
          ? owner.content.text
              .split("\n")
              .map((text, index) =>
                createElement("div", { key: index, "data-rendered-line": "" }, text),
              )
          : null,
      );
    },
    t: (key: string) => key,
  } as unknown as TextPreviewProps;
  function page(offset: number, count: number, eof: boolean) {
    store.actions.page(TAB, {
      absolutePath: "/notes.txt",
      version: "v1",
      offset,
      lines: count,
      eof,
      bytes: count * 10,
      text: Array.from({ length: count }, (_, index) => `line ${offset + index}`).join("\n"),
    });
  }
  page(1, 20, true);
  await act(async () => root.render(createElement(TextPreview, props)));
  const body = container.querySelector<HTMLElement>("[data-textpreview-body]");
  if (!body) throw new Error("missing preview body");
  // Like upstream's regression fixture, emulate browser clamping in jsdom.
  const max = () =>
    Math.max(
      0,
      body.querySelectorAll("[data-textpreview-line], [data-rendered-line]").length * 20 - 100,
    );
  let top = 0;
  Object.defineProperties(body, {
    clientHeight: { configurable: true, get: () => 100 },
    scrollHeight: { configurable: true, get: () => max() + 100 },
    scrollTop: {
      configurable: true,
      get: () => {
        top = Math.min(top, max());
        return top;
      },
      set: (value: number) => {
        top = Math.max(0, Math.min(value, max()));
      },
    },
  });
  const scroll = (value?: number) =>
    act(() => {
      if (value !== undefined) body.scrollTop = value;
      body.dispatchEvent(new Event("scroll"));
    });
  return { store, page, body, scroll, loadPage, definition };
}

it("preserves the remembered offset while empty and reads beyond the first refreshed page", async () => {
  const h = await harness();
  h.scroll(300);
  act(() => {
    h.store.actions.reset(TAB);
    h.store.actions.loading(TAB);
  });
  expect(h.body.scrollTop).toBe(0);
  h.scroll();
  expect(h.store.getSnapshot().byTab[TAB]?.scrollTop).toBe(300);
  await act(async () => h.page(1, 10, false));
  expect(h.loadPage).toHaveBeenLastCalledWith(
    TAB,
    { sessionId: "s-1", path: "notes.txt" },
    11,
    expect.any(AbortSignal),
    "v1",
  );
  await act(async () => h.page(11, 10, true));
  expect(h.body.scrollTop).toBe(300);
});

it("remembers an unreachable offset at EOF and restores it when content grows again", async () => {
  const h = await harness();
  h.scroll(300);
  await act(async () => {
    h.store.actions.reset(TAB);
    h.page(1, 10, true);
  });
  h.scroll();
  expect(h.body.scrollTop).toBe(100);
  expect(h.store.getSnapshot().byTab[TAB]?.scrollTop).toBe(300);
  expect(h.loadPage).not.toHaveBeenCalled();
  await act(async () => {
    h.store.actions.reset(TAB);
    h.page(1, 20, true);
  });
  expect(h.body.scrollTop).toBe(300);
});

it("keeps deliberate upward scrolling instead of restoring the old offset", async () => {
  const h = await harness();
  h.scroll(300);
  h.scroll(120);
  expect(h.store.getSnapshot().byTab[TAB]?.scrollTop).toBe(120);
  act(() => {
    h.store.actions.reset(TAB);
    h.store.actions.loading(TAB);
  });
  h.scroll();
  await act(async () => h.page(1, 20, true));
  expect(h.body.scrollTop).toBe(120);
});

it("does not load further pages after a read failure", async () => {
  const h = await harness();
  h.scroll(300);
  await act(async () => {
    h.store.actions.reset(TAB);
    h.page(1, 10, false);
    h.store.actions.failed(TAB, { code: "workspace-file/not-found", message: "missing" } as never);
  });
  expect(h.loadPage).not.toHaveBeenCalled();
});

it("answers source-line navigation in renderers without source lines, without moving", async () => {
  const h = await harness(false, 10);
  expect(h.store.getSnapshot().byTab[TAB]?.revision).toBe(1);
  h.scroll(120);
  await act(async () => {
    h.store.actions.reset(TAB);
    h.page(1, 20, true);
  });
  expect(h.body.scrollTop).toBe(120);
});

it("keeps source-line navigation pending until its renderer exposes the target", async () => {
  const h = await harness(true, 10, false);
  expect(h.store.getSnapshot().byTab[TAB]?.revision).toBeUndefined();
});

it("does not move a live viewport backwards when another page arrives", async () => {
  const h = await harness();
  h.scroll(120);
  h.body.scrollTop = 220;
  await act(async () => h.page(21, 10, true));
  expect(h.body.scrollTop).toBe(220);
});

it("does not duplicate a page read already in flight", async () => {
  const h = await harness();
  h.scroll(300);
  await act(async () => {
    h.store.actions.reset(TAB);
    h.page(1, 10, false);
    h.store.actions.loading(TAB);
  });
  expect(h.loadPage).not.toHaveBeenCalled();
});

it("declares source-line navigation for the built-in plain-text renderer", () => {
  expect(textBodyDefinition(() => "Text")).toMatchObject({ sourceLines: true });
});
