/* CodexHost service worker: offline navigation, Web Push and notification clicks. */

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  if (event.request.mode === "navigate") event.respondWith(navigate(event.request));
});

async function navigate(request) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(request, { signal: controller.signal });
    return [502, 503, 504].includes(response.status) ? offlineResponse() : response;
  } catch {
    return offlineResponse();
  } finally {
    clearTimeout(timer);
  }
}

function offlineResponse() {
  const zh = navigator.language.startsWith("zh");
  const computer = zh
    ? ["无法连接到电脑", "请确认电脑开机，并且 Web 正在运行。"]
    : ["Unable to connect to your computer", "Make sure your computer is on and Web is running."];
  const network = zh
    ? ["网络已断开", "请检查这台设备的网络连接。"]
    : ["You are offline", "Check this device's network connection."];
  return new Response(
    `<!doctype html>
<html lang="${zh ? "zh" : "en"}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${computer[0]}</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, sans-serif; color: #202124; background: #f7f7f8; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; }
    main { width: 100%; max-width: 440px; }
    h1 { font-size: 1.5rem; }
    p { line-height: 1.6; }
    #address { overflow-wrap: anywhere; font-size: 0.875rem; color: #5f6368; }
    button { font: inherit; padding: 12px 24px; border: 1px solid #767676; border-radius: 8px; color: inherit; background: transparent; cursor: pointer; }
    @media (prefers-color-scheme: dark) {
      :root { color: #f1f3f4; background: #202124; }
      #address { color: #bdc1c6; }
    }
  </style>
</head>
<body>
  <main>
    <h1 id="title">${computer[0]}</h1>
    <p id="description"></p>
    <p id="address"></p>
    <button type="button" id="retry">${zh ? "重试" : "Retry"}</button>
  </main>
  <script>
    function updateDescription() {
      const [title, description] = navigator.onLine
        ? ${JSON.stringify(computer)}
        : ${JSON.stringify(network)};
      document.title = title;
      document.getElementById("title").textContent = title;
      document.getElementById("description").textContent = description;
    }
    async function probe() {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      try {
        const response = await fetch(location.href, { cache: "no-store", signal: controller.signal });
        if (![502, 503, 504].includes(response.status)) location.reload();
      } catch {
        // Network errors and timeouts leave the offline page in place.
      } finally {
        clearTimeout(timer);
      }
    }
    document.getElementById("address").textContent = location.href;
    document.getElementById("retry").addEventListener("click", probe);
    updateDescription();
    setInterval(probe, 10000);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") probe();
    });
    window.addEventListener("online", () => {
      updateDescription();
      probe();
    });
    window.addEventListener("offline", updateDescription);
    navigator.serviceWorker.addEventListener("message", (event) => {
      const { type, sessionId } = event.data;
      if (type === "codexhost/open-session" && typeof sessionId === "string") {
        location.href = "./?session=" + encodeURIComponent(sessionId);
      }
    });
  </script>
</body>
</html>`,
    {
      status: 503,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    },
  );
}

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
