import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { expect, it } from "vitest";
import {
  COMPRESSION_THRESHOLD,
  compressResponse,
} from "../../packages/web-server/src/compression.ts";

const original = Buffer.from("压缩 response body\n".repeat(200));

it.each([
  ["gzip, br", "br"],
  ["gzip;q=1, br;q=0.1", "br"],
  ["gzip", "gzip"],
  ["br;q=0, gzip", "gzip"],
  ["br; q=0.000, gzip;q=0", undefined],
  ["GZIP; Q=0, BR", "br"],
  ["x-gzip, br-other", undefined],
  ["identity", undefined],
  [undefined, undefined],
])("negotiates %s as %s and round-trips the bytes", async (offer, encoding) => {
  const result = await compressResponse(original, "application/json; charset=utf-8", offer);
  expect(result.headers.vary).toBe("Accept-Encoding");
  expect(result.headers["content-encoding"]).toBe(encoding);
  if (encoding === undefined) expect(result.body).toBe(original);
  else {
    expect(result.body.length).toBeLessThan(original.length);
    expect((encoding === "br" ? brotliDecompressSync : gunzipSync)(result.body)).toEqual(original);
  }
});

it.each([COMPRESSION_THRESHOLD - 1, COMPRESSION_THRESHOLD, COMPRESSION_THRESHOLD + 1])(
  "applies the shared byte threshold at %i bytes",
  async (length) => {
    const body = Buffer.alloc(length, "a");
    const result = await compressResponse(body, "text/plain", "gzip");
    expect(result.headers.vary).toBe("Accept-Encoding");
    expect(result.headers["content-encoding"]).toBe(
      length < COMPRESSION_THRESHOLD ? undefined : "gzip",
    );
    expect(length < COMPRESSION_THRESHOLD ? result.body : gunzipSync(result.body)).toEqual(body);
  },
);

it.each([
  "text/plain",
  "text/html; charset=utf-8",
  "text/css",
  "text/javascript",
  "application/json",
  "application/javascript; charset=utf-8",
  "image/svg+xml",
  " Application/Manifest+JSON ; charset=utf-8",
])("compresses the main content type %s", async (type) => {
  const result = await compressResponse(original, type, "br");
  expect(result.headers).toEqual({ vary: "Accept-Encoding", "content-encoding": "br" });
  expect(brotliDecompressSync(result.body)).toEqual(original);
});

it.each(["image/png", "image/jpeg", "font/woff2", "application/octet-stream", "application/jsonp"])(
  "leaves %s unchanged without Vary",
  async (type) => {
    const result = await compressResponse(original, type, "br, gzip");
    expect(result.headers).toEqual({});
    expect(result.body).toBe(original);
  },
);

it("shares pending and completed compression by encoding and full URL only for immutable assets", async () => {
  const url = "/plugins/??cache-test&rev=one";
  const [first, concurrent] = await Promise.all([
    compressResponse(original, "text/javascript", "br", url),
    compressResponse(original, "text/javascript", "br", url),
  ]);
  expect(concurrent.body).toBe(first.body);
  expect((await compressResponse(original, "text/javascript", "br", url)).body).toBe(first.body);
  const gzip = await compressResponse(original, "text/javascript", "gzip", url);
  expect(gunzipSync(gzip.body)).toEqual(original);
  expect(gzip.body).not.toBe(first.body);
  const revised = await compressResponse(original, "text/javascript", "br", `${url}-new`);
  expect(revised.body).not.toBe(first.body);
  const uncached = await compressResponse(original, "text/javascript", "br");
  expect((await compressResponse(original, "text/javascript", "br")).body).not.toBe(uncached.body);
});

it("clears the whole immutable cache after it exceeds 64 entries", async () => {
  // Advance through a full cache window without exposing cache internals to tests.
  const results = [];
  for (let index = 0; index < 65; index++) {
    results.push(
      await compressResponse(original, "text/plain", "gzip", `/assets/eviction-${index}`),
    );
  }
  const again = await compressResponse(original, "text/plain", "gzip", "/assets/eviction-0");
  expect(again.body).not.toBe(results[0]?.body);
  expect(gunzipSync(again.body)).toEqual(original);
});
