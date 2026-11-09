// @vitest-environment jsdom
import { act, createElement, useSyncExternalStore, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { SidebarRoot } from "../../../apps/web-ui/packages/client/ui-sidebar/src/client/SidebarRoot.tsx";
import { RemoteAccessAction } from "../../../apps/web-ui/packages/client/ui-codexhost/src/client/RemoteAccessAction.tsx";
import { ConnectDevicesSection } from "../../../apps/web-ui/packages/client/ui-codexhost/src/client/ConnectDevicesSection.tsx";
import {
  accessTokenApi,
  ApiError,
} from "../../../apps/web-ui/packages/client/ui-codexhost/src/client/api.ts";
import { en, zh } from "../../../apps/web-ui/packages/client/ui-codexhost/src/client/locales.ts";
import { SettingsRoot } from "../../../apps/web-ui/packages/client/ui-settings-general/src/client/SettingsRoot.tsx";
import { createSettingsShellStore } from "../../../apps/web-ui/packages/client/ui-settings-general/src/client/shell-store.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach((dispose) => dispose());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mount({
  collapsed = false,
  locale = en,
}: {
  collapsed?: boolean;
  locale?: Record<keyof typeof en, string>;
} = {}) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  container.id = "root";
  document.body.append(container);
  const root = createRoot(container);
  cleanups.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  const shell = createSettingsShellStore().create();
  const selectPanel = vi.fn();
  const translate = (key: keyof typeof en, args: Record<string, string> = {}) =>
    locale[key].replace(/\{(\w+)\}/gu, (_match, name: string) => args[name] ?? "");
  const settingsProps = {
    wide: !collapsed,
    actions: shell.actions,
    useStore: (selector: (value: ReturnType<typeof shell.getSnapshot>) => unknown) =>
      useSyncExternalStore(shell.subscribe, () => selector(shell.getSnapshot())),
    useSections: (selector: (rows: unknown[]) => unknown) =>
      selector([
        { id: "general", label: "General", order: 0 },
        { id: "codexhost-connect-devices", label: "Connect devices", order: 1 },
      ]),
    useShortcuts: () => undefined,
    useOnboardingSteps: () => [],
    useSessions: () => false,
    useConnectionState: () => "connected",
    useDesktopUpdate: () => ({}),
    reconnect: vi.fn(),
    openDesktopUpdate: vi.fn(),
    t: (key: string) => key,
    renderSlot: (
      name: string,
      _props: unknown,
      options?: { only?: string; fallback?: unknown },
    ) => {
      if (name === "settings.section" && options?.only === "codexhost-connect-devices")
        return createElement(ConnectDevicesSection, { t: translate });
      return options?.fallback ?? null;
    },
  } as unknown as ComponentProps<typeof SettingsRoot>;
  const props = {
    collapsed,
    width: 240,
    startSession: vi.fn(),
    toggleSidebar: vi.fn(),
    selectPanel,
    usePanels: () => [{ id: "codexhost-import", label: "Import sessions", order: 10 }],
    useShortcuts: () => undefined,
    usePanelInfo: () => false,
    t: (key: string) => key,
    renderSlot: (name: string, owner: ComponentProps<typeof RemoteAccessAction>) => {
      if (name === "sidebar.primary.action")
        return createElement(RemoteAccessAction, {
          ...owner,
          t: translate,
          openSection: shell.actions.openSection,
        });
      if (name === "sidebar.settings") return createElement(SettingsRoot, settingsProps);
      return null;
    },
  } as unknown as ComponentProps<typeof SidebarRoot>;
  await act(async () => root.render(createElement(SidebarRoot, props)));
  return { container, shell, selectPanel };
}

it.each([false, true])(
  "shows local discovery after Import sessions (collapsed=%s)",
  async (collapsed) => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ authenticated: true, local: true }));
    vi.stubGlobal("fetch", fetcher);
    const { container } = await mount({ collapsed });
    const rows = [...container.querySelectorAll('nav[aria-label="panels.label"] button')];
    expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual([
      "Import sessions",
      "Remote access",
    ]);
    expect(rows[1].querySelector("svg")).not.toBeNull();
    expect(rows[1].getAttribute("aria-current")).toBeNull();
    expect(fetcher).toHaveBeenCalledExactlyOnceWith("api/auth/status", {
      credentials: "same-origin",
      cache: "no-store",
      signal: expect.any(AbortSignal),
    });
  },
);

it.each([375, 1440])("hides remote discovery regardless of viewport width (%s)", async (width) => {
  vi.stubGlobal("innerWidth", width);
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(Response.json({ authenticated: true, local: false })),
  );
  const { container } = await mount();
  expect(container.querySelector('[aria-label="Remote access"]')).toBeNull();
  expect(container.querySelector('[aria-label="Import sessions"]')).not.toBeNull();
});

it("shows local discovery even in a narrow viewport, using the Chinese label", async () => {
  vi.stubGlobal("innerWidth", 375);
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(Response.json({ authenticated: true, local: true })),
  );
  const { container } = await mount({ locale: zh });
  expect(container.querySelector('[aria-label="远程访问"]')).not.toBeNull();
});

it.each([
  () => Promise.resolve(Response.json({ authenticated: true })),
  () => Promise.resolve(Response.json({ authenticated: false, local: true })),
  () => Promise.resolve(Response.json({ authenticated: true, local: "true" })),
  () => Promise.resolve(new Response("unauthorized", { status: 401 })),
  () => Promise.resolve(new Response("invalid json")),
  () => Promise.reject(new Error("offline")),
])("keeps unknown or failed access checks hidden", async (response) => {
  vi.stubGlobal("fetch", vi.fn(response));
  const { container } = await mount();
  expect(container.querySelector('[aria-label="Remote access"]')).toBeNull();
});

it("does not flash the CTA while local access is unconfirmed and cancels on unmount", async () => {
  let resolve!: (response: Response) => void;
  const fetcher = vi.fn().mockImplementation(
    () =>
      new Promise<Response>((done) => {
        resolve = done;
      }),
  );
  vi.stubGlobal("fetch", fetcher);
  const { container } = await mount();
  expect(container.querySelector('[aria-label="Remote access"]')).toBeNull();
  cleanups.pop()!();
  expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
  await act(async () => resolve(Response.json({ authenticated: true, local: true })));
  expect(document.querySelector('[aria-label="Remote access"]')).toBeNull();
});

it("keeps the settings section available with guidance for remote users", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(Response.json({ authenticated: true, local: false })),
  );
  vi.spyOn(accessTokenApi, "get").mockRejectedValue(
    new ApiError("Local access required", "auth/local-access-required", {
      url: "http://127.0.0.1:4400",
    }),
  );
  const { shell } = await mount();
  await act(async () => shell.actions.openSection("codexhost-connect-devices"));
  expect(document.querySelector('[data-connect-notice="non-local"]')?.textContent).toContain(
    "http://127.0.0.1:4400",
  );
  expect(document.querySelector('[aria-label="Remote access"]')).toBeNull();
});

it("opens the existing settings section and connection flow without selecting a main panel", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(Response.json({ authenticated: true, local: true })),
  );
  const get = vi.spyOn(accessTokenApi, "get").mockResolvedValue({
    secret: "test-token",
    lastUsedAt: null,
    networkUrls: [{ kind: "lan", url: "http://192.168.1.2:4400/" }],
    tailscale: { status: "not-installed" },
  });
  const { container, shell, selectPanel } = await mount();
  expect(get).not.toHaveBeenCalled();
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="Remote access"]')!.click(),
  );
  expect(shell.getSnapshot()).toEqual({ open: true, activeId: "codexhost-connect-devices" });
  expect(selectPanel).not.toHaveBeenCalled();
  expect(document.querySelector('[role="dialog"] [data-connect-devices]')).not.toBeNull();
  expect(
    document.querySelector(`[role="dialog"] [aria-label="${en["connectDevices.qrLabel"]}"]`),
  ).not.toBeNull();
  expect(get).toHaveBeenCalledTimes(1);
  await act(async () => shell.actions.close());
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});
