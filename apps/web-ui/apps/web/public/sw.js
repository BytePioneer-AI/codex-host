/* CodexHost service worker: Web Push notifications and notification clicks. */

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let message = {};
  try {
    message = event.data ? event.data.json() : {};
  } catch {
    message = { title: "CodexHost", body: event.data ? event.data.text() : "" };
  }
  event.waitUntil(
    (async () => {
      // Skip the notification when the user is already looking at CodexHost.
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const visible = windows.some(
        (client) => client.visibilityState === "visible" && client.focused,
      );
      if (visible && message.kind === "turn") return;
      await self.registration.showNotification(message.title || "CodexHost", {
        body: message.body || "",
        tag: message.tag || undefined,
        renotify: Boolean(message.tag),
        icon: "icon-192.png",
        badge: "icon-192.png",
        data: { url: message.url || "./", sessionId: message.sessionId },
        requireInteraction: message.kind === "approval" || message.kind === "question",
      });
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || "./", self.registration.scope).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of windows) {
        if (client.url.startsWith(self.registration.scope)) {
          await client.focus();
          client.postMessage({
            type: "codexhost/open-session",
            sessionId: event.notification.data?.sessionId,
          });
          return;
        }
      }
      await self.clients.openWindow(target);
    })(),
  );
});
