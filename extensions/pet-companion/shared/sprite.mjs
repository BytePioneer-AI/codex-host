import { createOtter } from "./otter.mjs";

const animation = {
  idle: [0, 6],
  working: [7, 6],
  waiting: [6, 6],
  success: [3, 4],
  error: [5, 8],
};

export function petState(activity, seen = { epoch: "", revision: 0 }) {
  const unread = (activity?.notifications ?? []).filter(
    (value) => seen.epoch !== activity.epoch || value.revision > seen.revision,
  );
  const status =
    activity?.waiting > 0
      ? "waiting"
      : activity?.running > 0
        ? "working"
        : unread.some((value) => value.kind === "failed")
          ? "error"
          : unread.length
            ? "success"
            : "idle";
  return { status, unread };
}

async function imageBlob(api, method, pet, signal) {
  const chunks = [];
  let offset = 0;
  let total = pet.bytes;
  do {
    signal?.throwIfAborted();
    const part = await api.backend.invoke(method, {
      key: pet.key,
      ...(pet.digest ? { digest: pet.digest } : {}),
      offset,
    });
    if (!part || typeof part.data !== "string" || part.total <= 0 || part.total > 8 * 1024 * 1024)
      throw new Error("Invalid sprite response");
    total = part.total;
    if (method === "preview") pet = { ...pet, mime: part.mime, atlas: part.atlas };
    const bytes = Uint8Array.from(atob(part.data), (character) => character.charCodeAt(0));
    if (bytes.length === 0 || offset + bytes.length > total)
      throw new Error("Incomplete sprite response");
    chunks.push(bytes);
    offset += bytes.length;
  } while (offset < total);
  return { blob: new Blob(chunks, { type: pet.mime }), atlas: pet.atlas };
}

export async function spriteBlob(api, pet, signal) {
  return (await imageBlob(api, "sprite", pet, signal)).blob;
}

export async function previewThumbnail(api, pet, signal) {
  const { blob, atlas } = await imageBlob(api, "preview", pet, signal);
  const url = URL.createObjectURL(blob);
  try {
    if (atlas) {
      const sprite = await createSprite(document.createElement("canvas"), url, signal);
      const result = sprite.thumbnail();
      sprite.dispose();
      return result;
    }
    const image = new Image();
    image.src = url;
    await image.decode();
    signal?.throwIfAborted();
    const canvas = document.createElement("canvas");
    const scale = Math.min(1, 192 / Math.max(image.naturalWidth, image.naturalHeight));
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/png");
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function createSprite(canvas, source, signal, renderer = "atlas") {
  const image = new Image();
  image.src = source;
  await image.decode();
  signal?.throwIfAborted();
  if (renderer === "otter") return createOtter(canvas, image, signal);
  if (image.naturalWidth !== 1536 || ![1872, 2288].includes(image.naturalHeight))
    throw new Error("Invalid sprite atlas");
  const scratch = canvas.ownerDocument.createElement("canvas");
  scratch.width = 192;
  scratch.height = 208;
  const probe = scratch.getContext("2d", { willReadFrequently: true });
  probe.drawImage(image, 0, 0, 192, 208, 0, 0, 192, 208);
  const pixels = probe.getImageData(0, 0, 192, 208).data;
  let left = 192,
    top = 208,
    right = 0,
    bottom = 0;
  for (let row = 0; row < 208; row++) {
    for (let column = 0; column < 192; column++) {
      if (pixels[(row * 192 + column) * 4 + 3] <= 24) continue;
      left = Math.min(left, column);
      right = Math.max(right, column);
      top = Math.min(top, row);
      bottom = Math.max(bottom, row);
    }
  }
  const bounds =
    right > left
      ? {
          left: Math.max(0, left - 12),
          top: Math.max(0, top - 12),
          right: Math.min(192, right + 12),
          bottom: Math.min(208, bottom + 12),
        }
      : { left: 0, top: 0, right: 192, bottom: 208 };
  const renderBounds = { ...bounds };
  for (const [atlasRow, count] of Object.values(animation)) {
    for (let atlasFrame = 0; atlasFrame < count; atlasFrame++) {
      probe.clearRect(0, 0, 192, 208);
      probe.drawImage(image, atlasFrame * 192, atlasRow * 208, 192, 208, 0, 0, 192, 208);
      const pixels = probe.getImageData(0, 0, 192, 208).data;
      for (let offset = 3; offset < pixels.length; offset += 4) {
        if (pixels[offset] <= 24) continue;
        const horizontal = ((offset - 3) / 4) % 192;
        const vertical = Math.floor((offset - 3) / (4 * 192));
        renderBounds.left = Math.min(renderBounds.left, horizontal);
        renderBounds.top = Math.min(renderBounds.top, vertical);
        renderBounds.right = Math.max(renderBounds.right, horizontal + 1);
        renderBounds.bottom = Math.max(renderBounds.bottom, vertical + 1);
      }
    }
  }
  probe.clearRect(0, 0, 192, 208);
  probe.drawImage(image, 0, 0, 192, 208, 0, 0, 192, 208);
  canvas.width = 384;
  canvas.height = 416;
  const context = canvas.getContext("2d");
  context.imageSmoothingEnabled = true;
  let status = "idle",
    frame = 0,
    last = 0,
    stopped = false;
  let request;
  const reduced = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const draw = (time) => {
    if (stopped || signal?.aborted) return;
    const [row, count] = animation[status] ?? animation.idle;
    if (time - last >= 140 && !canvas.ownerDocument.hidden) {
      frame = reduced ? 0 : (frame + 1) % count;
      last = time;
      const width = renderBounds.right - renderBounds.left;
      const height = renderBounds.bottom - renderBounds.top;
      const scale = Math.min(360 / width, 392 / height);
      context.clearRect(0, 0, 384, 416);
      context.drawImage(
        image,
        frame * 192,
        row * 208,
        192,
        208,
        (384 - width * scale) / 2 - renderBounds.left * scale,
        404 - renderBounds.bottom * scale,
        192 * scale,
        208 * scale,
      );
    }
    request = requestAnimationFrame(draw);
  };
  request = requestAnimationFrame(draw);
  const dispose = () => {
    stopped = true;
    cancelAnimationFrame(request);
    context.clearRect(0, 0, 384, 416);
  };
  signal?.addEventListener("abort", dispose, { once: true });
  return {
    setState(value) {
      if (value !== status) {
        status = value;
        frame = 0;
        last = 0;
      }
    },
    thumbnail() {
      return scratch.toDataURL("image/png");
    },
    avatar() {
      const avatar = canvas.ownerDocument.createElement("canvas");
      avatar.width = 64;
      avatar.height = 64;
      const painter = avatar.getContext("2d");
      const width = bounds.right - bounds.left;
      const side = Math.max(width, (bounds.bottom - bounds.top) * 0.62);
      painter.drawImage(
        image,
        Math.max(0, (bounds.left + bounds.right - side) / 2),
        bounds.top,
        Math.min(192, side),
        Math.min(208 - bounds.top, side),
        0,
        0,
        64,
        64,
      );
      painter.fillStyle = "#f47364";
      painter.beginPath();
      painter.arc(54, 10, 9, 0, Math.PI * 2);
      painter.fill();
      painter.strokeStyle = "#fff";
      painter.lineWidth = 3;
      painter.stroke();
      return avatar.toDataURL("image/png");
    },
    dispose() {
      signal?.removeEventListener("abort", dispose);
      dispose();
    },
  };
}
