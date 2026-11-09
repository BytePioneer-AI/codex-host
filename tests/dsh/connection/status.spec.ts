// @vitest-environment jsdom
import { act, createElement, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { createSnapshotStore } from "@deepseek-ai/dsh-client-store";
import type { ConnectionState } from "@deepseek-ai/dsh-client-connection/client";
import { HostConnectionStatus } from "../../../apps/web-ui/packages/client/ui-codexhost/src/client/HostConnectionStatus.tsx";
import { en } from "../../../apps/web-ui/packages/client/ui-codexhost/src/client/locales.ts";
import { RunningStatus } from "../../../apps/web-ui/packages/client/ui-chat/src/client/chat/RunningStatus.tsx";
import { en as chatEn } from "../../../apps/web-ui/packages/client/ui-chat/src/client/locale.ts";

const cleanup: Array<() => void> = [];
afterEach(() => {
  cleanup.splice(0).forEach((dispose) => dispose());
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function mount() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  cleanup.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  return { container, root };
}

it("hides brief recovery and keeps offline, sustained recovery and Host failures visible", () => {
  vi.useFakeTimers();
  const { container, root } = mount();
  const state = createSnapshotStore<ConnectionState | undefined>("disconnected");
  const list = createSnapshotStore({
    byId: { thread: { projectionValues: { nativeConnection: { state: "connected" } } } },
  });
  const reconnect = vi.fn();
  const session = { openState: "open", lastSyncedAt: 1_700_000_000_000 };
  const props = {
    sessionId: "thread",
    useSession: (select: (value: typeof session) => unknown) => select(session),
    list,
    connection: { state, reconnect },
    t: (key: keyof typeof en, args?: { time: string }) =>
      en[key].replace("{time}", args?.time ?? ""),
  } as unknown as ComponentProps<typeof HostConnectionStatus>;
  act(() => root.render(createElement(HostConnectionStatus, props)));
  expect(container.querySelector('[data-web-connection="offline"]')).not.toBeNull();
  expect(container.textContent).toContain("Last synced at");
  act(() => container.querySelector("button")!.click());
  expect(reconnect).toHaveBeenCalledOnce();
  act(() => state.set("connecting"));
  act(() => vi.advanceTimersByTime(999));
  expect(container.querySelector('[role="status"]')).toBeNull();
  act(() => state.set("connected"));
  act(() => state.set("connecting"));
  act(() => vi.advanceTimersByTime(999));
  expect(container.querySelector('[role="status"]')).toBeNull();
  act(() => vi.advanceTimersByTime(1));
  expect(container.querySelector('[data-web-connection="reconnecting"]')).not.toBeNull();
  act(() => state.set("connected"));
  expect(container.querySelector('[role="status"]')).toBeNull();
  act(() =>
    list.set({
      byId: { thread: { projectionValues: { nativeConnection: { state: "reconnecting" } } } },
    }),
  );
  expect(container.querySelector('[data-web-connection="host"]')).not.toBeNull();
  expect(container.querySelector('[data-native-connection="reconnecting"]')).not.toBeNull();
});

it("shows connection failure without a selected session", () => {
  const { container, root } = mount();
  const props = {
    sessionId: undefined,
    useSession: () => undefined,
    list: createSnapshotStore({ byId: {} }),
    connection: { state: createSnapshotStore("disconnected"), reconnect: vi.fn() },
    t: (key: keyof typeof en) => en[key],
  } as unknown as ComponentProps<typeof HostConnectionStatus>;
  act(() => root.render(createElement(HostConnectionStatus, props)));
  expect(container.textContent).toContain("Network appears offline");
});

it("does not animate or advance the running clock while the task status is unconfirmed", () => {
  const { container, root } = mount();
  const props = {
    startTime: Date.now() - 500_000,
    stale: true,
    t: (key: keyof typeof chatEn) => chatEn[key],
  } as unknown as ComponentProps<typeof RunningStatus>;
  act(() => root.render(createElement(RunningStatus, props)));
  expect(container.textContent).toContain("task status unconfirmed");
  expect(container.textContent).not.toContain("Working");
  expect(container.querySelector("svg")).toBeNull();
});
