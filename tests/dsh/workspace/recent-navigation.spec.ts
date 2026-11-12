// @vitest-environment jsdom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { SessionId } from "@deepseek-ai/dsh-session/types";
import { RecentShortcuts } from "../../../apps/web-ui/packages/client/ui-workspace/src/client/RecentNavigation.tsx";
import { en, zh } from "../../../apps/web-ui/packages/client/ui-workspace/src/client/locales.ts";

type Props = ComponentProps<typeof RecentShortcuts>;
const mounted: Array<{ root: Root; container: HTMLElement }> = [];
afterEach(async () => {
  for (const { root, container } of mounted.splice(0)) {
    await act(async () => root.unmount());
    container.remove();
  }
  vi.unstubAllGlobals();
});

async function fixture(count: number, dictionary = zh) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  const ids = Array.from({ length: count }, (_, i) => SessionId(`session-${i}`));
  const visits = ids.map((sessionId) => ({ sessionId, target: sessionId, lastVisitedAt: 1 }));
  const list = {
    ids,
    byId: Object.fromEntries(
      ids.map((id) => [
        id,
        {
          id,
          displayTitle: id,
          blank: false,
          running: false,
          updatedAt: 1,
          retainedBy: {},
        },
      ]),
    ),
    projectionsBySession: {},
  };
  const closeAll = vi.fn();
  const close = vi.fn();
  const open = vi.fn();
  const restoreNavigationFocus = vi.fn();
  const props = {
    sessionId: ids[0],
    useVisits: (select) => select(visits),
    useSessions: (select) => select(list),
    useWorkspaces: (select) => select({ archivedSessionIds: [] }),
    useSessionStatus: (select) => select(new Map()),
    useRecentNavigationSettings: (select) => select({ value: { showRecentVisits: true } }),
    viewport: { scrollLeft: 0 },
    closeAll,
    close,
    open,
    restoreNavigationFocus,
    renderSlot: () => null,
    t: (key) => dictionary[key],
  } as Props;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => root.render(createElement(RecentShortcuts, props)));
  return { container, closeAll, close, open, restoreNavigationFocus };
}

it.each([0, 1, 2])("does not show clear for %i tabs", async (count) => {
  const f = await fixture(count);
  expect(f.container.querySelector(`[aria-label="${zh["recent.clearAll"]}"]`)).toBeNull();
});

it.each([
  [3, zh],
  [3, en],
  [4, zh],
  [4, en],
] as const)("places the small clear action after %i tabs", async (count, dictionary) => {
  const f = await fixture(count, dictionary);
  const strip = f.container.querySelector("nav")!;
  const button = strip.lastElementChild as HTMLButtonElement;
  expect(button.textContent).toBe(dictionary["recent.clear"]);
  expect(button.getAttribute("aria-label")).toBe(dictionary["recent.clearAll"]);
  expect(button.title).toBe(dictionary["recent.clearAllHint"]);
  await act(async () => button.click());
  expect(f.restoreNavigationFocus).toHaveBeenCalledOnce();
  expect(f.closeAll).toHaveBeenCalledOnce();
  expect(f.close).not.toHaveBeenCalled();
  expect(f.open).not.toHaveBeenCalled();
});
