import { describe, expect, it, vi } from "vitest";
import {
  disableNotifications,
  enableNotifications,
  ensureServiceWorker,
  isIosBrowserTab,
  notificationState,
  resubmitNotifications,
  sendTestNotification,
  shouldDeliverShellNotification,
} from "../src/client/notifications.ts";
import {
  getShellNotificationBridge,
  isNativeShell,
  type ShellNotificationBridge,
  type ShellNotificationPermission,
  type ShellNotificationState,
} from "../src/client/shell-notifications.ts";

function fakeBrowserWindow(overrides: Record<string, unknown> = {}): Window {
  return {
    isSecureContext: true,
    navigator: {
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
      maxTouchPoints: 0,
    },
    matchMedia: () => ({ matches: false }),
    ...overrides,
  } as unknown as Window;
}

function fakeShellBridge(initial: Partial<ShellNotificationState> = {}) {
  let state: ShellNotificationState = {
    enabled: initial.enabled ?? false,
    permission: initial.permission ?? "prompt",
  };
  const clicks = new Set<(payload: { sessionId?: string }) => void>();
  const bridge: ShellNotificationBridge = {
    getState: vi.fn(async () => state),
    requestPermission: vi.fn(async (): Promise<ShellNotificationPermission> => state.permission),
    setEnabled: vi.fn(async (enabled: boolean) => {
      state = { ...state, enabled };
      return state.enabled;
    }),
    send: vi.fn(async () => true),
    onClick: vi.fn((listener) => {
      clicks.add(listener);
      return () => clicks.delete(listener);
    }),
    openSystemSettings: vi.fn(async () => undefined),
  };
  return {
    bridge,
    setState(next: ShellNotificationState) {
      state = next;
    },
    emitClick(sessionId?: string) {
      for (const listener of clicks) listener(sessionId === undefined ? {} : { sessionId });
    },
  };
}

describe("shell-notifications carrier detection", () => {
  it("recognizes Desktop shell, Android shell, and generic native shell flags", () => {
    expect(isNativeShell(fakeBrowserWindow())).toBe(false);
    expect(isNativeShell(fakeBrowserWindow({ __CODEXHOST_DESKTOP_SHELL__: true }))).toBe(true);
    expect(
      isNativeShell(
        fakeBrowserWindow({ __codexhostAndroidHostSwitcher: { openHostSwitcher: () => {} } }),
      ),
    ).toBe(true);
    expect(isNativeShell(fakeBrowserWindow({ __CODEXHOST_NATIVE_SHELL__: true }))).toBe(true);
  });

  it("validates required methods before returning the shell notification bridge", () => {
    expect(getShellNotificationBridge(fakeBrowserWindow())).toBeUndefined();
    expect(
      getShellNotificationBridge(
        fakeBrowserWindow({ __codexhostNotifications: { getState: async () => ({}) } }),
      ),
    ).toBeUndefined();
    const { bridge } = fakeShellBridge();
    expect(
      getShellNotificationBridge(fakeBrowserWindow({ __codexhostNotifications: bridge })),
    ).toBe(bridge);
  });
});

describe("native shell notification driver", () => {
  it("maps shell permission and enabled state to NotificationState", async () => {
    const { bridge, setState } = fakeShellBridge({ enabled: true, permission: "granted" });
    const win = fakeBrowserWindow({
      isSecureContext: false,
      __codexhostNotifications: bridge,
    });
    expect(await notificationState(win)).toBe("on");

    setState({ enabled: false, permission: "granted" });
    expect(await notificationState(win)).toBe("off");

    setState({ enabled: true, permission: "prompt" });
    expect(await notificationState(win)).toBe("off");

    setState({ enabled: true, permission: "denied" });
    expect(await notificationState(win)).toBe("denied");

    setState({ enabled: false, permission: "unsupported" });
    expect(await notificationState(win)).toBe("unsupported");
  });

  it("enables, disables, and sends test notifications via shell bridge without touching Web Push", async () => {
    const { bridge, setState } = fakeShellBridge({ enabled: false, permission: "prompt" });
    const register = vi.fn();
    const getRegistration = vi.fn();
    const win = fakeBrowserWindow({
      __codexhostNotifications: bridge,
      PushManager: {},
      Notification: { permission: "granted" },
      navigator: {
        userAgent: "Mozilla/5.0",
        maxTouchPoints: 0,
        serviceWorker: { register, getRegistration },
      },
    });

    ensureServiceWorker(win);
    resubmitNotifications(win);
    expect(register).not.toHaveBeenCalled();
    expect(getRegistration).not.toHaveBeenCalled();

    (bridge.requestPermission as ReturnType<typeof vi.fn>).mockResolvedValueOnce("denied");
    expect(await enableNotifications(win)).toBe("denied");
    expect(bridge.setEnabled).not.toHaveBeenCalled();

    setState({ enabled: false, permission: "granted" });
    (bridge.requestPermission as ReturnType<typeof vi.fn>).mockResolvedValueOnce("granted");
    expect(await enableNotifications(win)).toBe("on");
    expect(bridge.setEnabled).toHaveBeenCalledWith(true);

    expect(await sendTestNotification({ title: "Test", body: "Hello" }, win)).toBe(true);
    expect(bridge.send).toHaveBeenCalledWith({
      kind: "test",
      title: "Test",
      body: "Hello",
      tag: "codexhost-test",
    });

    expect(await disableNotifications(win)).toBe("off");
    expect(bridge.setEnabled).toHaveBeenLastCalledWith(false);
  });

  it("suppresses native shell notifications only when focused on the same active session", () => {
    const viewing = (id: string) => id === "thread-1";

    expect(
      shouldDeliverShellNotification({
        enabled: true,
        permission: "granted",
        visibilityState: "visible",
        hasFocus: true,
        sessionId: "thread-1",
        isSessionInMainView: viewing,
      }),
    ).toBe(false);

    expect(
      shouldDeliverShellNotification({
        enabled: true,
        permission: "granted",
        visibilityState: "visible",
        hasFocus: true,
        sessionId: "thread-2",
        isSessionInMainView: viewing,
      }),
    ).toBe(true);

    expect(
      shouldDeliverShellNotification({
        enabled: true,
        permission: "granted",
        visibilityState: "visible",
        hasFocus: false,
        sessionId: "thread-1",
        isSessionInMainView: viewing,
      }),
    ).toBe(true);

    expect(
      shouldDeliverShellNotification({
        enabled: true,
        permission: "granted",
        visibilityState: "hidden",
        hasFocus: true,
        sessionId: "thread-1",
        isSessionInMainView: viewing,
      }),
    ).toBe(true);

    expect(
      shouldDeliverShellNotification({
        enabled: false,
        permission: "granted",
        visibilityState: "hidden",
        hasFocus: false,
        sessionId: "thread-2",
        isSessionInMainView: viewing,
      }),
    ).toBe(false);

    expect(
      shouldDeliverShellNotification({
        enabled: true,
        permission: "denied",
        visibilityState: "hidden",
        hasFocus: false,
        sessionId: "thread-2",
        isSessionInMainView: viewing,
      }),
    ).toBe(false);
  });
});

describe("browser Web Push blind spot fixes", () => {
  it("reports insecure on non-secure HTTP contexts before checking Push APIs or iOS install prompt", async () => {
    const lanDesktop = fakeBrowserWindow({ isSecureContext: false });
    expect(await notificationState(lanDesktop)).toBe("insecure");

    const lanIphone = fakeBrowserWindow({
      isSecureContext: false,
      navigator: {
        userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)",
        maxTouchPoints: 5,
      },
    });
    expect(await notificationState(lanIphone)).toBe("insecure");
  });

  it("recognizes iPadOS desktop-mode UA as an iOS browser tab needing Home Screen install", async () => {
    const ipadDesktopTab = fakeBrowserWindow({
      isSecureContext: true,
      navigator: {
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
        maxTouchPoints: 5,
      },
    });
    expect(isIosBrowserTab(ipadDesktopTab)).toBe(true);
    expect(await notificationState(ipadDesktopTab)).toBe("needs-install");

    const ipadStandalone = fakeBrowserWindow({
      isSecureContext: true,
      navigator: {
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
        maxTouchPoints: 5,
        standalone: true,
      },
    });
    expect(isIosBrowserTab(ipadStandalone)).toBe(false);
    expect(await notificationState(ipadStandalone)).toBe("unsupported");

    const macDesktop = fakeBrowserWindow({
      isSecureContext: true,
      navigator: {
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
        maxTouchPoints: 0,
      },
    });
    expect(isIosBrowserTab(macDesktop)).toBe(false);
    expect(await notificationState(macDesktop)).toBe("unsupported");
  });
});
