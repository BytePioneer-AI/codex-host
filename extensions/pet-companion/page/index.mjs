import { createSprite, petState, spriteBlob, previewThumbnail } from "../shared/sprite.mjs";
import { translate } from "./strings.mjs";

export function mount(root, api) {
  const doc = root.ownerDocument;
  const controller = new AbortController();
  const signal = controller.signal;
  let locale = api.locale;
  const message = (key) => translate(locale, key);
  root.innerHTML = `<section class="pet-app">
    <header class="hero"><div><p class="eyebrow">CODEXHOST / COMPANION</p><h1 data-label="title"></h1><p class="intro" data-label="subtitle"></p></div><button class="preferences-button secondary" data-label="settings" aria-expanded="false"></button></header>
    <div class="notice" role="status" hidden></div>
    <section class="current panel"><div class="current-copy"><p class="eyebrow" data-label="current"></p><h2 class="current-name"></h2><p class="current-meta"></p><div class="activity"><span class="state-chip"></span><span class="counts"></span></div><div class="current-actions"><button class="ack secondary" data-label="acknowledge"></button><button class="clear quiet" data-label="clear"></button></div></div><div class="current-preview"><div class="orbit"></div><canvas hidden></canvas><span class="empty-art" aria-hidden="true">✧</span></div></section>
    <section class="preferences panel" hidden><div class="section-head"><h2 data-label="preferencesTitle"></h2></div><label class="setting"><span><strong data-label="desktop"></strong><small data-label="desktopHint"></small></span><input class="desktop-visible" type="checkbox"></label><p class="native-unavailable" data-label="noNative" hidden></p><label class="setting"><span><strong data-label="favicon"></strong><small data-label="faviconHint"></small></span><input class="favicon-visible" type="checkbox"></label><label class="setting"><span><strong data-label="hover"></strong><small data-label="hoverHint"></small></span><input class="hover-expand" type="checkbox"></label><label class="setting"><span><strong data-label="bubble"></strong></span><input class="show-status" type="checkbox"></label><label class="setting"><span><strong data-label="lock"></strong><small data-label="lockHint"></small></span><input class="lock-position" type="checkbox"></label><label class="setting size-setting"><strong data-label="size"></strong><input class="size" type="range" min="120" max="260" step="4"><output class="size-value"></output></label><p class="window-error" role="status" hidden></p></section>
    <section class="library-section"><div class="section-head"><div><p class="eyebrow" data-label="library"></p><h2 data-label="libraryTitle"></h2></div><span class="library-count"></span></div><div class="library-grid"></div></section>
    <section class="market-section"><div class="section-head"><div><p class="eyebrow" data-label="market"></p><h2 data-label="marketTitle"></h2></div><button class="refresh quiet" data-label="refresh"></button></div><form class="market-tools"><select class="market-select"><option value="codex-pets">Codex Pets</option><option value="petdex">Petdex</option><option value="codexpets">CodexPets.net</option></select><input class="search" type="search" maxlength="160"><button type="submit" data-label="search"></button></form><div class="market-message" role="status"></div><div class="market-grid"></div><div class="pager"><button class="previous secondary" data-label="previous"></button><span class="page-label"></span><button class="next secondary" data-label="next"></button></div></section>
    <footer><span data-label="downloaded"></span><div><a href="https://codex-pets.net/" target="_blank" rel="noreferrer">Codex Pets ↗</a><a href="https://petdex.dev/" target="_blank" rel="noreferrer">Petdex ↗</a><a href="https://codexpets.net/gallery" target="_blank" rel="noreferrer">CodexPets.net ↗</a></div></footer>
  </section>`;
  const query = (selector) => root.querySelector(selector);
  const on = (selector, event, listener) =>
    query(selector).addEventListener(event, listener, { signal });
  const element = (tag, className, text) => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  };
  const call = async (method, params) => {
    signal.throwIfAborted();
    const result = await api.backend.invoke(method, params);
    signal.throwIfAborted();
    return result;
  };
  const show = (text, error = false) => {
    if (signal.aborted) return;
    const node = query(".notice");
    node.textContent = text;
    node.hidden = !text;
    node.dataset.error = String(error);
  };
  const run = (operation) =>
    void Promise.resolve()
      .then(operation)
      .catch((error) => {
        if (!signal.aborted) show(`${message("unavailable")} ${error.message ?? ""}`, true);
      });
  let snapshot;
  let seen = { epoch: "", revision: 0 };
  try {
    seen = JSON.parse(sessionStorage.getItem("cx-pet-notifications") ?? "null") ?? seen;
  } catch {
    seen = { epoch: "", revision: 0 };
  }
  let sprite,
    spriteUrl,
    spriteIdentity = "",
    spriteGeneration = 0;
  let poll,
    libraryFingerprint = "",
    searchGeneration = 0,
    page = 1,
    hasMore = false,
    lastJob = "";
  let libraryEvents = new AbortController(),
    marketEvents = new AbortController();
  const previewCache = new Map();
  const previewQueue = [];
  let previewWorkers = 0;
  const labels = () => {
    for (const node of root.querySelectorAll("[data-label]"))
      node.textContent = message(node.dataset.label);
    query(".search").placeholder = message("searchPlaceholder");
    query(".search").setAttribute("aria-label", message("search"));
    query(".market-select").setAttribute("aria-label", message("marketLabel"));
  };
  const loadPreview = async (image, pet) => {
    try {
      const cacheKey = pet.digest ?? pet.key;
      let data = previewCache.get(cacheKey);
      if (!data) {
        if (pet.digest) {
          const blob = await spriteBlob(api, pet, signal);
          const url = URL.createObjectURL(blob);
          try {
            const renderer = await createSprite(
              doc.createElement("canvas"),
              url,
              signal,
              pet.renderer,
            );
            data = renderer.thumbnail();
            renderer.dispose();
          } finally {
            URL.revokeObjectURL(url);
          }
        } else {
          data = await previewThumbnail(api, pet, signal);
        }
        if (data) previewCache.set(cacheKey, data);
        if (previewCache.size > 80) previewCache.delete(previewCache.keys().next().value);
      }
      if (data && !signal.aborted && image.isConnected) image.src = data;
    } catch {
      return;
    }
  };
  const enqueuePreview = (image, pet) => {
    previewQueue.push({ image, pet });
    if (previewWorkers >= 3) return;
    previewWorkers++;
    void (async () => {
      try {
        while (!signal.aborted && previewQueue.length) {
          const next = previewQueue.shift();
          if (next.image.isConnected) await loadPreview(next.image, next.pet);
        }
      } finally {
        previewWorkers--;
      }
    })();
  };
  const attribution = (pet, events) => {
    const details = element("details", "attribution");
    details.append(
      element("summary", "", message("attribution")),
      element("p", "", `${message("creator")}: ${pet.author || message("unknown")}`),
    );
    details.append(element("p", "", pet.license || message("noLicense")));
    if (pet.sourceUrl) {
      const link = element("a", "", `${message("source")} ↗`);
      link.href = pet.sourceUrl;
      link.target = "_blank";
      link.rel = "noreferrer";
      details.append(link);
    }
    if (pet.digest)
      details.addEventListener(
        "toggle",
        () => {
          if (!details.open || details.dataset.loaded) return;
          details.dataset.loaded = "true";
          run(async () => {
            const info = await call("details", { key: pet.key });
            for (const license of info.licenses)
              details.append(element("pre", "", `${license.name}\n${license.text}`));
          });
        },
        { signal: events },
      );
    return details;
  };
  const renderLibrary = () => {
    libraryEvents.abort();
    libraryEvents = new AbortController();
    const list = query(".library-grid");
    list.replaceChildren();
    query(".library-count").textContent =
      `${snapshot.pets.filter((pet) => !pet.builtin).length} / 64`;
    if (!snapshot.pets.length) {
      list.append(element("p", "empty", message("noLibrary")));
      return;
    }
    for (const pet of snapshot.pets) {
      const active = pet.key === snapshot.selected?.key;
      const card = element("article", `pet-card${active ? " selected" : ""}`);
      const image = element("img");
      image.alt = pet.name;
      const art = element("div", "card-art");
      art.append(image);
      card.append(
        art,
        element("h3", "", pet.builtin ? message("otterName") : pet.name),
        element("small", "", pet.author || message("unknown")),
      );
      const actions = element("div", "card-actions");
      const use = element(
        "button",
        active ? "secondary" : "",
        message(active ? "selected" : "use"),
      );
      use.disabled = active;
      use.addEventListener(
        "click",
        () =>
          run(async () => {
            await call("configure", { selectedKey: pet.key });
            await refreshStatus();
          }),
        { signal: libraryEvents.signal },
      );
      const remove = element("button", "quiet", message("remove"));
      remove.hidden = pet.builtin === true;
      remove.addEventListener(
        "click",
        () =>
          run(async () => {
            await call("remove", { key: pet.key });
            show(message("removed"));
            await refreshStatus();
          }),
        { signal: libraryEvents.signal },
      );
      actions.append(use, remove);
      if (pet.builtin) actions.append(element("small", "", message("builtin")));
      card.append(actions, attribution(pet, libraryEvents.signal));
      list.append(card);
      enqueuePreview(image, pet);
    }
  };
  const loadCurrent = async (pet) => {
    const generation = ++spriteGeneration;
    sprite?.dispose();
    sprite = undefined;
    if (spriteUrl) URL.revokeObjectURL(spriteUrl);
    spriteUrl = undefined;
    query("canvas").hidden = true;
    query(".empty-art").hidden = Boolean(pet);
    if (!pet) return;
    try {
      const blob = await spriteBlob(api, pet, signal);
      if (signal.aborted || generation !== spriteGeneration) return;
      const url = URL.createObjectURL(blob);
      const next = await createSprite(query("canvas"), url, signal, pet.renderer);
      if (signal.aborted || generation !== spriteGeneration) {
        next.dispose();
        URL.revokeObjectURL(url);
        return;
      }
      sprite = next;
      spriteUrl = url;
      query("canvas").hidden = false;
      sprite.setState(petState(snapshot.activity, seen).status);
    } catch (error) {
      if (!signal.aborted) {
        spriteIdentity = "";
        show(error.message, true);
      }
    }
  };
  const renderStatus = () => {
    const pet = snapshot.selected;
    const { status, unread } = petState(snapshot.activity, seen);
    query(".current-name").textContent = pet?.builtin
      ? message("otterName")
      : (pet?.name ?? message("noPet"));
    query(".current-meta").textContent = pet
      ? `${pet.author || message("unknown")} · ${pet.market}`
      : message("noPetDetail");
    query(".state-chip").textContent = message(status);
    query(".state-chip").dataset.state = status;
    query(".counts").textContent =
      `${snapshot.activity.running} ${message("running")} · ${snapshot.activity.waiting} ${message("awaiting")} · ${unread.length} ${message("unread")}`;
    query(".ack").disabled = !unread.length;
    query(".clear").disabled = !pet || pet.builtin === true;
    sprite?.setState(status);
    if ((pet?.digest ?? "") !== spriteIdentity) {
      spriteIdentity = pet?.digest ?? "";
      void loadCurrent(pet);
    }
    query(".desktop-visible").checked = snapshot.settings.desktopVisible !== false;
    query(".desktop-visible").disabled = !snapshot.capabilities.windows;
    query(".native-unavailable").hidden = snapshot.capabilities.windows;
    query(".favicon-visible").checked = snapshot.settings.faviconNotifications !== false;
    query(".hover-expand").checked = snapshot.settings.hoverExpand !== false;
    query(".show-status").checked = snapshot.settings.showStatus !== false;
    query(".lock-position").checked = snapshot.settings.lockPosition === true;
    if ((root.getRootNode().activeElement ?? doc.activeElement) !== query(".size"))
      query(".size").value = String(snapshot.settings.size ?? 192);
    query(".size-value").textContent = `${snapshot.settings.size ?? 192}px`;
    query(".window-error").textContent = snapshot.windowError;
    query(".window-error").hidden = !snapshot.windowError;
    const fingerprint = JSON.stringify([
      snapshot.pets.map((value) => [value.key, value.digest]),
      pet?.key,
      locale,
    ]);
    if (fingerprint !== libraryFingerprint) {
      libraryFingerprint = fingerprint;
      renderLibrary();
    }
    if (snapshot.job?.state === "working") show(message("downloading"));
    else if (snapshot.job && `${snapshot.job.id}:${snapshot.job.state}` !== lastJob) {
      show(
        snapshot.job.state === "failed" ? snapshot.job.error : message("adopted"),
        snapshot.job.state === "failed",
      );
      lastJob = `${snapshot.job.id}:${snapshot.job.state}`;
    }
  };
  async function refreshStatus() {
    snapshot = await call("status");
    renderStatus();
  }
  const pollStatus = async () => {
    try {
      await refreshStatus();
    } catch {
      if (!signal.aborted) show(message("unavailable"), true);
    }
    if (!signal.aborted) poll = setTimeout(pollStatus, 2500);
  };
  const search = async () => {
    const generation = ++searchGeneration;
    const statusMessage = query(".market-message");
    statusMessage.replaceChildren(element("p", "", message("loading")));
    query(".previous").disabled = true;
    query(".next").disabled = true;
    try {
      const result = await call("search", {
        market: query(".market-select").value,
        query: query(".search").value,
        page,
      });
      if (generation !== searchGeneration) return;
      hasMore = result.hasMore;
      marketEvents.abort();
      marketEvents = new AbortController();
      const grid = query(".market-grid");
      grid.replaceChildren();
      statusMessage.replaceChildren();
      if (!result.pets.length) statusMessage.append(element("p", "", message("empty")));
      for (const pet of result.pets) {
        const card = element("article", "market-card");
        const image = element("img");
        image.alt = pet.name;
        image.loading = "lazy";
        const art = element("div", "card-art");
        art.append(image);
        card.append(
          art,
          element("h3", "", pet.name),
          element("small", "", pet.author || message("unknown")),
          element("p", "description", pet.description),
        );
        const adopt = element("button", "", message("adopt"));
        adopt.addEventListener(
          "click",
          () =>
            run(async () => {
              adopt.disabled = true;
              try {
                await call("install", { key: pet.key });
                show(message("downloading"));
              } finally {
                if (!signal.aborted) adopt.disabled = false;
              }
            }),
          { signal: marketEvents.signal },
        );
        card.append(adopt, attribution(pet, marketEvents.signal));
        grid.append(card);
      }
      const images = [...grid.querySelectorAll("img")];
      images.forEach((image, position) => enqueuePreview(image, result.pets[position]));
      query(".page-label").textContent = `${message("page")} ${page}`;
      query(".previous").disabled = page <= 1;
      query(".next").disabled = !hasMore;
    } catch (error) {
      if (signal.aborted || generation !== searchGeneration) return;
      statusMessage.replaceChildren(
        element("p", "error", `${message("offline")} ${error.message ?? ""}`),
      );
      const retry = element("button", "secondary", message("retry"));
      retry.addEventListener("click", () => void search(), { signal });
      statusMessage.append(retry);
    }
  };
  on(".preferences-button", "click", () => {
    query(".preferences").hidden = !query(".preferences").hidden;
    query(".preferences-button").setAttribute(
      "aria-expanded",
      String(!query(".preferences").hidden),
    );
  });
  on(".market-tools", "submit", (event) => {
    event.preventDefault();
    page = 1;
    void search();
  });
  on(".market-select", "change", () => {
    page = 1;
    void search();
  });
  on(".refresh", "click", () => void search());
  on(".previous", "click", () => {
    page = Math.max(1, page - 1);
    void search();
  });
  on(".next", "click", () => {
    if (hasMore) {
      page++;
      void search();
    }
  });
  on(".clear", "click", () =>
    run(async () => {
      await call("configure", { selectedKey: "" });
      await refreshStatus();
    }),
  );
  on(".ack", "click", () =>
    run(async () => {
      seen = { epoch: snapshot.activity.epoch, revision: snapshot.activity.revision };
      try {
        sessionStorage.setItem("cx-pet-notifications", JSON.stringify(seen));
      } catch {
        seen = { ...seen };
      }
      doc.dispatchEvent(new CustomEvent("cx-pet-ack", { detail: seen }));
      if (api.hostTarget === "desktop") await call("acknowledge");
      show(message("read"));
      renderStatus();
    }),
  );
  for (const [selector, key] of [
    [".desktop-visible", "desktopVisible"],
    [".favicon-visible", "faviconNotifications"],
    [".hover-expand", "hoverExpand"],
    [".show-status", "showStatus"],
    [".lock-position", "lockPosition"],
  ])
    on(selector, "change", (event) =>
      run(async () => {
        await call("configure", { [key]: event.target.checked });
        await refreshStatus();
      }),
    );
  on(".size", "input", (event) => {
    query(".size-value").textContent = `${event.target.value}px`;
  });
  on(".size", "change", (event) =>
    run(async () => {
      await call("configure", { size: Number(event.target.value) });
      await refreshStatus();
    }),
  );
  const stopLocale = api.onLocaleChange?.((next) => {
    locale = next;
    labels();
    libraryFingerprint = "";
    if (snapshot) renderStatus();
    void search();
  });
  const dispose = () => {
    if (signal.aborted) return;
    controller.abort();
    libraryEvents.abort();
    marketEvents.abort();
    clearTimeout(poll);
    spriteGeneration++;
    sprite?.dispose();
    if (spriteUrl) URL.revokeObjectURL(spriteUrl);
    stopLocale?.();
    root.replaceChildren();
  };
  api.signal.addEventListener("abort", dispose, { once: true });
  labels();
  run(pollStatus);
  void search();
  return () => {
    api.signal.removeEventListener("abort", dispose);
    dispose();
  };
}
