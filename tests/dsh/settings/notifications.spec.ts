import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { pushApi } from "../../../apps/web-ui/packages/client/ui-codexhost/src/client/api.ts";
import {
  enableNotifications,
  resubmitNotifications,
} from "../../../apps/web-ui/packages/client/ui-codexhost/src/client/notifications.ts";

vi.mock("../../../apps/web-ui/packages/client/ui-codexhost/src/client/api.ts", () => ({
  pushApi: {
    config: vi.fn(),
    subscribe: vi.fn(),
  },
}));

const subscriptionJson = {
  endpoint: "https://push.example/new",
  keys: { p256dh: "p256dh", auth: "auth" },
};
const subscription = { toJSON: () => subscriptionJson };
const getSubscription = vi.fn();
const subscribe = vi.fn();
const worker = { pushManager: { getSubscription, subscribe } };
const getRegistration = vi.fn();
const register = vi.fn();
const requestPermission = vi.fn();

beforeEach(() => {
  vi.resetAllMocks();
  getSubscription.mockResolvedValue(null);
  subscribe.mockResolvedValue(subscription);
  getRegistration.mockResolvedValue(worker);
  register.mockResolvedValue(worker);
  requestPermission.mockResolvedValue("granted");
  vi.mocked(pushApi.config).mockResolvedValue({ publicKey: "-_8", subscriptions: 0 });
  vi.mocked(pushApi.subscribe).mockResolvedValue({ subscribed: true });
  const notification = { permission: "granted", requestPermission };
  vi.stubGlobal("Notification", notification);
  vi.stubGlobal("window", { Notification: notification, PushManager: class {} });
  vi.stubGlobal("navigator", {
    serviceWorker: { getRegistration, register, ready: Promise.resolve(worker) },
  });
});

afterEach(() => vi.unstubAllGlobals());

it("recreates a missing subscription with granted permission without prompting", async () => {
  resubmitNotifications();
  await vi.waitFor(() => expect(pushApi.subscribe).toHaveBeenCalledWith(subscriptionJson));
  expect(pushApi.config).toHaveBeenCalledOnce();
  expect(subscribe).toHaveBeenCalledOnce();
  expect(subscribe).toHaveBeenCalledWith({
    userVisibleOnly: true,
    applicationServerKey: new Uint8Array([251, 255]),
  });
  expect(requestPermission).not.toHaveBeenCalled();
});

it("resubmits an existing subscription to the current token without subscribing again", async () => {
  getSubscription.mockResolvedValue(subscription);
  resubmitNotifications();
  await vi.waitFor(() => expect(pushApi.subscribe).toHaveBeenCalledWith(subscriptionJson));
  expect(subscribe).not.toHaveBeenCalled();
  expect(pushApi.config).not.toHaveBeenCalled();
});

it("registers a missing service worker and waits for activation before recovering", async () => {
  getRegistration.mockResolvedValue(undefined);
  const ready = Promise.withResolvers<typeof worker>();
  Object.defineProperty(navigator.serviceWorker, "ready", { value: ready.promise });
  resubmitNotifications();
  await vi.waitFor(() => expect(register).toHaveBeenCalledWith("sw.js", { scope: "./" }));
  expect(subscribe).not.toHaveBeenCalled();
  ready.resolve(worker);
  await vi.waitFor(() => expect(pushApi.subscribe).toHaveBeenCalledWith(subscriptionJson));
});

it.each(["default", "denied"])("does not recover with %s permission", (permission) => {
  vi.stubGlobal("Notification", { permission, requestPermission });
  resubmitNotifications();
  expect(getRegistration).not.toHaveBeenCalled();
  expect(requestPermission).not.toHaveBeenCalled();
});

it.each(["serviceWorker", "PushManager", "Notification"])(
  "does not recover without %s support",
  (capability) => {
    if (capability === "serviceWorker") vi.stubGlobal("navigator", {});
    else Reflect.deleteProperty(window, capability);
    resubmitNotifications();
    expect(getRegistration).not.toHaveBeenCalled();
  },
);

it("uses the same subscription flow when explicitly enabling notifications", async () => {
  await expect(enableNotifications()).resolves.toBe("on");
  expect(requestPermission).toHaveBeenCalledOnce();
  expect(subscribe).toHaveBeenCalledWith({
    userVisibleOnly: true,
    applicationServerKey: new Uint8Array([251, 255]),
  });
  expect(pushApi.subscribe).toHaveBeenCalledWith(subscriptionJson);
});

it.each(["config", "subscribe", "report"])(
  "ignores a background %s failure and can recover on the next attempt",
  async (failure) => {
    const failed = Promise.withResolvers<void>();
    const reject = async () => {
      failed.resolve();
      throw new Error("Offline");
    };
    if (failure === "config") vi.mocked(pushApi.config).mockImplementationOnce(reject);
    else if (failure === "subscribe") subscribe.mockImplementationOnce(reject);
    else vi.mocked(pushApi.subscribe).mockImplementationOnce(reject);
    resubmitNotifications();
    await failed.promise;
    // Let the fire-and-forget recovery settle before retrying.
    await new Promise((resolve) => setTimeout(resolve, 0));
    vi.mocked(pushApi.subscribe).mockClear();
    resubmitNotifications();
    await vi.waitFor(() => expect(pushApi.subscribe).toHaveBeenCalledWith(subscriptionJson));
    expect(requestPermission).not.toHaveBeenCalled();
  },
);
