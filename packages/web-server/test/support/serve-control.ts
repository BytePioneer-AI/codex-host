/** Writable fake CLI: never falls through to an installed Tailscale executable. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { RUNNING, SERVE_HOST } from "./tailscale.ts";
import { nodeCommand } from "./node-command.ts";

export function fakeServe(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "web-serve-control-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "fixture.json");
  const log = join(directory, "calls");
  writeFileSync(log, "");
  const cli = nodeCommand(
    "tailscale",
    `
const fs = require("node:fs");
const file = ${JSON.stringify(file)};
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, args.join(" ") + "\\n");
const fixture = JSON.parse(fs.readFileSync(file, "utf8"));
if (args.join(" ") === "status --json") console.log(JSON.stringify(fixture.status));
else if (args.join(" ") === "serve status --json") console.log(JSON.stringify(fixture.serve));
else if (args[0] === "serve") {
  if (fixture.noop) process.exit(0);
  if (fixture.failure) { console.error(fixture.failure); process.exit(1); }
  const key = ${JSON.stringify(`${SERVE_HOST}:443`)};
  if (args[1] === "--bg" && args.length === 3) {
    fixture.serve.TCP ??= {}; fixture.serve.TCP["443"] = { HTTPS: true };
    fixture.serve.Web ??= {}; fixture.serve.Web[key] ??= { Handlers: {} };
    fixture.serve.Web[key].Handlers["/"] = { Proxy: args[2] };
  } else if (["serve --https=443 --set-path=/ off", "serve --https=8443 --set-path=/ off"].includes(args.join(" "))) {
    const port = args[1].slice("--https=".length);
    delete fixture.serve.Web[${JSON.stringify(SERVE_HOST)} + ":" + port].Handlers["/"];
  } else { console.error("unexpected mutation"); process.exit(99); }
  fs.writeFileSync(file, JSON.stringify(fixture));
} else process.exit(99);
`,
  );
  const set = (serve: unknown = {}, extra: { noop?: boolean; failure?: string } = {}) =>
    writeFileSync(file, JSON.stringify({ status: RUNNING, serve, ...extra }));
  set();
  return {
    set,
    read: () => JSON.parse(readFileSync(file, "utf8")).serve,
    mutations: () =>
      readFileSync(log, "utf8")
        .split("\n")
        .filter((line) => line && !line.endsWith("--json")),
    environment: { PATH: cli.directory, ...cli.environment },
  };
}
