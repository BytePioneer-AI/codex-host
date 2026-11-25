/** Unix release acceptance: node --import tsx .../release-smoke.ts <relocated-package-or-app> [npm-wrapper]. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { chromium } from "playwright";

const exec = promisify(execFile);
const packageRoot = process.argv[2];
const wrapper = process.argv[3];
if (wrapper !== undefined) assert.ok(isAbsolute(wrapper));
assert.ok(packageRoot && isAbsolute(packageRoot), "Pass an absolute relocated release root");
const root = mkdtempSync(join(tmpdir(), "codexhost-release-smoke-"));
const data = join(root, "data");
const home = join(root, "home");
mkdirSync(home);
const appBundle = packageRoot.endsWith(".app");
const resources = appBundle ? join(packageRoot, "Contents/Resources") : packageRoot;
const node = existsSync(join(resources, "runtime/node"))
  ? join(resources, "runtime/node")
  : process.execPath;
const launcher = appBundle
  ? join(packageRoot, "Contents/MacOS/codexhost")
  : join(packageRoot, "bin/codexhost");
const environment = {
  PATH: process.env.PATH,
  HOME: home,
  USERPROFILE: home,
  LOCALAPPDATA: home,
  XDG_RUNTIME_DIR: home,
  TMPDIR: root,
  CODEXHOST_DATA_DIR: data,
  CODEX_HOME: join(root, "codex"),
  CODEXHOST_INSTALL_ROOT: join(root, "no-desktop"),
  CODEXHOST_CONSOLE_PORT: "4467",
  SSH_CONNECTION: "smoke",
  SHELL: "/bin/sh",
};
for (const port of [4466, 4467]) {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve()));
  });
}
const run = (action: string, args: string[] = []) =>
  exec(
    wrapper ? node : launcher,
    wrapper ? [wrapper, action, ...args] : [action, "--node", node, ...args],
    {
      cwd: root,
      env: environment,
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
    },
  );
const pids: number[] = [];
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  const version = (await exec(launcher, ["--version"], { env: environment })).stdout.trim();
  const metadata = JSON.parse(
    readFileSync(join(resources, "app/codexhost-distribution.json"), "utf8"),
  );
  assert.equal(version, metadata.version);
  for (const option of ["--no-auth", "--dev-web-ui", "--ch-cdp"]) {
    await assert.rejects(
      exec(node, [join(resources, "app/web-server.mjs"), option], {
        cwd: root,
        env: environment,
      }),
      /Unknown option/u,
    );
  }
  await exec(
    node,
    [
      "--input-type=module",
      "-e",
      `
    import { createConverter } from '@deepseek-ai/libreoffice-kit';
    import koffi from 'koffi';
    import { chromium } from 'playwright-core';
    if (typeof createConverter !== 'function' || typeof koffi.load !== 'function' || typeof chromium.launch !== 'function') process.exit(1);
  `,
    ],
    { cwd: join(resources, "app/web-modules"), env: environment },
  );
  await run("web", ["--port", "4466"]);
  const web = JSON.parse(readFileSync(join(data, "web-service-ready.json"), "utf8"));
  const host = JSON.parse(readFileSync(join(data, "shared-host-ready.json"), "utf8"));
  assert.equal(web.version, version);
  assert.equal(host.version, version);
  assert.equal(realpathSync(web.runtime), realpathSync(join(resources, "app/web-server.mjs")));
  assert.equal(realpathSync(host.runtime), realpathSync(join(resources, "app/host-runtime.mjs")));
  assert.equal(existsSync(join(data, "host-builds")), false);
  pids.push(web.pid, web.web_pid, host.pid);
  pids.push(
    Number(
      (
        await exec("ps", ["-o", "ppid=", "-p", String(host.pid)], { env: environment })
      ).stdout.trim(),
    ),
  );
  const unchanged = await run("web");
  assert.match(unchanged.stdout, /running in the background/u);
  assert.equal(
    JSON.parse(readFileSync(join(data, "web-service-ready.json"), "utf8")).web_pid,
    web.web_pid,
  );
  const errors: string[] = [];
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(web.loginUrl);
  await page.locator("[data-sidebar-right-expand]").click();
  await page.locator('[data-sidebar-right-guide-entry="terminal"] button').first().click();
  const input = page.locator(".xterm-helper-textarea");
  try {
    await input.waitFor();
  } catch (error) {
    console.error(await page.locator("body").innerText());
    console.error(errors);
    await page.screenshot({ path: join(root, "terminal-failure.png") });
    throw error;
  }
  await page.locator(".xterm-rows").filter({ hasText: /[$#>]/u }).waitFor();
  await input.focus();
  await page.keyboard.insertText(
    `printf '%s\\n' "$HOME" "$PWD" "$$" > '${join(home, "terminal-proof")}'`,
  );
  await page.keyboard.press("Enter");
  const deadline = Date.now() + 20_000;
  while (!existsSync(join(home, "terminal-proof"))) {
    assert.ok(Date.now() < deadline, `Terminal failed: ${errors.join("; ")}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const [terminalHome, terminalCwd, terminalPid] = readFileSync(
    join(home, "terminal-proof"),
    "utf8",
  )
    .trim()
    .split("\n");
  assert.equal(terminalHome, home);
  assert.equal(terminalCwd, home);
  pids.push(Number(terminalPid));
  assert.deepEqual(errors, []);
  console.log(`Release ${version}: login, UI, terminal node-pty and direct Host runtime passed`);
  console.log(`Isolated data: ${data}; Web=4466 Console=4467`);
} finally {
  await browser?.close();
  const stopped = await run("stop");
  console.log(stopped.stdout.trim());
  assert.equal(existsSync(join(data, "web-service-ready.json")), false);
  assert.equal(existsSync(join(data, "shared-host-ready.json")), false);
  for (const pid of pids.filter((pid) => Number.isSafeInteger(pid) && pid > 0)) {
    const deadline = Date.now() + 5_000;
    let alive = true;
    while (alive) {
      try {
        process.kill(pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false;
        else throw error;
      }
      if (!alive) break;
      assert.ok(Date.now() < deadline, `Isolated service process ${pid} is still running`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  console.log("Stop verified: readiness cleared and recorded service/terminal processes exited");
}
