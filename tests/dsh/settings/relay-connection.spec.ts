// @vitest-environment jsdom
import { act, createElement, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import {
  RelayControl,
  relayPreparing,
} from "../../../apps/web-ui/packages/client/ui-codexhost/src/client/RelayControl.tsx";
import { en } from "../../../apps/web-ui/packages/client/ui-codexhost/src/client/locales.ts";

type Props = ComponentProps<typeof RelayControl>;
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.unstubAllGlobals();
});

it("accepts a phone name and base domain, derives the relay host, and validates both fields", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  cleanups.push(() => act(() => root.unmount()));
  const onChange = vi.fn();
  const props = {
    kind: "self-hosted",
    relay: {
      kind: "official",
      enabled: false,
      officialHost: "relay.chost.dev",
      officialHostname: "alice.chost.dev",
      state: { status: "off" },
    },
    busy: false,
    onChange,
    onRefresh: vi.fn(),
    t: (key: keyof typeof en, args?: { host?: string }) =>
      en[key].replace("{host}", args?.host ?? ""),
  } as Props;
  act(() => root.render(createElement(RelayControl, props)));
  const name = [...container.querySelectorAll("label")]
    .find((label) => label.textContent?.startsWith("Device name"))!
    .querySelector("input")!;
  const domain = [...container.querySelectorAll("label")]
    .find((label) => label.textContent?.startsWith("Relay domain"))!
    .querySelector("input")!;
  const button = container.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  const fill = (input: HTMLInputElement, value: string) =>
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  expect(button.disabled).toBe(true);
  fill(name, "mycomputer");
  fill(domain, "EXAMPLE.COM");
  expect(domain.value).toBe("example.com");
  expect(container.textContent).toContain("Relay server address: relay.example.com");
  expect(button.disabled).toBe(false);
  act(() =>
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  expect(onChange).toHaveBeenCalledWith(true, {
    kind: "self-hosted",
    name: "mycomputer",
    host: "relay.example.com",
  });
  fill(name, "relay");
  expect(button.disabled).toBe(true);
  fill(name, "a.b");
  expect(button.disabled).toBe(true);
  fill(name, "");
  expect(button.disabled).toBe(false);
  fill(domain, "https://example.com");
  expect(button.disabled).toBe(true);
});

it("hides official registration inputs when its address is saved and the current kind is self-hosted", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  cleanups.push(() => act(() => root.unmount()));
  const onChange = vi.fn();
  const props = {
    kind: "official",
    relay: {
      kind: "self-hosted",
      enabled: false,
      officialHost: "relay.chost.dev",
      officialHostname: "alice.chost.dev",
      customHost: "relay.example.com",
      customHostname: "computer.example.com",
      state: { status: "off" },
    },
    busy: false,
    onChange,
    onRefresh: vi.fn(),
    t: (key: keyof typeof en) => en[key],
  } as Props;
  act(() => root.render(createElement(RelayControl, props)));
  expect(container.querySelectorAll("input")).toHaveLength(0);
  expect(container.textContent).not.toContain(en["connectDevices.relay.name"]);
  expect(container.textContent).not.toContain(en["connectDevices.relay.inviteLabel"]);
  expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(false);
  act(() =>
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  expect(onChange).toHaveBeenCalledWith(true, { kind: "official" });
});

it("distinguishes first preparation from an unreachable relay and clears the warning on recovery", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  cleanups.push(() => act(() => root.unmount()));
  const props = {
    kind: "self-hosted",
    relay: {
      kind: "self-hosted",
      enabled: true,
      officialHost: "relay.chost.dev",
      customHost: "relay.example.com",
      state: { status: "connecting" },
    },
    busy: false,
    onChange: vi.fn(),
    onRefresh: vi.fn(),
    t: (key: keyof typeof en) => en[key],
  } as Props;
  const render = (state: Props["relay"]["state"]) => {
    act(() =>
      root.render(createElement(RelayControl, { ...props, relay: { ...props.relay, state } })),
    );
  };

  render({ status: "connecting" });
  expect(container.textContent).toContain(en["connectDevices.relay.preparing"]);
  expect(relayPreparing({ status: "connecting" })).toBe(true);

  render({ status: "connecting", reason: "unreachable" });
  expect(container.textContent).toContain(en["connectDevices.relay.connectionFailed"]);
  expect(container.textContent).not.toContain(en["connectDevices.relay.preparing"]);
  expect(relayPreparing({ status: "connecting", reason: "unreachable" })).toBe(true);

  render({ status: "connecting", reason: "full" });
  expect(container.textContent).toContain(en["connectDevices.relay.full"]);

  render({
    status: "connected",
    url: "https://computer.example.com/",
    certificate: { issuing: false },
  });
  expect(container.textContent).not.toContain(en["connectDevices.relay.connectionFailed"]);
  expect(container.textContent).not.toContain(en["connectDevices.relay.preparing"]);
});
