import { createSprite, petState, spriteBlob } from "../shared/sprite.mjs";

export function activate(api) {
  if (!api.tabIcon) return;
  let stopped = false,
    timer,
    identity,
    avatar,
    updating;
  let seen;
  try {
    seen = JSON.parse(sessionStorage.getItem("cx-pet-notifications") ?? "null");
  } catch {
    seen = null;
  }
  seen ??= { epoch: "", revision: 0 };
  const update = () =>
    (updating ??= (async () => {
      try {
        const state = await api.backend.invoke("status");
        if (stopped) return;
        const { unread } = petState(state.activity, seen);
        if (
          !state.settings.faviconNotifications ||
          !state.selected ||
          !unread.length ||
          document.hidden
        ) {
          api.tabIcon.set(null);
        } else {
          const pet = state.selected;
          if (identity !== pet.digest) {
            const blob = await spriteBlob(api, pet, api.signal);
            const url = URL.createObjectURL(blob);
            try {
              const next = await createSprite(
                document.createElement("canvas"),
                url,
                api.signal,
                pet.renderer,
              );
              if (stopped) {
                next.dispose();
                return;
              }
              avatar = next.avatar();
              next.dispose();
              identity = pet.digest;
            } finally {
              URL.revokeObjectURL(url);
            }
          }
          if (!stopped && !document.hidden && petState(state.activity, seen).unread.length)
            api.tabIcon.set(avatar);
        }
      } catch {
        if (!stopped) api.tabIcon.set(null);
      }
    })().finally(() => {
      updating = undefined;
      if (!stopped) {
        clearTimeout(timer);
        timer = setTimeout(update, 2500);
      }
    }));
  const acknowledged = (event) => {
    if (
      !event.detail ||
      typeof event.detail.epoch !== "string" ||
      !Number.isInteger(event.detail.revision)
    )
      return;
    seen = event.detail;
    try {
      sessionStorage.setItem("cx-pet-notifications", JSON.stringify(seen));
    } catch {}
    api.tabIcon.set(null);
  };
  const visible = () => {
    clearTimeout(timer);
    if (!document.hidden) void update();
    else api.tabIcon.set(null);
  };
  document.addEventListener("cx-pet-ack", acknowledged);
  document.addEventListener("visibilitychange", visible);
  void update();
  return () => {
    stopped = true;
    clearTimeout(timer);
    document.removeEventListener("cx-pet-ack", acknowledged);
    document.removeEventListener("visibilitychange", visible);
  };
}
