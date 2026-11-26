// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  createDesktopExtensionHost,
  type DesktopExtensionEntry,
} from "../src/desktop-extension-host.js";
import type { DesktopExtensionBridge } from "../src/desktop-extension-api.js";
import {
  DESKTOP_EXTENSION_RAIL_CONTROL_ATTRIBUTE,
  DESKTOP_EXTENSION_RAIL_ICON_ONLY_ATTRIBUTE,
  DESKTOP_EXTENSION_RAIL_ITEM_ATTRIBUTE,
  DESKTOP_EXTENSION_RAIL_STYLE_ATTRIBUTE,
} from "../src/desktop-extension-rail.js";

const hosts: Array<ReturnType<typeof createDesktopExtensionHost>> = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.disposeAll();
  document.documentElement.lang = "";
  document.body.replaceChildren();
  document.head
    .querySelectorAll(`style[${DESKTOP_EXTENSION_RAIL_STYLE_ATTRIBUTE}]`)
    .forEach((el) => {
      el.remove();
    });
});

function createRailHarness() {
  const nav = document.createElement("nav");
  nav.setAttribute("data-app-navigation-rail", "");
  const column = document.createElement("div");
  const anchor = document.createElement("button");
  anchor.type = "button";
  anchor.setAttribute("data-sidebar-destination", "automations");
  column.append(anchor);
  nav.append(column);

  const outside = document.createElement("aside");
  document.body.append(nav, outside);

  const host = createDesktopExtensionHost(document);
  hosts.push(host);
  const bridge: DesktopExtensionBridge = {
    ready: () => true,
    sidebar: { rows: () => [], observe: () => () => undefined },
    watchTree: () => () => undefined,
    describe: () => undefined,
    openThread: vi.fn(),
  };
  host.bind(bridge);
  return { host, nav, column, anchor, outside };
}

function makeEntry(
  id: string,
  activate: Parameters<
    Parameters<NonNullable<DesktopExtensionEntry["defineScript"]>>[0]
  >[0]["activate"],
  name?: DesktopExtensionEntry["name"],
): DesktopExtensionEntry {
  return {
    id,
    hash: `${id}-hash`,
    slots: [],
    ...(name !== undefined ? { name } : {}),
    defineScript: (define) => define({ activate }),
  };
}

function createSvgIcon(): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M2 2h12v12H2z");
  svg.append(path);
  return svg;
}

it("marks rail-mounted icon buttons as icon-only, syncs post-mount labels, preserves anchor adjacency, and cleans up on unload", async () => {
  const { host, anchor } = createRailHarness();
  const button = document.createElement("button");
  button.type = "button";
  const label = document.createElement("span");
  const badge = document.createElement("small");
  badge.hidden = true;
  badge.textContent = "3";
  button.append(createSvgIcon(), label, badge);

  await host.reconcile([
    makeEntry(
      "althing",
      (api) => {
        api.dom.mount(button, anchor, "after");
        // Extensions like the-althing populate label text after mounting.
        label.textContent = "议事厅";
      },
      { en: "Althing", "zh-CN": "议事厅" },
    ),
  ]);

  expect(anchor.nextElementSibling).toBe(button);
  expect(
    document.head.querySelector(`style[${DESKTOP_EXTENSION_RAIL_STYLE_ATTRIBUTE}]`),
  ).not.toBeNull();
  expect(button.getAttribute(DESKTOP_EXTENSION_RAIL_ITEM_ATTRIBUTE)).toBe("althing");
  expect(button.hasAttribute(DESKTOP_EXTENSION_RAIL_CONTROL_ATTRIBUTE)).toBe(true);
  expect(button.getAttribute(DESKTOP_EXTENSION_RAIL_ICON_ONLY_ATTRIBUTE)).toBe("true");

  await vi.waitFor(() => {
    expect(button.getAttribute("title")).toBe("议事厅");
    expect(button.getAttribute("aria-label")).toBe("议事厅");
  });

  // Subsequent locale or badge text updates keep host-managed tooltip/aria-label synchronized.
  label.textContent = "Althing";
  await vi.waitFor(() => {
    expect(button.getAttribute("title")).toBe("Althing");
    expect(button.getAttribute("aria-label")).toBe("Althing");
  });

  await host.reconcile([]);
  expect(button.isConnected).toBe(false);
  expect(button.hasAttribute(DESKTOP_EXTENSION_RAIL_ITEM_ATTRIBUTE)).toBe(false);
  expect(button.hasAttribute(DESKTOP_EXTENSION_RAIL_CONTROL_ATTRIBUTE)).toBe(false);
  expect(button.hasAttribute(DESKTOP_EXTENSION_RAIL_ICON_ONLY_ATTRIBUTE)).toBe(false);
  expect(button.hasAttribute("title")).toBe(false);
  expect(button.hasAttribute("aria-label")).toBe(false);
  expect(
    document.head.querySelector(`style[${DESKTOP_EXTENSION_RAIL_STYLE_ATTRIBUTE}]`),
  ).toBeNull();
});

it("preserves explicit extension title/aria-label and falls back to graphic or localized manifest names", async () => {
  document.documentElement.lang = "zh-CN";
  const { host, column } = createRailHarness();

  const customTitled = document.createElement("button");
  customTitled.type = "button";
  customTitled.title = "Custom Tooltip";
  const customLabel = document.createElement("span");
  customLabel.textContent = "Visible Name";
  customTitled.append(createSvgIcon(), customLabel);

  const imgAltOnly = document.createElement("button");
  imgAltOnly.type = "button";
  const img = document.createElement("img");
  img.alt = "Graphic Alt";
  imgAltOnly.append(img);

  const manifestFallback = document.createElement("button");
  manifestFallback.type = "button";
  manifestFallback.append(createSvgIcon());

  await host.reconcile([
    makeEntry("custom", (api) => {
      api.dom.mount(customTitled, column, "append");
    }),
    makeEntry("graphic", (api) => {
      api.dom.mount(imgAltOnly, column, "append");
    }),
    makeEntry(
      "manifest",
      (api) => {
        api.dom.mount(manifestFallback, column, "append");
      },
      { en: "Council", "zh-CN": "本地名称" },
    ),
  ]);

  expect(customTitled.getAttribute("title")).toBe("Custom Tooltip");
  expect(customTitled.getAttribute("aria-label")).toBe("Visible Name");

  expect(imgAltOnly.getAttribute("title")).toBe("Graphic Alt");
  expect(imgAltOnly.getAttribute("aria-label")).toBe("Graphic Alt");

  expect(manifestFallback.getAttribute("title")).toBe("本地名称");
  expect(manifestFallback.getAttribute("aria-label")).toBe("本地名称");

  await host.reconcile([]);
  // Explicit extension title is preserved on cleanup while host-managed aria-label is removed.
  expect(customTitled.getAttribute("title")).toBe("Custom Tooltip");
  expect(customTitled.hasAttribute("aria-label")).toBe(false);
});

it("handles wrapper containers, multi-button groups, and text-only buttons in the rail", async () => {
  const { host, column } = createRailHarness();

  const siblingWrapper = document.createElement("div");
  const wrappedButton = document.createElement("button");
  wrappedButton.type = "button";
  wrappedButton.append(createSvgIcon());
  const externalLabel = document.createElement("span");
  externalLabel.textContent = "Sibling Label";
  siblingWrapper.append(wrappedButton, externalLabel);

  const multiWrapper = document.createElement("div");
  const firstBtn = document.createElement("button");
  const firstText = document.createElement("span");
  firstText.textContent = "First Action";
  firstBtn.append(createSvgIcon(), firstText);
  const secondBtn = document.createElement("button");
  const secondText = document.createElement("span");
  secondText.textContent = "Second Action";
  secondBtn.append(createSvgIcon(), secondText);
  multiWrapper.append(firstBtn, secondBtn);

  const textOnlyButton = document.createElement("button");
  textOnlyButton.type = "button";
  const onlyText = document.createElement("span");
  onlyText.textContent = "Text Only";
  textOnlyButton.append(onlyText);

  await host.reconcile([
    makeEntry("wrapped", (api) => {
      api.dom.mount(siblingWrapper, column, "append");
      api.dom.mount(multiWrapper, column, "append");
      api.dom.mount(textOnlyButton, column, "append");
    }),
  ]);

  expect(siblingWrapper.getAttribute(DESKTOP_EXTENSION_RAIL_ITEM_ATTRIBUTE)).toBe("wrapped");
  expect(siblingWrapper.hasAttribute(DESKTOP_EXTENSION_RAIL_CONTROL_ATTRIBUTE)).toBe(false);
  expect(wrappedButton.hasAttribute(DESKTOP_EXTENSION_RAIL_CONTROL_ATTRIBUTE)).toBe(true);
  expect(wrappedButton.getAttribute(DESKTOP_EXTENSION_RAIL_ICON_ONLY_ATTRIBUTE)).toBe("true");
  expect(wrappedButton.getAttribute("title")).toBe("Sibling Label");
  expect(wrappedButton.getAttribute("aria-label")).toBe("Sibling Label");

  expect(firstBtn.hasAttribute(DESKTOP_EXTENSION_RAIL_CONTROL_ATTRIBUTE)).toBe(true);
  expect(firstBtn.getAttribute("title")).toBe("First Action");
  expect(secondBtn.hasAttribute(DESKTOP_EXTENSION_RAIL_CONTROL_ATTRIBUTE)).toBe(true);
  expect(secondBtn.getAttribute("title")).toBe("Second Action");

  expect(textOnlyButton.hasAttribute(DESKTOP_EXTENSION_RAIL_CONTROL_ATTRIBUTE)).toBe(true);
  expect(textOnlyButton.hasAttribute(DESKTOP_EXTENSION_RAIL_ICON_ONLY_ATTRIBUTE)).toBe(false);
  expect(textOnlyButton.getAttribute("title")).toBe("Text Only");
  expect(textOnlyButton.getAttribute("aria-label")).toBe("Text Only");
});

it("leaves mounts outside the navigation rail untouched and restores attributes when moved out of the rail", async () => {
  const { host, column, outside } = createRailHarness();
  const outsideButton = document.createElement("button");
  outsideButton.textContent = "Sidebar Item";

  const movableButton = document.createElement("button");
  const movableLabel = document.createElement("span");
  movableLabel.textContent = "Movable";
  movableButton.append(createSvgIcon(), movableLabel);

  let capturedApi: { dom: { mount: (n: Element, p: Element, pos?: "append") => void } } | undefined;

  await host.reconcile([
    makeEntry("outside-only", (api) => {
      api.dom.mount(outsideButton, outside, "append");
    }),
  ]);

  expect(outsideButton.hasAttribute(DESKTOP_EXTENSION_RAIL_ITEM_ATTRIBUTE)).toBe(false);
  expect(outsideButton.hasAttribute("title")).toBe(false);
  expect(
    document.head.querySelector(`style[${DESKTOP_EXTENSION_RAIL_STYLE_ATTRIBUTE}]`),
  ).toBeNull();

  await host.reconcile([
    makeEntry("mover", (api) => {
      capturedApi = api;
      api.dom.mount(movableButton, column, "append");
    }),
  ]);

  expect(movableButton.getAttribute(DESKTOP_EXTENSION_RAIL_ITEM_ATTRIBUTE)).toBe("mover");
  expect(movableButton.getAttribute("title")).toBe("Movable");
  expect(
    document.head.querySelector(`style[${DESKTOP_EXTENSION_RAIL_STYLE_ATTRIBUTE}]`),
  ).not.toBeNull();

  capturedApi?.dom.mount(movableButton, outside, "append");
  expect(movableButton.hasAttribute(DESKTOP_EXTENSION_RAIL_ITEM_ATTRIBUTE)).toBe(false);
  expect(movableButton.hasAttribute(DESKTOP_EXTENSION_RAIL_CONTROL_ATTRIBUTE)).toBe(false);
  expect(movableButton.hasAttribute(DESKTOP_EXTENSION_RAIL_ICON_ONLY_ATTRIBUTE)).toBe(false);
  expect(movableButton.hasAttribute("title")).toBe(false);
  expect(movableButton.hasAttribute("aria-label")).toBe(false);
  expect(
    document.head.querySelector(`style[${DESKTOP_EXTENSION_RAIL_STYLE_ATTRIBUTE}]`),
  ).toBeNull();
});
