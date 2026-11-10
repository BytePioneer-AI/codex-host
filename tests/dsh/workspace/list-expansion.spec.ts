// @vitest-environment jsdom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { SessionListExpansion } from "../../../apps/web-ui/packages/client/ui-workspace/src/client/rows/SessionListExpansion.tsx";
import { en, zh } from "../../../apps/web-ui/packages/client/ui-workspace/src/client/locales.ts";

type Props = ComponentProps<typeof SessionListExpansion>;
const mounted: Array<{ root: Root; container: HTMLElement }> = [];
afterEach(async () => {
  for (const { root, container } of mounted.splice(0)) {
    await act(async () => root.unmount());
    container.remove();
  }
  vi.unstubAllGlobals();
});

async function fixture(overrides: Partial<Props> = {}, dictionary = zh) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  const expand = vi.fn();
  const loadMoreSessions = vi.fn();
  const props: Props = {
    rowKey: "overflow:group",
    hiddenCount: 0,
    expand,
    loadMoreSessions,
    t: (key, params) => dictionary[key].replace("{n}", String(params?.n)),
    ...overrides,
  };
  const render = async (next: Partial<Props>) => {
    Object.assign(props, next);
    await act(async () => root.render(createElement(SessionListExpansion, props)));
  };
  await render({});
  return { container, expand, loadMoreSessions, render };
}

it("keeps the original inline label and reveals local rows without a catalog request", async () => {
  const f = await fixture({ hiddenCount: 4, hasMore: true });
  const button = f.container.querySelector("button")!;
  expect(button.textContent).toBe("展开显示");
  expect(button.dataset.rowKey).toBe("overflow:group");
  expect(f.loadMoreSessions).not.toHaveBeenCalled();
  await act(async () => button.click());
  expect(f.expand).toHaveBeenCalledOnce();
  expect(f.loadMoreSessions).not.toHaveBeenCalled();
});

it.each([zh, en])(
  "requests one page only after clicking the same inline action",
  async (dictionary) => {
    const f = await fixture({ hasMore: true }, dictionary);
    const button = f.container.querySelector("button")!;
    expect(button.textContent).toBe(dictionary["sessions.expandMore"]);
    expect(f.loadMoreSessions).not.toHaveBeenCalled();
    await act(async () => button.click());
    expect(f.expand).toHaveBeenCalledOnce();
    expect(f.loadMoreSessions).toHaveBeenCalledOnce();
    // A global page may contain no rows for this project: never drain further pages automatically.
    await f.render({ hasMore: true, hiddenCount: 0 });
    expect(f.loadMoreSessions).toHaveBeenCalledOnce();
  },
);

it("disables remote expansion during loading without another request", async () => {
  const f = await fixture({ hasMore: true, loading: true });
  const button = f.container.querySelector("button")!;
  expect(button.disabled).toBe(true);
  expect(button.textContent).toBe(zh["sessions.loading"]);
  await act(async () => button.click());
  expect(f.expand).not.toHaveBeenCalled();
  expect(f.loadMoreSessions).not.toHaveBeenCalled();
});

it("can still reveal local rows during an unrelated list request", async () => {
  const f = await fixture({ hiddenCount: 3, hasMore: true, loading: true });
  const button = f.container.querySelector("button")!;
  expect(button.disabled).toBe(false);
  await act(async () => button.click());
  expect(f.expand).toHaveBeenCalledOnce();
  expect(f.loadMoreSessions).not.toHaveBeenCalled();
});

it("returns to local expansion after receiving a page", async () => {
  const f = await fixture({ hasMore: true });
  await act(async () => f.container.querySelector("button")!.click());
  await f.render({ hiddenCount: 6, hasMore: false });
  await act(async () => f.container.querySelector("button")!.click());
  expect(f.expand).toHaveBeenCalledTimes(2);
  expect(f.loadMoreSessions).toHaveBeenCalledOnce();
});

it("retains the flat-list collapse action after the last page", async () => {
  const collapse = vi.fn();
  const f = await fixture({ collapse, expanded: true });
  const button = f.container.querySelector("button")!;
  expect(button.textContent).toBe("收起");
  expect(button.getAttribute("aria-expanded")).toBe("true");
  await act(async () => button.click());
  expect(collapse).toHaveBeenCalledOnce();
  expect(f.loadMoreSessions).not.toHaveBeenCalled();
});

it("does not leave an expansion row when nothing more can be shown", async () => {
  const f = await fixture();
  expect(f.container.querySelector("button")).toBeNull();
});
