const origins = new Set([
  "https://codex-pets.net",
  "https://codexpets.net",
  "https://pub-4976a79db284484f8d370de741d18cf9.r2.dev",
  "https://petdex.dev",
  "https://assets.petdex.dev",
]);

export function marketUrl(value, base) {
  const url = new URL(value, base);
  if (!origins.has(url.origin) || url.username || url.password || url.port)
    throw new Error("Unsupported market asset address");
  return url.href;
}

export async function download(value, { limit = 2 * 1024 * 1024, signal, timeoutMs = 6000 } = {}) {
  let url = marketUrl(value);
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([timeout, signal]) : timeout;
  for (let redirects = 0; redirects <= 4; redirects++) {
    const response = await fetch(url, {
      redirect: "manual",
      signal: combined,
      headers: {
        "user-agent": "CodexHost-Pet-Companion/1.0",
        accept: "application/json,image/*,application/zip",
      },
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      const location = response.headers.get("location");
      if (!location) throw new Error("Market redirect has no destination");
      url = marketUrl(location, url);
      continue;
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error(`Market request failed (HTTP ${response.status})`);
    }
    if (Number(response.headers.get("content-length")) > limit) {
      await response.body.cancel();
      throw new Error("Market asset exceeds the download limit");
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > limit) throw new Error("Market asset exceeds the download limit");
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, size);
  }
  throw new Error("Too many market redirects");
}

export async function json(url, options) {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await download(url, options)));
}

export async function text(url, options) {
  return new TextDecoder("utf-8", { fatal: true }).decode(await download(url, options));
}
