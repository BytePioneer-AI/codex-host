/** Optional acceptance of unchanged published packages; artwork stays outside the repository. */
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { chromium } from "playwright";
import type { WebUiExtensionsState } from "@codexhost/shared-contracts";
import { startServer } from "../support/server.ts";
import { FakeChHost, startFakeChDebugger } from "../support/ch-host.ts";
import { openPluginTerminal } from "../support/web-plugin-terminal.ts";

const samples = [
  {
    id: "@frostgao/dsh-theme-blackgold",
    version: "1.0.0",
    label: "blackgold",
    archive: process.env.CODEXHOST_TEST_DSH_EXTENSION_ARCHIVE,
    archiveHash: "f6ef545dec6ded0ffaacec8be6ce64026f4b79141888fe5a368f62a632a92957",
    entries: {
      "lib/client.js": "ba0438d0ccfdac090819bf4a88abbfd2b122af8d6a1a3912da5edce19bb03f92",
    },
    selector: ".dsh-gold-mark",
    prefix: "",
  },
  {
    id: "@smalltailqwq/dsh-client-ui-skin-maid-atelier",
    version: "0.1.9",
    label: "maid-atelier",
    archive: process.env.CODEXHOST_TEST_MAID_ARCHIVE,
    archiveHash: "4db0498fbc9b3079f7183b9456fc60c9354c54e9e87c2f88ec27ef97b2e76416",
    entries: {
      "lib/index.js": "ccfd569f251eaf073532536eea231a4e4df54a3e73e810b488713ebb7af1ce9f",
      "lib/client.js": "b146f8ae463987f8e3f54da0c28777dd5ea98e8d773bbf8b42512e2f3efc0b57",
    },
    selector: "body[data-dsh-maid-atelier]",
    prefix: "/skin-assets/maid-atelier/",
  },
  {
    id: "open-sea-skin",
    version: "1.2.7",
    label: "open-sea",
    archive: process.env.CODEXHOST_TEST_OPEN_SEA_ARCHIVE,
    archiveHash: "2da120caef2bd120a1ccee8d40929515339a8f0aada1124ea85084b6370ba586",
    entries: {
      "plugin/index.js": "dc8a69166ef5c3ed8a2fb8cafc3b79b1feed3025326cfd8642d27bba4f2fda03",
      "plugin/client.js": "6cced90ca2737216e053bebcfedaa574f88fa60d444eda277582e2a288e6dc2c",
    },
    selector: "iframe#__open-sea-skin__",
    prefix: "/open-sea-skin/",
  },
] as const;
const hash = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const TOKEN = "native-package-acceptance-token";

const cases = samples.flatMap((sample) =>
  [false, true].map((withTerminal) => ({ sample, withTerminal })),
);
for (const { sample, withTerminal } of cases)
  it(
    `hot-loads unchanged ${sample.id}@${sample.version} ${withTerminal ? "with an existing PTY" : "across pages and recovery"}`,
    { skip: !sample.archive, timeout: 180_000 },
    async (t) => {
      assert.ok(sample.archive);
      assert.equal(hash(sample.archive), sample.archiveHash);
      const root = mkdtempSync(join(tmpdir(), "codexhost-real-web-plugin-"));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      const data = join(root, "data");
      const workspace = join(root, "workspace");
      mkdirSync(workspace);
      writeFileSync(join(workspace, "README.md"), "# Hot plugin workspace\n");
      const host = new FakeChHost();
      host.add("hot-thread", workspace, "Hot plugin Thread");
      const debug = await startFakeChDebugger(host);
      t.after(() => debug.close());
      let child!: ChildProcess;
      let serverOutput = "";
      const url = await startServer(
        t,
        resolve(import.meta.dirname, "../.."),
        ["--import", "tsx", "src/main.ts"],
        ["--data", data, "--token", TOKEN, "--ch-cdp", debug.endpoint],
        {
          authenticated: true,
          environment: { SHELL: "/bin/sh" },
          onSpawn: (value) => {
            child = value;
            for (const stream of [value.stdout, value.stderr])
              stream?.on("data", (chunk) => {
                serverOutput += String(chunk);
              });
          },
        },
      );
      const rpc = async (action: string, args = {}): Promise<WebUiExtensionsState> => {
        const method = `codexhost/uiExtensions/${action}`;
        const response = await fetch(new URL(`/api/${method}`, url), {
          method: "POST",
          headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
          body: JSON.stringify({
            type: "client-request",
            rpcId: "acceptance",
            method,
            payload: { args },
          }),
        });
        const body = (await response.json()) as {
          result: { ok: boolean; value: WebUiExtensionsState };
        };
        assert.equal(body.result.ok, true, JSON.stringify(body));
        return body.result.value;
      };
      const browser = await chromium.launch({ args: ["--enable-unsafe-swiftshader"] });
      t.after(() => browser.close());
      const context = await browser.newContext({
        locale: "en-US",
        colorScheme: "light",
        viewport: { width: 1440, height: 1000 },
      });
      const page = await context.newPage();
      const second = await browser.newPage({ locale: "en-US", colorScheme: "light" });
      const recovery = await context.newPage();
      const manager = await context.newPage();
      const pages = [page, second, recovery, manager];
      const errors: string[] = [];
      const recoveryChannels: string[] = [];
      for (const target of [recovery, manager])
        target.on("request", (request) => {
          if (request.url().includes("plugins/events")) recoveryChannels.push(request.url());
        });
      let terminal: Awaited<ReturnType<typeof openPluginTerminal>> | undefined;
      let phase = "initial";
      const consoleErrors: string[] = [];
      const resources: { url: string; status: number }[] = [];
      for (const target of pages) target.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") consoleErrors.push(message.text());
      });
      page.on("response", (response) => {
        if (sample.prefix && response.url().includes(sample.prefix))
          resources.push({ url: new URL(response.url()).pathname, status: response.status() });
      });
      const screenshots = process.env.CODEXHOST_TEST_EXTENSION_SCREENSHOTS;
      const mode = process.env.CODEXHOST_TEST_WEB_BUNDLE ? "packed" : "source";
      t.after(async () => {
        if (screenshots) {
          mkdirSync(screenshots, { recursive: true });
          writeFileSync(
            join(
              screenshots,
              `${mode}-${sample.label}${withTerminal ? "-pty" : ""}-observations.json`,
            ),
            JSON.stringify(
              {
                phase,
                withTerminal,
                serverPid: child.pid,
                serverOutput,
                mode,
                archiveHash: sample.archiveHash,
                entries: sample.entries,
                terminal: terminal?.evidence(),
                recoveryChannels,
                errors,
                consoleErrors,
                resources,
              },
              null,
              2,
            ),
          );
        }
      });
      const target = new URL(url);
      target.searchParams.set("session", "hot-thread");
      await page.goto(target.href);
      await page.getByText("earlier question", { exact: true }).waitFor();
      await second.goto(url);
      await recovery.goto(new URL("/?extensions=off", url).href);
      await manager.goto(new URL("/extensions", url).href);
      for (const target of [page, second, recovery])
        await target.getByRole("button", { name: "Settings", exact: true }).waitFor();
      for (const target of pages)
        await target.evaluate(() => {
          (globalThis as { hotDocument?: number }).hotDocument = 1;
        });
      assert.deepEqual((await rpc("list")).extensions, [], "PTY baseline has no installed plugin");
      if (withTerminal) terminal = await openPluginTerminal(page, workspace);
      phase = "installed";
      const installed = await rpc("install", { spec: sample.archive });
      assert.deepEqual(installed.extensions[0]?.enabledTargets, []);
      assert.equal(installed.extensions[0]?.version, sample.version);
      const saved = JSON.parse(readFileSync(join(data, "ui-extensions/installed.json"), "utf8"));
      const directory = join(
        data,
        "ui-extensions/packages",
        saved.extensions[0].installId,
        "node_modules",
        sample.id,
      );
      for (const [entry, expected] of Object.entries(sample.entries))
        assert.equal(hash(join(directory, entry)), expected);
      phase = "enabled";
      await rpc("setEnabled", { id: sample.id, enabled: true });
      assert.deepEqual((await rpc("list")).loadedIds, [sample.id]);
      for (const target of [page, second]) {
        await target.locator(sample.selector).first().waitFor({ state: "attached" });
        assert.ok((await target.locator(`style[data-plugin="${sample.id}"]`).count()) > 0);
      }
      await terminal?.verify("enabled");
      let resource: string | undefined;
      if (sample.label === "maid-atelier") {
        await page.waitForFunction(
          () =>
            [...document.querySelectorAll<HTMLImageElement>("[data-maid-character]")].length ===
              3 &&
            [...document.querySelectorAll<HTMLImageElement>("[data-maid-character]")].every(
              (image) => image.complete && image.naturalWidth > 0,
            ),
        );
        resource = new URL(
          (await page.locator("[data-maid-character]").first().getAttribute("src")) as string,
          url,
        ).pathname;
        for (const variable of [
          "--maid-palace-art",
          "--maid-top-trim-art",
          "--maid-composer-frame-art",
        ]) {
          const value = await page.evaluate(
            (name) => getComputedStyle(document.body).getPropertyValue(name),
            variable,
          );
          const path = /url\(["']?([^\)"']+)/.exec(value)?.[1];
          assert.ok(path, `${variable}: ${value}`);
          const response = await page.request.get(new URL(path, url).href);
          assert.equal(response.status(), 200);
          assert.match(response.headers()["content-type"] ?? "", /^image\//);
          assert.ok((await response.body()).length > 100);
        }
      } else if (sample.label === "open-sea") {
        const frame = page.frameLocator(sample.selector);
        await frame.locator("body.ready canvas").waitFor({ state: "visible", timeout: 60_000 });
        assert.ok(
          await frame
            .locator("canvas")
            .evaluate((canvas) => (canvas as HTMLCanvasElement).width > 0),
        );
        resource = "/open-sea-skin/skin.html";
        for (const [path, type] of [
          ["skin.html", "text/html"],
          ["ocean.js", "javascript"],
          ["styles.css", "text/css"],
          ["vendor/fonts/geist-sans-latin-400.woff2", "font/woff2"],
        ] as const) {
          const response = await page.request.get(new URL(sample.prefix + path, url).href);
          assert.equal(response.status(), 200);
          assert.ok(response.headers()["content-type"]?.includes(type));
          assert.ok((await response.body()).length > 100);
        }
      }
      if (sample.label === "blackgold") {
        const color = await page.evaluate(() =>
          getComputedStyle(document.body).getPropertyValue("--dsw-alias-brand-primary").trim(),
        );
        assert.equal(color.toLowerCase(), "#cfb53b");
      }
      if (sample.prefix) assert.ok(resources.some((response) => response.status === 200));
      assert.deepEqual(
        resources.filter((response) => response.status >= 400),
        [],
      );
      if (screenshots) {
        mkdirSync(screenshots, { recursive: true });
        await page.screenshot({
          path: join(
            screenshots,
            `${mode}-${sample.label}${withTerminal ? "-pty" : ""}-enabled.png`,
          ),
          fullPage: true,
          animations: "disabled",
        });
      }
      for (const target of [recovery, manager]) {
        assert.equal(await target.locator(sample.selector).count(), 0);
        assert.equal(await target.locator(`style[data-plugin="${sample.id}"]`).count(), 0);
      }
      if (resource)
        assert.equal((await page.request.get(new URL(resource, url).href)).status(), 200);
      phase = "disabled";
      await second.context().setOffline(true);
      await rpc("setEnabled", { id: sample.id, enabled: false });
      await page.locator(sample.selector).first().waitFor({ state: "detached" });
      await second.context().setOffline(false);
      await second.locator(sample.selector).first().waitFor({ state: "detached" });
      assert.deepEqual((await rpc("list")).loadedIds, []);
      for (const target of [page, second])
        assert.equal(await target.locator(`style[data-plugin="${sample.id}"]`).count(), 0);
      if (resource)
        assert.equal((await page.request.get(new URL(resource, url).href)).status(), 404);
      await terminal?.verify("disabled");
      if (screenshots)
        await page.screenshot({
          path: join(
            screenshots,
            `${mode}-${sample.label}${withTerminal ? "-pty" : ""}-disabled.png`,
          ),
          fullPage: true,
        });
      phase = "reenabled";
      await rpc("setEnabled", { id: sample.id, enabled: true });
      for (const target of [page, second])
        await target.locator(sample.selector).first().waitFor({ state: "attached" });
      await terminal?.verify("reenabled");
      // The original files have not been rewritten by either activation.
      for (const [entry, expected] of Object.entries(sample.entries))
        assert.equal(hash(join(directory, entry)), expected);
      phase = "removed";
      await rpc("remove", { id: sample.id });
      for (const target of [page, second]) {
        await target.locator(sample.selector).first().waitFor({ state: "detached" });
        assert.equal(await target.locator(`style[data-plugin="${sample.id}"]`).count(), 0);
      }
      if (resource)
        assert.equal((await page.request.get(new URL(resource, url).href)).status(), 404);
      assert.equal(existsSync(directory), false);
      await terminal?.verify("removed");
      for (const target of pages)
        assert.equal(
          await target.evaluate(() => (globalThis as { hotDocument?: number }).hotDocument),
          1,
        );
      assert.deepEqual(recoveryChannels, []);
      assert.equal(child.exitCode, null);
      assert.deepEqual(errors, []);
      phase = "complete";
    },
  );
