// @vitest-environment jsdom
import { act, createElement, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ConnectionCard } from "../../../apps/web-ui/packages/client/ui-codexhost/src/client/ConnectionCard.tsx";
import { en, zh } from "../../../apps/web-ui/packages/client/ui-codexhost/src/client/locales.ts";

type Props = ComponentProps<typeof ConnectionCard>;
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.unstubAllGlobals();
});

it.each([
  { locale: en, official: "Official encrypted relay", selfHosted: "Self-hosted encrypted relay" },
  { locale: zh, official: "官方加密中转", selfHosted: "自建加密中转" },
])("orders connection methods with $official first", ({ locale, official, selfHosted }) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  cleanups.push(() => act(() => root.unmount()));
  const props: Props = {
    data: {
      secret: "test-token",
      lastUsedAt: null,
      networkUrls: [],
      tailscale: { status: "not-installed" },
      relay: {
        kind: "official",
        enabled: true,
        officialHost: "relay.chost.dev",
        state: { status: "connecting" },
      },
    },
    busy: false,
    restarting: false,
    onEnable: vi.fn(),
    onRelay: vi.fn(),
    onRefresh: vi.fn(),
    t: ((key: keyof typeof en) => locale[key]) as Props["t"],
  };
  act(() => root.render(createElement(ConnectionCard, props)));
  const routes = [...container.querySelectorAll("[data-connect-route]")];
  expect(routes.map((route) => route.getAttribute("data-connect-route"))).toEqual([
    "relay",
    "self-hosted-relay",
    "tailscale-https",
    "lan",
  ]);
  expect(routes[0].textContent).toContain(official);
  expect(routes[1].textContent).toContain(selfHosted);
  expect(routes[0].textContent).toContain(locale["connectDevices.relay.inUse"]);
  expect(routes[0].textContent).not.toMatch(/推荐|Recommended/u);
  expect(routes[2].textContent).not.toMatch(/推荐|Recommended/u);
  expect(routes[0].querySelector<HTMLInputElement>("input")!.checked).toBe(true);
  expect(props.onRelay).not.toHaveBeenCalled();
});
