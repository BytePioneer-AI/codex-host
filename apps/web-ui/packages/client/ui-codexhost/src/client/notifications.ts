/** Unified notifications driver: native-shell bridge first, with Web Push fallback for browsers/PWAs. */
import { pushApi } from "./api.ts";
import {
  getShellNotificationBridge,
  type ShellNotificationPermission,
  type ShellNotificationState,
} from "./shell-notifications.ts";

export type NotificationState =
  "unsupported" | "insecure" | "needs-install" | "denied" | "off" | "on";

export interface TestNotificationCopy {
  readonly title?: string;
  readonly body?: string;
}

const DEFAULT_TEST_TITLE = "通知测试";
const DEFAULT_TEST_BODY = "这台设备可以正常接收通知。";

function resolveWindow(targetWindow?: Window): Window | undefined {
  return targetWindow ?? (typeof window === "undefined" ? undefined : window);
}

function urlBase64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replace(/-/gu, "+").replace(/_/gu, "/");
  const raw = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  return bytes;
}

export function isIosBrowserTab(targetWindow?: Window): boolean {
  const win = resolveWindow(targetWindow);
  if (win === undefined) return false;
  const { userAgent = "", maxTouchPoints = 0 } = win.navigator;
  const ios =
    /iPad|iPhone|iPod/u.test(userAgent) || (/Macintosh/u.test(userAgent) && maxTouchPoints > 1);
  const standalone =
    win.matchMedia?.("(display-mode: standalone)")?.matches === true ||
    (win.navigator as Navigator & { standalone?: boolean }).standalone === true;
  return ios && !standalone;
}

export function mapShellNotificationState(state: ShellNotificationState): NotificationState {
  if (state.permission === "unsupported") return "unsupported";
  if (state.permission === "denied") return "denied";
  if (state.enabled && state.permission === "granted") return "on";
  return "off";
}

export function isShellNotificationMode(targetWindow?: Window): boolean {
  return getShellNotificationBridge(resolveWindow(targetWindow)) !== undefined;
}

export function shouldDeliverShellNotification(options: {
  enabled: boolean;
  permission: ShellNotificationPermission;
  visibilityState: DocumentVisibilityState;
  hasFocus: boolean;
  sessionId?: string;
  isSessionInMainView: (sessionId: string) => boolean;
}): boolean {
  if (!options.enabled || options.permission !== "granted") return false;
  const viewingSameSession =
    options.visibilityState === "visible" &&
    options.hasFocus &&
    typeof options.sessionId === "string" &&
    options.sessionId.length > 0 &&
    options.isSessionInMainView(options.sessionId);
  return !viewingSameSession;
}

async function registration(win: Window): Promise<ServiceWorkerRegistration> {
  const existing = await win.navigator.serviceWorker.getRegistration("./");
  return existing ?? (await win.navigator.serviceWorker.register("sw.js", { scope: "./" }));
}

export async function notificationState(targetWindow?: Window): Promise<NotificationState> {
  const win = resolveWindow(targetWindow);
  if (win === undefined) return "unsupported";
  const bridge = getShellNotificationBridge(win);
  if (bridge !== undefined) {
    return mapShellNotificationState(await bridge.getState());
  }
  if (!win.isSecureContext) return "insecure";
  if (!("serviceWorker" in win.navigator) || !("PushManager" in win) || !("Notification" in win)) {
    // iOS only exposes Web Push to home-screen apps.
    return isIosBrowserTab(win) ? "needs-install" : "unsupported";
  }
  if (win.Notification.permission === "denied") return "denied";
  const existing = await win.navigator.serviceWorker.getRegistration("./");
  const subscription = await existing?.pushManager.getSubscription();
  return subscription === null || subscription === undefined ? "off" : "on";
}

async function subscribeAndReport(win: Window): Promise<void> {
  const worker = await registration(win);
  await win.navigator.serviceWorker.ready;
  let subscription = await worker.pushManager.getSubscription();
  if (subscription === null) {
    const { publicKey } = await pushApi.config();
    subscription = await worker.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToBytes(publicKey),
    });
  }
  await pushApi.subscribe(subscription.toJSON());
}

export async function enableNotifications(targetWindow?: Window): Promise<NotificationState> {
  const win = resolveWindow(targetWindow);
  if (win === undefined) return "unsupported";
  const bridge = getShellNotificationBridge(win);
  if (bridge !== undefined) {
    const permission = await bridge.requestPermission();
    if (permission === "unsupported") return "unsupported";
    if (permission === "denied") return "denied";
    if (permission !== "granted") return "off";
    const enabled = await bridge.setEnabled(true);
    return enabled ? "on" : "off";
  }
  if (!win.isSecureContext) return "insecure";
  const permission = await win.Notification.requestPermission();
  if (permission !== "granted") return permission === "denied" ? "denied" : "off";
  await subscribeAndReport(win);
  return "on";
}

export async function disableNotifications(targetWindow?: Window): Promise<NotificationState> {
  const win = resolveWindow(targetWindow);
  if (win === undefined) return "off";
  const bridge = getShellNotificationBridge(win);
  if (bridge !== undefined) {
    await bridge.setEnabled(false);
    return "off";
  }
  const worker = await win.navigator.serviceWorker.getRegistration("./");
  const subscription = await worker?.pushManager.getSubscription();
  if (subscription !== null && subscription !== undefined) {
    await pushApi.unsubscribe(subscription.endpoint);
    await subscription.unsubscribe();
  }
  return "off";
}

export async function sendTestNotification(
  copy?: TestNotificationCopy,
  targetWindow?: Window,
): Promise<boolean> {
  const win = resolveWindow(targetWindow);
  if (win === undefined) return false;
  const bridge = getShellNotificationBridge(win);
  if (bridge !== undefined) {
    return bridge.send({
      kind: "test",
      title: copy?.title ?? DEFAULT_TEST_TITLE,
      body: copy?.body ?? DEFAULT_TEST_BODY,
      tag: "codexhost-test",
    });
  }
  const worker = await win.navigator.serviceWorker.getRegistration("./");
  const subscription = await worker?.pushManager.getSubscription();
  if (!subscription) return false;
  return (await pushApi.test(subscription.endpoint)).sent > 0;
}

/** Keep the service worker installed so notification clicks can reach the app. */
export function ensureServiceWorker(targetWindow?: Window): void {
  const win = resolveWindow(targetWindow);
  if (win === undefined || getShellNotificationBridge(win) !== undefined) return;
  if (!("serviceWorker" in win.navigator)) return;
  void registration(win).catch(() => undefined);
}

/** Restore missing subscriptions and associate them with the current sign-in token. */
export function resubmitNotifications(targetWindow?: Window): void {
  const win = resolveWindow(targetWindow);
  if (win === undefined || getShellNotificationBridge(win) !== undefined) return;
  if (
    !win.isSecureContext ||
    !("serviceWorker" in win.navigator) ||
    !("PushManager" in win) ||
    !("Notification" in win)
  )
    return;
  if (win.Notification.permission !== "granted") return;
  void subscribeAndReport(win).catch(() => undefined);
}
