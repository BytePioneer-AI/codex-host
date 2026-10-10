/** Relocated Web-only startup and late clients, with an isolated durable Harness. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { it } from "node:test";
import { build } from "esbuild";
import { discoverHostClientChannel } from "@codexhost/desktop-control";
import { encodeHarnessPluginRoute, harnessIdSchema } from "@codexhost/shared-contracts";
import { startServer } from "../support/server.ts";

const exec = promisify(execFile);
const repository = path.resolve(import.meta.dirname, "../../../..");

it(
  "relocated authenticated Web starts one independent Host and survives both Web processes exiting",
  { timeout: 90_000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "codexhost-shared-web-"));
    const input = path.join(root, "input"),
      plugin = path.join(input, "fixture");
    const data = path.join(root, "host-data"),
      codexHome = path.join(root, "codex");
    const out = path.join(root, "packed"),
      moved = path.join(root, "relocated");
    const env = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) =>
            !key.toUpperCase().startsWith("CODEXHOST_") &&
            !["NODE_OPTIONS", "NODE_PATH", "NODE_USE_ENV_PROXY"].includes(key.toUpperCase()),
        ),
      ),
      HOME: root,
      USERPROFILE: root,
      LOCALAPPDATA: path.join(root, "local-app-data"),
    };
    t.after(async () => {
      const launcher = path.join(
        moved,
        "native",
        process.platform === "win32" ? "codexhost.exe" : "codexhost",
      );
      if (await discoverHostClientChannel(path.join(data, "client-hosts")))
        await exec(
          launcher,
          [
            "host",
            "stop",
            "--node",
            process.execPath,
            "--host-runtime",
            path.join(moved, "host-runtime.mjs"),
            "--data",
            data,
          ],
          { env, timeout: 15_000 },
        );
      const end = Date.now() + 10_000;
      while (await discoverHostClientChannel(path.join(data, "client-hosts"))) {
        assert.ok(Date.now() < end, "isolated owner did not exit");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await rm(root, { recursive: true, force: true });
    });
    await mkdir(plugin, { recursive: true });
    await mkdir(codexHome);
    await build({
      entryPoints: [
        path.join(repository, "packages/host-runtime/test/fixtures/shared-host-plugin.ts"),
      ],
      bundle: true,
      platform: "node",
      format: "esm",
      outfile: path.join(plugin, "plugin.mjs"),
      logLevel: "silent",
    });
    await writeFile(
      path.join(plugin, "manifest.json"),
      JSON.stringify({
        manifestVersion: 1,
        id: "fixture",
        name: "Fixture",
        version: "0.0.0",
        adapterApiVersion: 1,
        entry: "./plugin.mjs",
      }),
    );
    await exec(
      process.execPath,
      [
        "--import",
        "tsx",
        path.join(repository, "packages/web-server/scripts/pack.ts"),
        out,
        "--adapters",
        input,
        "--harness",
        "fixture",
      ],
      { cwd: repository, env, timeout: 45_000 },
    );
    await rename(out, moved);
    await rm(input, { recursive: true });
    const args = ["--session-source", "codexhost", "--ch-data", data, "--ch-codex-home", codexHome];
    function client(raw: string) {
      const url = new URL(raw);
      const token = url.searchParams.get("token");
      assert.ok(token);
      return async (route: string, body: unknown) => {
        const response = await fetch(new URL(route, url), {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        assert.equal(response.status, 200);
        const reply = (await response.json()) as {
          result?: Record<string, unknown>;
          error?: unknown;
        };
        assert.equal(reply.error, undefined);
        assert.ok(reply.result);
        return reply.result;
      };
    }
    let threadId = "";
    await t.test(
      "first Web starts the service; closing Web does not stop an accepted Turn",
      async (viewer) => {
        const url = await startServer(viewer, root, [path.join(moved, "server.mjs")], args, {
          authenticated: true,
          environment: env,
        });
        assert.equal(
          (await fetch(new URL("/api/ch/v1/rpc", url), { method: "POST", body: "{}" })).status,
          401,
        );
        const rpc = client(url);
        const created = await rpc("/api/ch/v1/rpc", {
          method: "thread/start",
          params: {
            model: encodeHarnessPluginRoute({ harnessId: harnessIdSchema.parse("fixture") }),
            cwd: root,
          },
        });
        threadId = (created.thread as { id: string }).id;
        await rpc("/api/ch/v1/rpc", {
          method: "turn/start",
          params: {
            threadId,
            input: [{ type: "text", text: "fixture only" }],
            clientUserMessageId: "once",
          },
        });
      },
    );
    const owner = await discoverHostClientChannel(path.join(data, "client-hosts"));
    assert.ok(owner);
    await t.test(
      "a later Web receives the latest state without another Adapter or command",
      async (viewer) => {
        const url = await startServer(viewer, root, [path.join(moved, "server.mjs")], args, {
          authenticated: true,
          environment: env,
        });
        const rpc = client(url);
        const end = Date.now() + 10_000;
        while (
          !JSON.stringify(await rpc("/api/ch/v1/snapshot", { threadId })).includes(
            "completed without either viewer",
          )
        ) {
          assert.ok(Date.now() < end, "late client did not converge");
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        assert.equal(
          (await discoverHostClientChannel(path.join(data, "client-hosts")))?.epoch,
          owner.epoch,
        );
        assert.equal(
          (await readFile(path.join(data, "fixture-native/adapters.jsonl"), "utf8"))
            .trim()
            .split("\n").length,
          1,
        );
        assert.equal(
          (await readFile(path.join(data, "fixture-native/commands.jsonl"), "utf8"))
            .trim()
            .split("\n").length,
          1,
        );
        assert.deepEqual(
          await rpc("/api/ch/v1/rpc", { method: "codexhost/workspace/read", params: {} }),
          { projects: [], assignments: {}, projectless: [], pinned: [] },
        );
      },
    );
    assert.equal(
      (await discoverHostClientChannel(path.join(data, "client-hosts")))?.pid,
      owner.pid,
    );
  },
);
