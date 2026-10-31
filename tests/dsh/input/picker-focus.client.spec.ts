// @vitest-environment jsdom
import { act, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { createSnapshotStore } from "@deepseek-ai/dsh-client-store";
import { ModelSelect } from "../../../apps/web-ui/packages/client/ui-model-selection/src/client/ModelSelect.tsx";
import type { ModelDirectoryState } from "../../../apps/web-ui/packages/client/ui-model-selection/src/client/directory.ts";
import { PopupSelectController } from "../../../apps/web-ui/packages/client/ui-commands/src/client/popup.ts";
import { PopupSelectView } from "../../../apps/web-ui/packages/client/ui-commands/src/client/PopupSelectView.tsx";

const devices = [
  {
    name: "iPhone",
    automatic: false,
    platform: "iPhone",
    maxTouchPoints: 5,
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 Version/18.6 Mobile/15E148 Safari/604.1",
  },
  {
    name: "desktop iPad",
    automatic: false,
    platform: "MacIntel",
    maxTouchPoints: 5,
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.6 Safari/605.1.15",
  },
  {
    name: "Mac",
    automatic: true,
    platform: "MacIntel",
    maxTouchPoints: 0,
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.6 Safari/605.1.15",
  },
];
const cleanups: Array<() => void> = [];
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: () => {},
  });
  cleanups.push(() => {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", descriptor);
    else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  });
});
afterEach(() => {
  cleanups
    .reverse()
    .splice(0)
    .forEach((dispose) => dispose());
  vi.unstubAllGlobals();
});
function device(profile: (typeof devices)[number]) {
  for (const name of ["userAgent", "platform", "maxTouchPoints"] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(navigator, name);
    Object.defineProperty(navigator, name, { configurable: true, value: profile[name] });
    onTestFinished(() => {
      if (descriptor) Object.defineProperty(navigator, name, descriptor);
      else Reflect.deleteProperty(navigator, name);
    });
  }
}
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
function required<T extends HTMLElement>(selector: string, root: ParentNode = document): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`Missing ${selector}`);
  return element;
}
async function click(element: HTMLElement) {
  await act(async () => element.click());
}
async function key(element: HTMLElement, key: string) {
  await act(async () =>
    element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })),
  );
}
function state(count: number, selected = true): ModelDirectoryState {
  return {
    current: selected ? { provider: "test", model: "m0" } : null,
    routable: true,
    boundHarnessId: null,
    harnesses: [],
    failures: [],
    status: "ready",
    pending: null,
    error: null,
    groups: [
      {
        id: "test",
        name: "Test",
        models: Array.from({ length: count }, (_, index) => ({
          id: `m${index}`,
          name: `Model ${index}`,
        })),
      },
    ],
  };
}
async function model(count: number, selected = true) {
  const directory = createSnapshotStore(state(count, selected));
  const select = vi.fn(async () => ({ ok: true as const, value: undefined }));
  const container = await mount(
    createElement(ModelSelect, {
      locked: false,
      available: true,
      directory,
      load: vi.fn(),
      select,
      t: (key: string) => key,
    }),
  );
  const trigger = required<HTMLButtonElement>("button", container);
  await click(trigger);
  return { trigger, directory, select };
}

it.each(
  devices.flatMap((profile) =>
    [1, 5].flatMap((count) => [true, false].map((selected) => ({ ...profile, count, selected }))),
  ),
)("keeps $name model navigation usable with $count models, current=$selected", async (profile) => {
  device(profile);
  const h = await model(profile.count, profile.selected);
  if (profile.selected) {
    expect(document.activeElement).toBe(h.trigger);
    await click(required('[role="menuitem"][aria-expanded]'));
  }
  const row = required<HTMLButtonElement>('[role="menuitemradio"]');
  const search = document.querySelector<HTMLInputElement>('[role="searchbox"]');
  expect(document.activeElement).toBe(profile.automatic && search ? search : row);
  if (search) {
    // Hardware-keyboard search entry is explicit even on phones and tablets.
    await key(row, "ArrowDown");
    expect(document.activeElement).toBe(search);
  }
  await key(required<HTMLElement>(":focus"), "Escape");
  if (profile.selected) {
    expect(document.activeElement).toBe(required('[role="menuitem"][aria-expanded]'));
    await key(required<HTMLElement>(":focus"), "Escape");
  }
  expect(h.trigger.getAttribute("aria-expanded")).toBe("false");
  expect(document.activeElement).toBe(h.trigger);
  expect(h.select).not.toHaveBeenCalled();
});

it("does not auto-focus mobile search when the catalog grows or an already visible sibling is clicked", async () => {
  device(devices[0]);
  const h = await model(1);
  const cell = required('[role="menuitem"][aria-expanded]');
  await click(cell);
  await act(async () => h.directory.set(state(5)));
  const search = required<HTMLInputElement>('[role="searchbox"]');
  expect(document.activeElement).not.toBe(search);
  await click(cell);
  expect(document.activeElement).toBe(required('[role="menuitemradio"][aria-checked="true"]'));
  await act(async () => search.focus());
  expect(document.activeElement).toBe(search);
  // Choosing a row still closes the menu and returns focus to its trigger.
  await click(required('[role="menuitemradio"][aria-checked="true"]'));
  expect(document.activeElement).toBe(h.trigger);
  expect(h.trigger.getAttribute("aria-expanded")).toBe("false");
});

it.each(devices)(
  "respects $name command search policy on open and reopen, preserving explicit entry",
  async (profile) => {
    device(profile);
    const outside = document.createElement("button");
    document.body.append(outside);
    outside.focus();
    cleanups.push(() => outside.remove());
    const focusComposer = vi.fn();
    const popup = new PopupSelectController({ consume: () => true, focusComposer });
    const spec = {
      options: async () => [
        { id: "a", label: "Alpha" },
        { id: "b", label: "Beta" },
      ],
      onSelect: vi.fn(),
    };
    await mount(createElement(PopupSelectView, { popup, t: (key: string) => key }));
    for (let index = 0; index < 2; index++) {
      await act(async () => {
        outside.focus();
        popup.open("test", spec, {}, { via: "enter", token: "/test" });
      });
      const search = required<HTMLInputElement>('input[aria-label="search.aria"]');
      expect(document.activeElement).toBe(profile.automatic ? search : outside);
      await act(async () => search.focus());
      await key(search, "ArrowDown");
      expect(popup.state.getSnapshot().active).toBe(1);
      await key(search, "Escape");
      expect(popup.state.getSnapshot().open).toBe(false);
    }
    expect(focusComposer).toHaveBeenCalledTimes(2);
  },
);
