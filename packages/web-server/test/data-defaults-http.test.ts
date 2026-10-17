/** Real entry-point defaults, using disposable homes and no native Harness requests. */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { startServer } from "./support/server.ts";

for (const customHost of [false, true]) {
  it(`direct server stores its default Web profile under ${customHost ? "custom" : "default"} Host data`, async (t) => {
    const home = mkdtempSync(join(tmpdir(), "web-default-home-"));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const environment: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
    delete environment.CODEXHOST_WEB_DATA;
    delete environment.CODEXHOST_WEB_TOKEN;
    const hostRoot = join(home, customHost ? "custom-host" : ".codexhost");
    const url = await startServer(
      t,
      resolve(import.meta.dirname, ".."),
      ["--import", "tsx", "src/main.ts"],
      ["--adapters", "test/fake-harness", ...(customHost ? ["--ch-data", hostRoot] : [])],
      { authenticated: true, useDefaultData: true, environment },
    );
    assert.ok(new URL(url).searchParams.get("token"));
    assert.equal(existsSync(join(hostRoot, "web", "auth.json")), true);
    assert.equal(existsSync(join(hostRoot, "web", "push-keys.json")), true);
    assert.equal(existsSync(join(home, ".codexhost-web")), false);
    assert.equal(existsSync(join(home, ".codexhost-web-preview")), false);
  });
}

it("direct server refuses an unmigrated old profile before creating new authentication", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "web-legacy-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const source = join(home, ".codexhost-web-preview");
  mkdirSync(source);
  writeFileSync(join(source, "auth.json"), "unchanged legacy data");
  const environment: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
  delete environment.CODEXHOST_WEB_DATA;
  await assert.rejects(
    startServer(
      t,
      resolve(import.meta.dirname, ".."),
      ["--import", "tsx", "src/main.ts"],
      ["--adapters", "test/fake-harness"],
      { authenticated: true, useDefaultData: true, environment },
    ),
    /migrate.*offline/u,
  );
  assert.equal(readFileSync(join(source, "auth.json"), "utf8"), "unchanged legacy data");
  assert.equal(existsSync(join(home, ".codexhost", "web")), false);
});
