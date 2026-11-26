import { afterEach, describe, expect, it, vi } from "vitest";
import { pushApi } from "../src/client/api.ts";
import {
  desktopNotificationUrl,
  disableNotifications,
  enableNotifications,
  initializeNotifications,
  notificationState,
  resubmitNotifications,
  sendTestNotification,
} from "../src/client/notifications.ts";

vi.mock("../src/client/api.ts", () => ({
  pushApi: {
    config: vi.fn(async () => ({ publicKey: "YQ", subscriptions: 0 })),
    subscribe: vi.fn(async () => ({ subscribed: true })),
    unsubscribe: vi.fn(async () => ({ subscribed: false })),
    test: vi.fn(async () => ({ sent: 1 })),
  },
}));

function browser(desktop: boolean, subscribed: boolean, installed = true) {
  const subscription = {
    endpoint: "https://push.test/profile-endpoint",
    toJSON: () => ({ endpoint: "https://push.test/profile-endpoint" }),
    unsubscribe: vi.fn(async () => true),
  };
  let current = subscribed ? subscription : null;
  const worker = {
    pushManager: {
      getSubscription: vi.fn(async () => current),
      subscribe: vi.fn(async () => {
        current = subscription;
        return subscription;
      }),
    },
    unregister: vi.fn(async () => true),
  };
  const serviceWorker = {
    getRegistration: vi.fn(async () => (installed ? worker : undefined)),
    register: vi.fn(async () => worker),
    ready: Promise.resolve(worker),
  };
  const requestPermission = vi.fn(async () => "granted");
  vi.stubGlobal("window", {
    __CODEXHOST_DESKTOP_SHELL__: desktop,
    PushManager: {},
    Notification: {},
  });
  vi.stubGlobal("navigator", { userAgent: "test browser", serviceWorker });
  vi.stubGlobal("Notification", { permission: "granted", requestPermission });
  return { worker, serviceWorker, requestPermission, subscription };
}

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("notification settings", () => {
  it("retires the current WebView subscription and disables native notification actions", async () => {
    const { worker, serviceWorker, requestPermission, subscription } = browser(true, true);
    await initializeNotifications();
    expect(pushApi.unsubscribe).toHaveBeenCalledExactlyOnceWith(subscription.endpoint);
    expect(subscription.unsubscribe).toHaveBeenCalledOnce();
    expect(worker.unregister).toHaveBeenCalledOnce();
    resubmitNotifications();
    expect(await notificationState()).toBe("edge");
    expect(await enableNotifications()).toBe("edge");
    expect(await sendTestNotification()).toBe(false);
    expect(requestPermission).not.toHaveBeenCalled();
    expect(worker.pushManager.subscribe).not.toHaveBeenCalled();
    expect(serviceWorker.register).not.toHaveBeenCalled();
    expect(pushApi.subscribe).not.toHaveBeenCalled();
  });

  it("leaves a clean WebView profile without a worker or push subscription", async () => {
    const { serviceWorker } = browser(true, false, false);
    await initializeNotifications();
    expect(serviceWorker.register).not.toHaveBeenCalled();
    expect(pushApi.unsubscribe).not.toHaveBeenCalled();
  });

  it.each(["rejects", "stays pending"] as const)(
    "cleans up the WebView locally when server unsubscribe %s",
    async (outcome) => {
      const { worker, subscription } = browser(true, true);
      const unsubscribe = vi.mocked(pushApi.unsubscribe);
      if (outcome === "rejects") unsubscribe.mockRejectedValueOnce(new Error("Web is offline"));
      else unsubscribe.mockImplementationOnce(() => new Promise(() => {}));
      await initializeNotifications();
      expect(unsubscribe).toHaveBeenCalledExactlyOnceWith(subscription.endpoint);
      expect(subscription.unsubscribe).toHaveBeenCalledOnce();
      expect(worker.unregister).toHaveBeenCalledOnce();
    },
  );

  it.each(["lookup", "unsubscribe"] as const)(
    "unregisters the WebView worker when local subscription %s rejects",
    async (operation) => {
      const { worker, subscription } = browser(true, true);
      const error = new Error("PushManager rejected the operation");
      if (operation === "lookup") worker.pushManager.getSubscription.mockRejectedValueOnce(error);
      else subscription.unsubscribe.mockRejectedValueOnce(error);
      await expect(initializeNotifications()).rejects.toThrow(error);
      expect(worker.unregister).toHaveBeenCalledOnce();
    },
  );

  it("keeps browser enable, test and disable on the browser subscription", async () => {
    const { worker, requestPermission, subscription } = browser(false, false);
    expect(await notificationState()).toBe("off");
    expect(await enableNotifications()).toBe("on");
    expect(requestPermission).toHaveBeenCalledOnce();
    expect(pushApi.subscribe).toHaveBeenCalledExactlyOnceWith(subscription.toJSON());
    expect(await sendTestNotification()).toBe(true);
    expect(pushApi.test).toHaveBeenCalledExactlyOnceWith(subscription.endpoint);
    expect(await disableNotifications()).toBe("off");
    expect(pushApi.unsubscribe).toHaveBeenCalledExactlyOnceWith(subscription.endpoint);
    expect(subscription.unsubscribe).toHaveBeenCalledOnce();
    expect(worker.unregister).not.toHaveBeenCalled();
  });

  it("offers the same Web address in Edge without credentials, query or fragment", () => {
    expect(
      desktopNotificationUrl("http://user:secret@127.0.0.1:4400/web/?token=local#token=shared"),
    ).toBe("http://127.0.0.1:4400/web/");
  });
});
