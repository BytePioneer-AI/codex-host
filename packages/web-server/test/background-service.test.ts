import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { once } from "node:events";
import test from "node:test";
import { DataDir } from "../src/store.ts";
import {
  readServiceOptions,
  saveServiceOptions,
  SETTINGS_CHANGED_EXIT_CODE,
} from "../src/background-service.ts";
import { startServer } from "./support/server.ts";

function fixture(t: test.TestContext): DataDir {
  const root = mkdtempSync(join(tmpdir(), "web-background-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return new DataDir(root);
}

test("background settings default to loopback and preserve saved values on invalid input", (t) => {
  const data = fixture(t);
  assert.deepEqual(readServiceOptions(data), {
    host: "127.0.0.1",
    port: 4400,
    relayEnabled: false,
    relayRegistrations: {},
  });
  assert.equal(saveServiceOptions(data, { port: "4400" }), false);
  assert.equal(existsSync(data.path("service.json")), false);
  data.writeJson("service.json", { port: 4400 });
  assert.equal(saveServiceOptions(data, { port: "4400", host: "127.0.0.1" }), false);
  assert.deepEqual(JSON.parse(readFileSync(data.path("service.json"), "utf8")), { port: 4400 });
  const options = {
    host: "0.0.0.0",
    port: "4500",
    "public-url": "https://web.example/",
    "trusted-proxy": "127.0.0.1",
  };
  assert.equal(saveServiceOptions(data, options), true);
  assert.equal(saveServiceOptions(data, options), false);
  const bytes = readFileSync(data.path("service.json"), "utf8");
  for (const invalid of [
    { port: "invalid" },
    { port: "65536" },
    { "public-url": "https://web.example/path" },
    { "trusted-proxy": "bad" },
  ]) {
    assert.throws(() => saveServiceOptions(data, invalid));
    assert.equal(readFileSync(data.path("service.json"), "utf8"), bytes);
  }
  saveServiceOptions(data, { host: "", port: "", "public-url": "", "trusted-proxy": "" });
  assert.deepEqual(readServiceOptions(data), {
    host: "127.0.0.1",
    port: 4400,
    relayEnabled: false,
    relayRegistrations: {},
  });
  data.writeJson("service.json", { port: 4501, futureField: true });
  assert.deepEqual(readServiceOptions(data), {
    host: "127.0.0.1",
    port: 4501,
    relayEnabled: false,
    relayRegistrations: {},
  });
});

test("one-shot save reports changed, unchanged and invalid options without starting services", (t) => {
  const data = fixture(t);
  const save = (args: string[]) =>
    spawnSync(
      process.execPath,
      ["--import", "tsx", "src/main.ts", "--save-service-options", "--ch-data", data.root, ...args],
      {
        cwd: resolve(import.meta.dirname, ".."),
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          HOME: data.root,
          USERPROFILE: data.root,
          CODEX_HOME: data.path("codex"),
          CODEXHOST_DATA_DIR: data.root,
        },
      },
    );
  assert.equal(save(["--port", "4501"]).status, SETTINGS_CHANGED_EXIT_CODE);
  assert.deepEqual(readdirSync(data.root), ["web"]);
  assert.deepEqual(readdirSync(data.path("web")), ["service.json"]);
  assert.equal(save(["--port", "4501"]).status, 0);
  const saved = readFileSync(data.path("web/service.json"), "utf8");
  const invalid = save(["--trusted-proxy", "bad"]);
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /not an IP address/);
  assert.equal(readFileSync(data.path("web/service.json"), "utf8"), saved);
});

test("background HTTP publishes only private Web access data after listening", async (t) => {
  const data = fixture(t);
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((done) => reservation.close(() => done()));
  saveServiceOptions(data, { port: String(port) });
  const ready = data.path("ready.json");
  const url = await startServer(
    t,
    resolve(import.meta.dirname, ".."),
    ["--import", "tsx", "src/main.ts"],
    ["--background", "--data", data.root, "--ready-file", ready],
    {
      authenticated: true,
      environment: {
        CODEXHOST_DATA_DIR: data.path("host"),
        CODEX_HOME: data.path("codex"),
        CODEXHOST_WEB_HOST: "0.0.0.0",
      },
    },
  );
  assert.equal(new URL(url).hostname, "127.0.0.1");
  const record = JSON.parse(readFileSync(ready, "utf8"));
  assert.deepEqual(record, { address: url.split("?")[0], loginUrl: url });
  if (process.platform !== "win32") assert.equal(statSync(ready).mode & 0o077, 0);
  assert.equal((await fetch(url, { redirect: "manual" })).status, 302);
});

test("an occupied port fails without publishing readiness or closing the listener", async (t) => {
  const data = fixture(t);
  const occupied = createServer();
  occupied.listen(0, "127.0.0.1");
  await once(occupied, "listening");
  t.after(() => new Promise<void>((done) => occupied.close(() => done())));
  const port = (occupied.address() as { port: number }).port;
  saveServiceOptions(data, { port: String(port) });
  const ready = data.path("ready.json");
  await assert.rejects(
    startServer(
      t,
      resolve(import.meta.dirname, ".."),
      ["--import", "tsx", "src/main.ts"],
      ["--background", "--data", data.root, "--ready-file", ready],
      { environment: { CODEXHOST_DATA_DIR: data.path("host"), CODEX_HOME: data.path("codex") } },
    ),
    /is in use; use --port/,
  );
  assert.equal(occupied.listening, true);
  assert.equal(existsSync(ready), false);
});
