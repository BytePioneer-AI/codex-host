/** Isolated Web + fake Launcher; exit 42 drives the test supervisor, never a file watcher. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { request } from "node:http";
import { once } from "node:events";
import type { ChildProcess } from "node:child_process";
import { join, resolve } from "node:path";
import type { TestContext } from "node:test";
import type { Locator, Page } from "playwright";
import type {
  WebAccessState,
  WebBackgroundState,
  WebTailscaleState,
} from "@codexhost/shared-contracts";
import { defined } from "./defined.ts";
import { nodeCommand } from "./node-command.ts";

type Replies = {
  "codexhost/accessTokenGet": WebAccessState;
  "codexhost/tailscaleServeSet": { state: WebTailscaleState; error?: string };
  "codexhost/lanSet": { changed: boolean };
  "codexhost/autostartSet": WebBackgroundState["autostart"];
};
interface Reply<T> {
  ok: boolean;
  value: T;
  error: { code: string; message: string; details: { url?: string } };
}
import { DataDir } from "../../src/store.ts";
import { saveServiceOptions, SETTINGS_CHANGED_EXIT_CODE } from "../../src/background-service.ts";
import { startServer } from "./server.ts";

/** The chosen address: a read-only input for one choice, a menu trigger for several. */
export function addressValue(address: Locator): Promise<string> {
  return address.evaluate((element) =>
    element instanceof HTMLInputElement ? element.value : (element.textContent ?? ""),
  );
}

/** The shared Tailscale row can already be checked for IP; choose its HTTPS sub-option too. */
export async function chooseTailscaleHttps(page: Page): Promise<void> {
  await page.locator('[data-connect-route="tailscale-https"]').getByRole("radio").check();
  const https = page.getByRole("radio", { name: "HTTPS", exact: true });
  if (await https.isVisible()) await https.check();
}

export async function connectServer(
  t: TestContext,
  environment: NodeJS.ProcessEnv,
  background = false,
  args: string[] = [],
) {
  const root = mkdtempSync(join(tmpdir(), "web-connect-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const data = new DataDir(join(root, "web"));
  const autostart = join(root, "autostart");
  const failure = join(root, "failure");
  writeFileSync(autostart, "off");
  const cli = nodeCommand(
    "launcher",
    `
const fs = require("node:fs");
const [command, action] = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(root)} + "/launcher-env-" + action, JSON.stringify({ node: process.env.CODEXHOST_NPM_NODE_PATH, wrapper: process.env.CODEXHOST_NPM_LAUNCHER_PATH }));
if (command !== "autostart" || !["on", "off", "status"].includes(action)) process.exit(99);
if (action === "status") console.log(fs.readFileSync(${JSON.stringify(autostart)}, "utf8"));
else if (fs.existsSync(${JSON.stringify(failure)})) { console.error(fs.readFileSync(${JSON.stringify(failure)}, "utf8")); process.exit(1); }
else fs.writeFileSync(${JSON.stringify(autostart)}, action);
`,
  );
  const launcher = cli.command;
  saveServiceOptions(data, { port: "4474" });
  const exits: number[] = [];
  let current: ChildProcess | undefined;
  let restarted: Promise<string> | undefined;
  const launch = (): Promise<string> =>
    startServer(
      t,
      resolve(import.meta.dirname, "../.."),
      ["--import", "tsx", "src/main.ts"],
      [
        "--data",
        data.root,
        "--port",
        "4474",
        "--ch-launcher",
        launcher,
        ...(background ? ["--background"] : []),
        ...args,
      ],
      {
        authenticated: true,
        environment: {
          ...environment,
          ...cli.environment,
          HOME: root,
          CODEXHOST_DATA_DIR: join(root, "host"),
          CODEX_HOME: join(root, "codex"),
          CODEXHOST_CONSOLE_PORT: "4475",
          SSH_CONNECTION: "smoke",
        },
        onSpawn(child) {
          current = child;
          child.on("exit", (code) => {
            if (code !== null) exits.push(code);
            if (code === SETTINGS_CHANGED_EXIT_CODE) restarted = launch();
          });
        },
      },
    );
  const url = new URL(await launch());
  const token = defined(url.searchParams.get("token") ?? undefined);
  url.search = "";
  const call = <M extends keyof Replies>(
    method: M,
    args = {},
    headers = {},
  ): Promise<Reply<Replies[M]>> =>
    new Promise((done, fail) => {
      const req = request(
        new URL(`/api/${method}`, url),
        {
          method: "POST",
          agent: false,
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${token}`,
            ...headers,
          },
        },
        (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => {
            body += chunk;
          });
          response.on("end", () => {
            try {
              done(JSON.parse(body).result);
            } catch (error) {
              fail(error);
            }
          });
        },
      );
      req.on("error", fail);
      req.end(JSON.stringify({ type: "client-request", rpcId: "test", method, payload: { args } }));
    });
  return {
    url,
    token,
    call,
    data,
    exits,
    access: async (): Promise<WebAccessState> => (await call("codexhost/accessTokenGet")).value,
    restarted: () => restarted,
    stop: async () => {
      const child = defined(current);
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    },
    autostart: () => readFileSync(autostart, "utf8"),
    launcherEnv: (action: string) =>
      JSON.parse(readFileSync(join(root, `launcher-env-${action}`), "utf8")),
    setAutostart: (state: string) => writeFileSync(autostart, state),
    failAutostart: (reason: string) => writeFileSync(failure, reason),
  };
}
