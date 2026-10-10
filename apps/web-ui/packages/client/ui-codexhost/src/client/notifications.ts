/** Browser half of Web Push: service worker registration and push subscription. */
import { pushApi } from "./api.ts";

export type NotificationState = "unsupported" | "needs-install" | "denied" | "off" | "on";

function urlBase64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replace(/-/gu, "+").replace(/_/gu, "/");
  const raw = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  return bytes;
}

function isIosBrowserTab(): boolean {
  const ios = /iPad|iPhone|iPod/u.test(navigator.userAgent);
  const standalone =
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return ios && !standalone;
}

async function registration(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration("./");
  return existing ?? (await navigator.serviceWorker.register("sw.js", { scope: "./" }));
}

export async function notificationState(): Promise<NotificationState> {
  if (
    !("serviceWorker" in navigator) ||
    !("PushManager" in window) ||
    !("Notification" in window)
  ) {
    // iOS only exposes Web Push to home-screen apps.
    return isIosBrowserTab() ? "needs-install" : "unsupported";
  }
  if (Notification.permission === "denied") return "denied";
  const existing = await navigator.serviceWorker.getRegistration("./");
  const subscription = await existing?.pushManager.getSubscription();
  return subscription === null || subscription === undefined ? "off" : "on";
}

export async function enableNotifications(): Promise<NotificationState> {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return permission === "denied" ? "denied" : "off";
  const worker = await registration();
  await navigator.serviceWorker.ready;
  const { publicKey } = await pushApi.config();
  const subscription =
    (await worker.pushManager.getSubscription()) ??
    (await worker.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToBytes(publicKey),
    }));
  await pushApi.subscribe(subscription.toJSON());
  return "on";
}

export async function disableNotifications(): Promise<NotificationState> {
  const worker = await navigator.serviceWorker.getRegistration("./");
  const subscription = await worker?.pushManager.getSubscription();
  if (subscription !== null && subscription !== undefined) {
    await pushApi.unsubscribe(subscription.endpoint);
    await subscription.unsubscribe();
  }
  return "off";
}

/** Keep the service worker installed so notification clicks can reach the app. */
export function ensureServiceWorker(): void {
  if (!("serviceWorker" in navigator)) return;
  void registration().catch(() => undefined);
}
