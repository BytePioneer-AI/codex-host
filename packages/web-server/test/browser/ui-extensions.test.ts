/** Real browser lifecycle, with an optional unchanged upstream archive for release verification. */
import assert from "node:assert/strict";
import { execFile, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it, type TestContext } from "node:test";
import { promisify } from "node:util";
import { chromium, type Page } from "playwright";
import type { WebUiExtensionsState } from "@codexhost/shared-contracts";
import { startServer } from "../support/server.ts";

const exec = promisify(execFile);
const serverRoot = resolve(import.meta.dirname, "../..");
const TOKEN = "web-extensions-browser-test-token";
const FIXTURE_ID = "@fixture/browser-theme";

async function rpc(url: string, action: string, args: object = {}): Promise<WebUiExtensionsState> {
  const method = `codexhost/uiExtensions/${action}`;
  const response = await fetch(new URL(`/api/${method}`, url), {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ type: "client-request", rpcId: "test", method, payload: { args } }),
  });
  const envelope = (await response.json()) as {
    result: { ok: boolean; value: WebUiExtensionsState; error?: unknown };
  };
  assert.equal(envelope.result.ok, true, JSON.stringify(envelope.result.error));
  return envelope.result.value;
}

async function fixtureArchive(root: string): Promise<string> {
  const directory = join(root, "fixture");
  mkdirSync(join(directory, "lib"), { recursive: true });
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({
      name: FIXTURE_ID,
      version: "1.0.0",
      description: "A fixture Web theme.",
      icon: "./icon.svg",
      type: "module",
      exports: {
        ".": "./host.js",
        "./client": "./lib/client.js",
        "./package.json": "./package.json",
      },
      dsh: {
        client: {
          platform: "web",
          inject: ["@deepseek-ai/dsh-client-ui-theme"],
          immediately: true,
        },
      },
      scripts: { install: "node -e \"throw new Error('scripts must not execute')\"" },
    }),
  );
  writeFileSync(
    join(directory, "host.js"),
    `export const inject=['webServer'];
    export function apply(ctx){ctx.effect(()=>ctx.webServer.register({kind:'exact',path:'/extension-probe',handler(_req,res){res.end('native host')}}))}`,
  );
  writeFileSync(
    join(directory, "icon.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle cx="8" cy="8" r="7"/></svg>',
  );
  writeFileSync(
    join(directory, "lib/client.js"),
    `window.__ModuleLoader__.load({id:${JSON.stringify(FIXTURE_ID)},factory:()=>({inject:['theme'],apply(ctx){ctx.effect(()=>ctx.theme.overrideTokens('fixture',{'--dsw-alias-brand-primary':{light:'#123456',dark:'#123456'}}))}})});`,
  );
  const { stdout } = await exec(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["pack", "--ignore-scripts", "--json", "--pack-destination", root],
    { cwd: directory },
  );
  const [packed] = JSON.parse(stdout) as { filename: string }[];
  assert.ok(packed);
  return join(root, packed.filename);
}

function installedId(registry: { extensions: { installId: string }[] }): string {
  const [entry] = registry.extensions;
  assert.ok(entry);
  return entry.installId;
}

async function stop(child: ChildProcess | undefined): Promise<void> {
  assert.ok(child);
  if (child.exitCode !== null || child.signalCode !== null) return;
  const ended = once(child, "exit");
  child.kill("SIGTERM");
  await ended;
}

async function openSettings(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByText("Interface extensions", { exact: true }).first().click();
  await page.locator("[data-web-extensions]").waitFor();
}

async function installFromSettings(
  page: Page,
  spec: string,
  options: { registry?: string; screenshot?: string } = {},
): Promise<void> {
  await page.getByRole("button", { name: "Add extension", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add extension", exact: true });
  await dialog.getByRole("textbox", { name: "Package name or address", exact: true }).fill(spec);
  if (options.registry) {
    await dialog
      .getByRole("combobox", { name: "Installation source", exact: true })
      .selectOption("custom");
    await dialog
      .getByRole("textbox", { name: "Custom registry URL", exact: true })
      .fill(options.registry);
  }
  if (options.screenshot)
    await page.screenshot({ path: options.screenshot, fullPage: true, animations: "disabled" });
  await dialog.getByRole("button", { name: "Install", exact: true }).click();
  await dialog.waitFor({ state: "hidden", timeout: 120_000 });
}

async function roundTrip(t: TestContext, source?: string): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "codexhost-extension-browser-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const real = source !== undefined;
  source ??= await fixtureArchive(root);
  const id = real ? "@frostgao/dsh-theme-blackgold" : FIXTURE_ID;
  const expected = real ? "#CFB53B" : "#123456";
  const screenshots = process.env.CODEXHOST_TEST_EXTENSION_SCREENSHOTS;
  const data = join(root, "data");
  let child: ChildProcess | undefined;
  const launch = async (args: string[] = []): Promise<string> =>
    startServer(
      t,
      serverRoot,
      ["--import", "tsx", "src/main.ts"],
      ["--data", data, "--token", TOKEN, ...args],
      {
        authenticated: true,
        useDefaultData: true,
        onSpawn: (process) => {
          child = process;
        },
      },
    );
  const url = await launch();
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ locale: "en-US", colorScheme: "light" });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(url);
  await page.getByRole("button", { name: "Settings", exact: true }).waitFor();
  const baseline = await page.evaluate(() =>
    getComputedStyle(document.body).getPropertyValue("--dsw-alias-brand-primary").trim(),
  );
  const baselineMarks = await page.locator('[data-codexhost-mark="otter"]').count();
  assert.ok(baselineMarks > 0);
  await openSettings(page);
  if (screenshots && real) mkdirSync(screenshots, { recursive: true });
  await installFromSettings(page, source, {
    ...(screenshots && real
      ? { screenshot: join(screenshots, "extensions-install-dialog.png") }
      : {}),
  });
  const row = page.locator(`[data-web-extension="${id}"]`);
  await row.waitFor({ timeout: 60_000 });
  if (!real) {
    await row.getByText("A fixture Web theme.", { exact: true }).waitFor();
    assert.ok(
      (await rpc(url, "list")).extensions[0]?.meta?.icon?.startsWith("data:image/svg+xml;base64,"),
    );
  }
  assert.deepEqual((await rpc(url, "list")).extensions[0]?.enabledTargets, []);
  await row.getByRole("switch", { name: id, exact: true }).click();
  await row.getByRole("switch", { name: id, exact: true, checked: true }).waitFor();
  if (screenshots && real) {
    mkdirSync(screenshots, { recursive: true });
    await page.screenshot({ path: join(screenshots, "extensions-management.png"), fullPage: true });
  }
  assert.deepEqual((await rpc(url, "list")).loadedIds, [id]);
  if (real) {
    const registry = JSON.parse(
      readFileSync(join(data, "ui-extensions/installed.json"), "utf8"),
    ) as { extensions: { installId: string }[] };
    const client = readFileSync(
      join(
        data,
        "ui-extensions/packages",
        installedId(registry),
        "node_modules",
        id,
        "lib/client.js",
      ),
    );
    assert.equal(
      createHash("sha256").update(client).digest("hex"),
      "ba0438d0ccfdac090819bf4a88abbfd2b122af8d6a1a3912da5edce19bb03f92",
    );
  }
  await page.waitForFunction(
    (color) =>
      getComputedStyle(document.body).getPropertyValue("--dsw-alias-brand-primary").trim() ===
      color,
    expected,
  );
  await page.getByRole("button", { name: "Settings", exact: true }).waitFor();
  assert.deepEqual((await rpc(url, "list")).loadedIds, [id]);
  if (!real)
    assert.equal(
      await (await page.request.get(new URL("/extension-probe", url).href)).text(),
      "native host",
    );
  if (real) {
    assert.equal(await page.locator(`style[data-plugin="${id}"]`).count(), 1);
    assert.equal(await page.locator(".dsh-gold-mark").count(), baselineMarks);
    assert.equal(await page.locator('[data-codexhost-mark="otter"]').count(), 0);
  }
  if (screenshots && real) {
    mkdirSync(screenshots, { recursive: true });
    await page.screenshot({ path: join(screenshots, "blackgold-enabled.png"), fullPage: true });
  }

  // Recovery remains built-in only while ordinary pages synchronize live.
  await page.goto(new URL("/?extensions=off", url).href);
  await page.getByRole("button", { name: "Settings", exact: true }).waitFor();
  assert.equal(
    await page.evaluate(() =>
      getComputedStyle(document.body).getPropertyValue("--dsw-alias-brand-primary").trim(),
    ),
    baseline,
  );
  await page.goto(new URL("/extensions", url).href);
  await page.getByRole("button", { name: "禁用 / Disable", exact: true }).click();
  await page.getByRole("button", { name: "启用 / Enable", exact: true }).waitFor();
  assert.deepEqual((await rpc(url, "list")).extensions[0]?.enabledTargets, []);

  await page.goto(url);
  await page.getByRole("button", { name: "Settings", exact: true }).waitFor();
  assert.equal(
    await page.evaluate(() =>
      getComputedStyle(document.body).getPropertyValue("--dsw-alias-brand-primary").trim(),
    ),
    baseline,
  );
  assert.deepEqual((await rpc(url, "list")).loadedIds, []);
  if (!real)
    assert.equal((await page.request.get(new URL("/extension-probe", url).href)).status(), 404);
  assert.equal(await page.locator('[data-codexhost-mark="otter"]').count(), baselineMarks);
  assert.equal(await page.locator(".dsh-gold-mark").count(), 0);
  if (screenshots && real)
    await page.screenshot({ path: join(screenshots, "blackgold-disabled.png"), fullPage: true });
  assert.deepEqual(errors, []);
  await stop(child);
}

it(
  "installs a prebuilt client through settings, loads live and recovers by disabling",
  { timeout: 120_000 },
  async (t) => roundTrip(t),
);

it(
  "runs the unchanged upstream blackgold archive through installation and disable recovery",
  {
    timeout: 120_000,
    skip: !process.env.CODEXHOST_TEST_DSH_EXTENSION_ARCHIVE,
  },
  async (t) => roundTrip(t, process.env.CODEXHOST_TEST_DSH_EXTENSION_ARCHIVE),
);

it(
  "runs the original blackgold GitHub source through installation and disable recovery",
  {
    timeout: 180_000,
    skip: !process.env.CODEXHOST_TEST_DSH_EXTENSION_GITHUB,
  },
  async (t) => roundTrip(t, process.env.CODEXHOST_TEST_DSH_EXTENSION_GITHUB),
);

it(
  "installs a bare package from the chosen registry and snapshots a local directory",
  { timeout: 120_000 },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), "codexhost-extension-sources-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const archive = await fixtureArchive(root);
    const archiveBytes = readFileSync(archive);
    const directory = join(root, "fixture");
    const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as Record<
      string,
      unknown
    >;
    const requests: string[] = [];
    const registry = createServer((request, response) => {
      const path = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
      requests.push(path);
      if (path === `/${FIXTURE_ID}`) {
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            name: FIXTURE_ID,
            "dist-tags": { latest: "1.0.0" },
            versions: {
              "1.0.0": {
                ...manifest,
                dist: {
                  tarball: `${registryUrl}fixture.tgz`,
                  integrity: `sha512-${createHash("sha512").update(archiveBytes).digest("base64")}`,
                },
              },
            },
          }),
        );
      } else if (path === "/fixture.tgz") {
        response.setHeader("content-type", "application/octet-stream");
        response.end(archiveBytes);
      } else {
        response.writeHead(404).end();
      }
    });
    registry.listen(0, "127.0.0.1");
    await once(registry, "listening");
    t.after(() => new Promise<void>((resolve) => registry.close(() => resolve())));
    const address = registry.address();
    assert.ok(address && typeof address !== "string");
    const registryUrl = `http://127.0.0.1:${address.port}/`;
    const data = join(root, "data");
    let child: ChildProcess | undefined;
    const launch = () =>
      startServer(
        t,
        serverRoot,
        ["--import", "tsx", "src/main.ts"],
        ["--data", data, "--token", TOKEN],
        {
          authenticated: true,
          useDefaultData: true,
          onSpawn: (process) => {
            child = process;
          },
        },
      );
    let url = await launch();
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ locale: "en-US", colorScheme: "light" });
    await page.goto(url);
    await openSettings(page);
    await installFromSettings(page, FIXTURE_ID, { registry: registryUrl });
    const row = page.locator(`[data-web-extension="${FIXTURE_ID}"]`);
    await row.waitFor();
    assert.ok(
      requests.includes(`/${FIXTURE_ID}`),
      "the selected registry must resolve the bare name",
    );
    assert.equal((await rpc(url, "list")).extensions[0]?.version, "1.0.0");
    assert.deepEqual((await rpc(url, "list")).extensions[0]?.enabledTargets, []);
    await row.getByRole("button", { name: FIXTURE_ID, exact: true }).click();
    const detail = page.locator(`[data-web-extension-detail="${FIXTURE_ID}"]`);
    await detail.getByRole("button", { name: "Uninstall", exact: true }).click();
    await detail.getByRole("button", { name: "Uninstall", exact: true }).click();
    await detail.waitFor({ state: "hidden" });
    await installFromSettings(page, directory);
    await row.waitFor();
    rmSync(directory, { recursive: true, force: true });
    await row.getByRole("switch", { name: FIXTURE_ID, exact: true }).click();
    await row.getByRole("switch", { name: FIXTURE_ID, exact: true, checked: true }).waitFor();
    await stop(child);
    url = await launch();
    await page.goto(url);
    await page.waitForFunction(
      () =>
        getComputedStyle(document.body).getPropertyValue("--dsw-alias-brand-primary").trim() ===
        "#123456",
    );
    assert.deepEqual((await rpc(url, "list")).loadedIds, [FIXTURE_ID]);
    await stop(child);
  },
);

it(
  "keeps recovery available when an enabled browser plugin throws",
  { timeout: 60_000 },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), "codexhost-extension-failure-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const archive = await fixtureArchive(root);
    const data = join(root, "data");
    let child: ChildProcess | undefined;
    const launch = async (args: string[] = []) =>
      startServer(
        t,
        serverRoot,
        ["--import", "tsx", "src/main.ts"],
        ["--data", data, "--token", TOKEN, ...args],
        {
          authenticated: true,
          useDefaultData: true,
          onSpawn: (process) => {
            child = process;
          },
        },
      );
    let url = await launch();
    await rpc(url, "install", { spec: archive });
    await rpc(url, "setEnabled", { id: FIXTURE_ID, enabled: true });
    const registry = JSON.parse(
      readFileSync(join(data, "ui-extensions/installed.json"), "utf8"),
    ) as { extensions: { installId: string }[] };
    const client = join(
      data,
      "ui-extensions/packages",
      installedId(registry),
      "node_modules",
      FIXTURE_ID,
      "lib/client.js",
    );
    writeFileSync(
      client,
      `window.__ModuleLoader__.load({id:${JSON.stringify(FIXTURE_ID)},factory:()=>({apply(){throw new Error('fixture plugin failure')}})});`,
    );
    await stop(child);
    url = await launch();
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ locale: "en-US" });
    await page.goto(url);
    await page.getByText("Failed to load plugins", { exact: true }).waitFor();
    await page.getByRole("link", { name: "管理扩展 / Manage extensions", exact: true }).click();
    await page.getByRole("button", { name: "禁用 / Disable", exact: true }).waitFor();
    await stop(child);
    rmSync(client);
    url = await launch();
    await page.goto(url);
    await page.getByRole("button", { name: "Settings", exact: true }).waitFor();
    const damaged = await rpc(url, "list");
    assert.deepEqual(damaged.loadedIds, []);
    assert.ok(damaged.extensions[0]?.loadError);
    assert.deepEqual(damaged.extensions[0]?.enabledTargets, ["web"]);
    // Safe mode leaves the user's desired enablement unchanged while excluding the broken package.
    await stop(child);
    url = await launch(["--safe-mode"]);
    await page.goto(url);
    await page.getByRole("button", { name: "Settings", exact: true }).waitFor();
    const safe = await rpc(url, "list");
    assert.equal(safe.safeMode, true);
    assert.deepEqual(safe.loadedIds, []);
    assert.deepEqual(safe.extensions[0]?.enabledTargets, ["web"]);
    await stop(child);
  },
);
