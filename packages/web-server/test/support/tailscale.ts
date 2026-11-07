/** PATH-first, read-only Tailscale fixture shared by unit, HTTP and browser tests. */
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

// Keep fake CLIs discoverable until all test-owned servers have exited.
const root = mkdtempSync(join(tmpdir(), "codexhost-tailscale-"));
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

export function fakeTailscale(t: TestContext) {
  const directory = mkdtempSync(join(root, "cli-"));
  const command = join(directory, "tailscale");
  const log = join(directory, "calls");
  writeFileSync(log, "");
  writeFileSync(
    command,
    `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2).join(" ");
fs.appendFileSync(path.join(__dirname, "calls"), args + "\\n");
if (args !== "status --json" && args !== "serve status --json") process.exit(99);
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixture.json"), "utf8"));
setTimeout(() => process.stdout.write(fixture.raw ?? JSON.stringify(args === "status --json" ? fixture.status : fixture.serve)), fixture.delay ?? 0);
`,
  );
  chmodSync(command, 0o755);
  const set = (
    status: unknown,
    serve: unknown = {},
    extra: { delay?: number; raw?: string } = {},
  ) => writeFileSync(join(directory, "fixture.json"), JSON.stringify({ status, serve, ...extra }));
  set({ BackendState: "Stopped" });
  t.after(() => {
    const calls = readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
    assert.ok(calls.every((args) => args === "status --json" || args === "serve status --json"));
  });
  return {
    directory,
    command,
    log,
    set,
    environment: { PATH: `${directory}:/usr/bin:/bin` },
  };
}

export const RUNNING = { BackendState: "Running", Self: { CapMap: { https: [] } } };
export const SERVE_HOST = "laptop.example.ts.net";
export function serveStatus(port: number, funnel = false) {
  return {
    TCP: { "443": { HTTPS: true } },
    Web: {
      [`${SERVE_HOST}:443`]: { Handlers: { "/": { Proxy: `http://127.0.0.1:${String(port)}` } } },
    },
    AllowFunnel: { [`${SERVE_HOST}:443`]: funnel },
  };
}
