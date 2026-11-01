import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { it, type TestContext } from "node:test";
import { DesktopScreenshots } from "../src/desktop-screenshot.ts";
import { PNG } from "./support/image.ts";
import { startServer } from "./support/server.ts";

const output = `process.stdout.write(Buffer.from(${JSON.stringify(PNG)}, 'base64'));`;

async function fixture(t: TestContext, script: string, timeout = 2000) {
  const directory = mkdtempSync(join(tmpdir(), "codexhost-capture-test-"));
  const path = join(directory, "capture.cjs");
  const started = join(directory, "started");
  writeFileSync(
    path,
    `const fs=require('node:fs');
    const started=${JSON.stringify(started)};
    if(process.argv[2]!=='desktop-screenshot') process.exit(99);
    ${script}`,
  );
  const capture = new DesktopScreenshots([process.execPath, path], timeout);
  const server = createServer((request, response) => void capture.serve(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    capture.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  });
  const { port } = server.address() as AddressInfo;
  const take = (signal?: AbortSignal) =>
    fetch(`http://127.0.0.1:${String(port)}/`, { method: "POST", signal: signal ?? null });
  const waitStarted = async () => {
    for (let index = 0; index < 100 && !existsSync(started); index++) await delay(10);
    assert.ok(existsSync(started), "native fixture started");
  };
  return { take, waitStarted, capture };
}

it("returns one binary PNG with a fresh capture time and no cache", async (t) => {
  const { take } = await fixture(t, output);
  const response = await take();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.match(response.headers.get("cache-control") ?? "", /no-store/u);
  assert.ok(Number.isFinite(Date.parse(response.headers.get("x-codexhost-captured-at") ?? "")));
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from(PNG, "base64"));
});

it("maps native failures without exposing diagnostics, and rejects malformed images", async (t) => {
  for (const [code, status] of [
    ["unsupported", 501],
    ["permission-denied", 403],
    ["display-unavailable", 409],
    ["image-too-large", 413],
  ] as const) {
    const { take } = await fixture(
      t,
      `process.stderr.write('private-machine-details desktop-screenshot/${code}');process.exit(1);`,
    );
    const response = await take();
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { error: code });
  }
  const { take } = await fixture(t, "process.stdout.write('not an image');");
  assert.deepEqual(await (await take()).json(), { error: "capture-failed" });
});

it("bounds native output and terminates a timed-out capture before allowing another", async (t) => {
  const large = await fixture(
    t,
    "process.stdout.write(Buffer.alloc(21*1024*1024));setInterval(()=>{},1000);",
  );
  assert.deepEqual(await (await large.take()).json(), { error: "image-too-large" });
  const timed = await fixture(
    t,
    `if(fs.existsSync(started)){${output}}else{fs.writeFileSync(started,'');setInterval(()=>{},1000);}`,
    300,
  );
  assert.deepEqual(await (await timed.take()).json(), { error: "timeout" });
  assert.equal((await timed.take()).status, 200);
});

it("rejects concurrent requests and closes the capture process on service shutdown", async (t) => {
  const { take, waitStarted, capture } = await fixture(
    t,
    "fs.writeFileSync(started,'');setInterval(()=>{},1000);",
  );
  const first = take();
  await waitStarted();
  const busy = await take();
  assert.equal(busy.status, 429);
  assert.deepEqual(await busy.json(), { error: "busy" });
  capture.close();
  assert.deepEqual(await (await first).json(), { error: "capture-failed" });
  assert.deepEqual(await (await take()).json(), { error: "unavailable" });
});

it("cancels a disconnected viewer's process and releases its concurrency lease", async (t) => {
  const { take, waitStarted } = await fixture(
    t,
    `if(fs.existsSync(started)){${output}}else{fs.writeFileSync(started,'');setInterval(()=>{},1000);}`,
  );
  const controller = new AbortController();
  const first = take(controller.signal);
  await waitStarted();
  controller.abort();
  await assert.rejects(first);
  let next: Response | undefined;
  for (let index = 0; index < 100; index++) {
    next = await take();
    if (next.status !== 429) break;
    await next.text();
    await delay(10);
  }
  assert.equal(next?.status, 200);
});

it(
  "gates the real screenshot HTTP route with Web authentication and same origin",
  { timeout: 20_000 },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "codexhost-capture-auth-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const url = await startServer(
      t,
      resolve(import.meta.dirname, ".."),
      ["--import", "tsx", "src/main.ts"],
      ["--ch-launcher", join(directory, "missing-native-launcher")],
      { authenticated: true },
    );
    const address = new URL("api/desktop/screenshot", url);
    const token = new URL(url).searchParams.get("token");
    assert.ok(token);
    assert.equal((await fetch(address, { method: "POST" })).status, 401);
    const headers = { authorization: `Bearer ${token}`, origin: "https://untrusted.example" };
    assert.equal((await fetch(address, { method: "POST", headers })).status, 403);
    headers.origin = address.origin;
    const allowed = await fetch(address, { method: "POST", headers });
    assert.equal(allowed.status, 503);
    assert.deepEqual(await allowed.json(), { error: "unavailable" });
  },
);
