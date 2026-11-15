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

it.each([
  { name: "en", locale: en },
  { name: "zh", locale: zh },
])("reveals and hides the QR code in place without opening a modal ($name)", ({ locale }) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  cleanups.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  const props: Props = {
    data: {
      secret: "test-token",
      lastUsedAt: null,
      networkUrls: [
        { kind: "lan", url: "http://192.168.1.2:4400/" },
        { kind: "tailscale", url: "http://100.64.0.1:4400/" },
      ],
      tailscale: { status: "not-installed" },
    },
    busy: false,
    restarting: false,
    onEnable: vi.fn(),
    onRelay: vi.fn(),
    onRefresh: vi.fn(),
    t: ((key: keyof typeof en) => locale[key]) as Props["t"],
  };
  act(() => root.render(createElement(ConnectionCard, props)));

  const qrButton = (): HTMLButtonElement => {
    const button = container.querySelector<HTMLButtonElement>("button[aria-pressed]");
    expect(button).not.toBeNull();
    return button!;
  };
  expect(qrButton().getAttribute("aria-label")).toBe(locale["connectDevices.viewQr"]);
  expect(qrButton().getAttribute("aria-pressed")).toBe("false");
  expect(qrButton().textContent).toContain(locale["connectDevices.viewQr"]);
  expect(qrButton().textContent).toContain(locale["connectDevices.qrSensitive"]);
  expect(document.querySelector('[role="dialog"]')).toBeNull();

  act(() => qrButton().click());
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(qrButton().getAttribute("aria-label")).toBe(locale["connectDevices.hideQr"]);
  expect(qrButton().getAttribute("aria-pressed")).toBe("true");
  expect(qrButton().textContent).toContain(locale["connectDevices.hideQr"]);
  expect(qrButton().textContent).not.toContain(locale["connectDevices.qrSensitive"]);
  expect(
    container.querySelector(`[role="img"][aria-label="${locale["connectDevices.qrLabel"]}"]`),
  ).not.toBeNull();

  act(() => qrButton().click());
  expect(qrButton().getAttribute("aria-label")).toBe(locale["connectDevices.viewQr"]);
  expect(qrButton().getAttribute("aria-pressed")).toBe("false");
  expect(qrButton().textContent).toContain(locale["connectDevices.qrSensitive"]);

  // Switching to a different connection method hides a previously revealed QR code.
  act(() => qrButton().click());
  expect(qrButton().getAttribute("aria-pressed")).toBe("true");
  act(() => {
    container
      .querySelector<HTMLInputElement>('[data-connect-route="lan"] input[type="radio"]')!
      .click();
  });
  expect(qrButton().getAttribute("aria-pressed")).toBe("false");
  expect(qrButton().getAttribute("aria-label")).toBe(locale["connectDevices.viewQr"]);
});
