import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";

import { tailscaleServeState, tailscaleState } from "../src/tailscale-serve.ts";
import { fakeTailscale, RUNNING, serveStatus, SERVE_HOST } from "./support/tailscale.ts";

it("reports installation, backend, HTTPS and root forwarding states using only read commands", async (t) => {
  const cli = fakeTailscale(t);
  const original = process.env.PATH;
  process.env.PATH = cli.environment.PATH;
  t.after(() => {
    process.env.PATH = original;
  });
  const read = () => tailscaleState(4400, ["tailscale"]);
  assert.deepEqual(await read(), { status: "not-running" });
  cli.set({ BackendState: "NeedsLogin" });
  assert.deepEqual(await read(), { status: "not-logged-in" });
  cli.set({ BackendState: "Running", Self: {} });
  assert.deepEqual(await read(), { status: "https-disabled" });
  cli.set(RUNNING);
  assert.deepEqual(await read(), {
    status: "not-serving",
    command: "tailscale serve --bg http://127.0.0.1:4400",
  });
  cli.set(RUNNING, serveStatus(3000));
  assert.deepEqual(await read(), { status: "occupied", target: "http://127.0.0.1:3000" });
  for (const funnel of [false, true]) {
    cli.set(RUNNING, serveStatus(4400, funnel));
    assert.deepEqual(await read(), { status: "serving", url: `https://${SERVE_HOST}/`, funnel });
  }
  cli.set(RUNNING, {}, { raw: "not-json" });
  const invalid = await read();
  assert.equal(invalid.status, "error");
});

it("tries another CLI only after ENOENT", async (t) => {
  const cli = fakeTailscale(t);
  const fallback = fakeTailscale(t);
  const missing = join(cli.directory, "missing");
  assert.deepEqual(await tailscaleState(4400, [missing, cli.command]), { status: "not-running" });
  cli.set(RUNNING, serveStatus(4400));
  assert.equal((await tailscaleServeState(4400, [missing, cli.command])).status, "serving");
  for (const read of [tailscaleState, tailscaleServeState]) {
    assert.deepEqual(await read(4400, [missing, join(cli.directory, "also-missing")]), {
      status: "not-installed",
    });
    cli.set(RUNNING, {}, { raw: "not-json" });
    assert.equal((await read(4400, [cli.command, fallback.command])).status, "error");
  }
  assert.equal(readFileSync(fallback.log, "utf8"), "");
});

it("recognizes an HTTPS root on 8443 before reporting an occupied 443 root", async (t) => {
  const cli = fakeTailscale(t);
  const occupied = serveStatus(3000);
  for (const funnel of [false, true]) {
    cli.set(RUNNING, {
      TCP: { ...occupied.TCP, "8443": { HTTPS: true } },
      Web: {
        ...occupied.Web,
        [`${SERVE_HOST}:8443`]: { Handlers: { "/": { Proxy: "http://localhost:4400/" } } },
      },
      AllowFunnel: { [`${SERVE_HOST}:8443`]: funnel },
    });
    assert.deepEqual(await tailscaleState(4400, [cli.command]), {
      status: "serving",
      url: `https://${SERVE_HOST}:8443/`,
      funnel,
    });
  }
  cli.set(RUNNING, {
    TCP: { "8443": { HTTPS: true } },
    Web: { [`${SERVE_HOST}:8443`]: { Handlers: { "/": { Proxy: "http://localhost:3000/" } } } },
  });
  assert.equal((await tailscaleServeState(4400, [cli.command])).status, "not-serving");
});

it("reports a command timeout without blocking other access methods", async (t) => {
  const cli = fakeTailscale(t);
  const original = process.env.PATH;
  process.env.PATH = cli.environment.PATH;
  t.after(() => {
    process.env.PATH = original;
  });
  cli.set(RUNNING, {}, { delay: 10_000 });
  const start = Date.now();
  const state = await tailscaleState(4400, ["tailscale"]);
  assert.equal(state.status, "error");
  if (state.status === "error") assert.ok(state.message.length > 0);
  assert.ok(Date.now() - start < 4_000);
});
