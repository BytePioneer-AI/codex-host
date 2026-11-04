import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";

import { serveUrlsFromStatus, tailscaleServeAccessUrls } from "../src/tailscale-serve.ts";

const NAME = "laptop.example.ts.net";

function status(proxy: string, port = "443", https = true, path = "/"): unknown {
  return {
    TCP: { [port]: { HTTPS: https } },
    Web: { [`${NAME}:${port}`]: { Handlers: { [path]: { Proxy: proxy } } } },
  };
}

function fakeCli(t: TestContext, script: string): string {
  const directory = mkdtempSync(join(tmpdir(), "codexhost-fake-tailscale-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "tailscale");
  writeFileSync(path, `#!/bin/sh\n${script}\n`);
  chmodSync(path, 0o755);
  return path;
}

it("finds the HTTPS address that forwards to this server", () => {
  assert.deepEqual(serveUrlsFromStatus(status("http://127.0.0.1:4400"), 4400), [
    `https://${NAME}/`,
  ]);
  assert.deepEqual(serveUrlsFromStatus(status("http://localhost:4400/", "8443"), 4400), [
    `https://${NAME}:8443/`,
  ]);
});

it("ignores Serve configurations that do not reach this server over HTTPS", () => {
  for (const other of [
    status("http://127.0.0.1:3000"),
    status("http://192.168.1.2:4400"),
    status("http://127.0.0.1:4400/app"),
    status("http://127.0.0.1:4400", "80", false),
    status("http://127.0.0.1:4400", "443", true, "/web"),
    {},
    "not status",
  ]) {
    assert.deepEqual(serveUrlsFromStatus(other, 4400), []);
  }
});

it("reads the installed command and treats every failure as no address", async (t) => {
  const json = JSON.stringify(status("http://127.0.0.1:4400"));
  const working = fakeCli(t, `echo '${json}'`);
  const expected = [{ kind: "tailscale-https", url: `https://${NAME}/` }];
  assert.deepEqual(await tailscaleServeAccessUrls("0.0.0.0", 4400, [working]), expected);
  assert.deepEqual(await tailscaleServeAccessUrls("127.0.0.1", 4400, [working]), expected);
  // Serve forwards over loopback, which a specific interface does not listen on.
  assert.deepEqual(await tailscaleServeAccessUrls("192.168.1.2", 4400, [working]), []);

  const missing = join(tmpdir(), "codexhost-no-such-tailscale");
  assert.deepEqual(await tailscaleServeAccessUrls("0.0.0.0", 4400, [missing, working]), expected);
  assert.deepEqual(await tailscaleServeAccessUrls("0.0.0.0", 4400, [missing]), []);
  assert.deepEqual(
    await tailscaleServeAccessUrls("0.0.0.0", 4400, [fakeCli(t, "echo stopped >&2; exit 1")]),
    [],
  );
  assert.deepEqual(
    await tailscaleServeAccessUrls("0.0.0.0", 4400, [fakeCli(t, "echo not-json")]),
    [],
  );
});
