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
