/** Real entry-point defaults, using disposable homes and no native Harness requests. */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { startServer } from "./support/server.ts";
import { FakeChHost, startFakeChDebugger } from "./support/ch-host.ts";

for (const customHost of [false, true]) {
  it(`direct server stores its default Web profile under ${customHost ? "custom" : "default"} Host data`, async (t) => {
    const home = mkdtempSync(join(tmpdir(), "web-default-home-"));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const environment: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
    delete environment.CODEXHOST_WEB_DATA;
    delete environment.CODEXHOST_WEB_TOKEN;
    const hostRoot = join(home, customHost ? "custom-host" : ".codexhost");
    const debuggerServer = await startFakeChDebugger(new FakeChHost());
    t.after(() => debuggerServer.close());
    const url = await startServer(
      t,
      resolve(import.meta.dirname, ".."),
      ["--import", "tsx", "src/main.ts"],
      ["--ch-cdp", debuggerServer.endpoint, ...(customHost ? ["--ch-data", hostRoot] : [])],
      { authenticated: true, useDefaultData: true, environment },
    );
    assert.ok(new URL(url).searchParams.get("token"));
    assert.equal(existsSync(join(hostRoot, "web", "auth.json")), true);
    assert.equal(existsSync(join(hostRoot, "web", "push-keys.json")), true);
    assert.equal(existsSync(join(home, ".codexhost-web")), false);
    assert.equal(existsSync(join(home, ".codexhost-web-preview")), false);
  });
}
