const prefix = "count:";
const idPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const json = (body, status = 200, headers = {}) =>
  Response.json(body, { status, headers: { ...cors, ...headers } });

function readCount(value) {
  if (typeof value !== "string" || !/^\d+$/u.test(value)) return undefined;
  const count = Number(value);
  return Number.isSafeInteger(count) ? count : undefined;
}

async function snapshot(kv) {
  const downloads = Object.create(null);
  let cursor;
  while (true) {
    const page = await kv.list({ prefix, cursor });
    const keys = page.keys
      .map(({ name }) => name)
      .filter((key) => idPattern.test(key.slice(prefix.length)));
    // KV bulk reads accept at most 100 keys per call.
    for (let offset = 0; offset < keys.length; offset += 100) {
      const values = await kv.get(keys.slice(offset, offset + 100));
      for (const [key, value] of values) {
        const count = readCount(value);
        if (count !== undefined) downloads[key.slice(prefix.length)] = count;
      }
    }
    if (page.list_complete) return downloads;
    cursor = page.cursor;
  }
}

export default {
  async fetch(request, { STATS_KV: kv }) {
    const { method } = request;
    const { pathname } = new URL(request.url);
    if (method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (method === "GET" && pathname === "/health") return json({ ok: true });
    try {
      if (method === "POST" && pathname.startsWith("/install/")) {
        let id;
        try {
          id = decodeURIComponent(pathname.slice("/install/".length));
        } catch {
          return json({ error: "Invalid extension ID" }, 400);
        }
        if (!idPattern.test(id)) return json({ error: "Invalid extension ID" }, 400);
        const key = `${prefix}${id}`;
        // KV read-modify-write is approximate: concurrent installs can race.
        const downloads = (readCount(await kv.get(key)) ?? 0) + 1;
        if (!Number.isSafeInteger(downloads)) throw new Error("Counter overflow");
        await kv.put(key, String(downloads));
        return json({ id, downloads });
      }
      if (method === "GET" && pathname === "/stats.json") {
        const downloads = await snapshot(kv);
        return json({ generatedAt: new Date().toISOString(), downloads }, 200, {
          "Cache-Control": "public, max-age=300",
        });
      }
      return json({ error: "Not found" }, 404);
    } catch {
      return json({ error: "Stats unavailable" }, 503);
    }
  },
};
