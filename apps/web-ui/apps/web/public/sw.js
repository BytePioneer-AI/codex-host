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

const requestTimeout = 10_000;

async function navigate(request) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeout);
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
  const title = zh ? "正在连接…" : "Connecting…";
  const connecting = zh
    ? "正在自动重连，连接恢复后将继续打开。"
    : "Reconnecting automatically. Your page will open when ready.";
  const network = zh
    ? "等待网络恢复，将自动重连。"
    : "Waiting for your network. We'll reconnect automatically.";
  const help = zh
    ? "连接耗时较长，请检查网络并确认电脑上的 Web 正在运行。"
    : "This is taking longer than expected. Check your network and that Web is running on your computer.";
  return new Response(
    `<!doctype html>
<html lang="${zh ? "zh" : "en"}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, sans-serif; color: #202124; background: #f7f7f8; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; }
    main { width: 100%; max-width: 440px; text-align: center; }
    h1 { font-size: 1.25rem; }
    .spinner { width: 28px; height: 28px; margin: auto; border: 3px solid #8884; border-top-color: currentColor; border-radius: 50%; animation: spin 1s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }
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
    <div class="spinner" aria-hidden="true"></div>
    <h1>${title}</h1>
    <p id="description" role="status"></p>
    <div id="help" hidden>
      <p>${help}</p>
      <p id="address"></p>
    </div>
    <button type="button" id="retry">${zh ? "重试" : "Retry"}</button>
  </main>
  <script>
    let pending = false;
    let navigating = false;
    let retryTimer;
    let retryDelay = 1000;
    function updateDescription() {
      document.getElementById("description").textContent = navigator.onLine
        ? ${JSON.stringify(connecting)}
        : ${JSON.stringify(network)};
    }
    async function probe() {
      if (pending || navigating) return;
      clearTimeout(retryTimer);
      pending = true;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), ${requestTimeout});
      try {
        const response = await fetch(location.href, { cache: "no-store", signal: controller.signal });
        void response.body?.cancel().catch(() => {});
        if (![502, 503, 504].includes(response.status)) {
          navigating = true;
          location.reload();
        }
      } catch {
        // Keep the loading state while the connection recovers.
      } finally {
        clearTimeout(timer);
        pending = false;
        if (!navigating) {
          retryTimer = setTimeout(probe, retryDelay);
          retryDelay = Math.min(retryDelay * 2, 10000);
        }
      }
    }
    function retry() {
      retryDelay = 1000;
      probe();
    }
    document.getElementById("address").textContent = location.href;
    document.getElementById("retry").addEventListener("click", retry);
    updateDescription();
    setTimeout(() => { document.getElementById("help").hidden = false; }, 30000);
    probe();
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") retry();
    });
    window.addEventListener("online", () => {
      updateDescription();
      retry();
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
      // Web Push requires a visible notification even while the app is in the foreground.
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
