/** Optional acceptance of unchanged published packages; artwork stays outside the repository. */
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { chromium } from "playwright";
import type { WebUiExtensionsState } from "@codexhost/shared-contracts";
import { startServer } from "../support/server.ts";

const samples = [
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

for (const sample of samples)
  it(
    `runs unchanged ${sample.id}@${sample.version}, resources and disable recovery`,
    { skip: !sample.archive, timeout: 180_000 },
    async (t) => {
      assert.ok(sample.archive);
      assert.equal(hash(sample.archive), sample.archiveHash);
      const root = mkdtempSync(join(tmpdir(), "codexhost-real-web-plugin-"));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      const data = join(root, "data");
      let child!: ChildProcess;
      const launch = () =>
        startServer(
          t,
          resolve(import.meta.dirname, "../.."),
          ["--import", "tsx", "src/main.ts"],
          ["--data", data, "--token", TOKEN],
          {
            authenticated: true,
            onSpawn: (value) => {
              child = value;
            },
          },
        );
      const stop = async () => {
        const ended = once(child, "exit");
        child.kill("SIGTERM");
        await ended;
      };
      let url = await launch();
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
      const page = await browser.newPage({
        locale: "en-US",
        colorScheme: "light",
        viewport: { width: 1440, height: 1000 },
      });
      const errors: string[] = [];
      const consoleErrors: string[] = [];
      const resources: { url: string; status: number }[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") consoleErrors.push(message.text());
      });
      page.on("response", (response) => {
        if (response.url().includes(sample.prefix))
          resources.push({ url: new URL(response.url()).pathname, status: response.status() });
      });
      const screenshots = process.env.CODEXHOST_TEST_EXTENSION_SCREENSHOTS;
      const mode = process.env.CODEXHOST_TEST_WEB_BUNDLE ? "packed" : "source";
      t.after(async () => {
        if (screenshots) {
          mkdirSync(screenshots, { recursive: true });
          writeFileSync(
            join(screenshots, `${mode}-${sample.label}-observations.json`),
            JSON.stringify(
              {
                archiveHash: sample.archiveHash,
                entries: sample.entries,
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
      await rpc("setEnabled", { id: sample.id, enabled: true });
      assert.deepEqual((await rpc("list")).loadedIds, []);
      await stop();
      url = await launch();
      assert.deepEqual((await rpc("list")).loadedIds, [sample.id]);
      await page.goto(url);
      await page.getByRole("button", { name: "Settings", exact: true }).waitFor();
      await page.locator(sample.selector).waitFor({ state: "attached" });
      let resource: string;
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
      } else {
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
      assert.ok(resources.some((response) => response.status === 200));
      assert.deepEqual(
        resources.filter((response) => response.status >= 400),
        [],
      );
      if (screenshots) {
        mkdirSync(screenshots, { recursive: true });
        await page.screenshot({
          path: join(screenshots, `${mode}-${sample.label}-enabled.png`),
          fullPage: true,
          animations: "disabled",
        });
      }
      await page.goto(new URL("/?extensions=off", url).href);
      await page.getByRole("button", { name: "Settings", exact: true }).waitFor();
      assert.equal(await page.locator(sample.selector).count(), 0);
      assert.equal((await page.request.get(new URL(resource, url).href)).status(), 200);
      await page.goto(new URL("/extensions", url).href);
      await page.getByRole("button", { name: "禁用 / Disable", exact: true }).click();
      await page.getByRole("button", { name: "启用 / Enable", exact: true }).waitFor();
      await page.goto("about:blank");
      await stop();
      url = await launch();
      await page.goto(url);
      await page.getByRole("button", { name: "Settings", exact: true }).waitFor();
      assert.deepEqual((await rpc("list")).loadedIds, []);
      assert.equal(await page.locator(sample.selector).count(), 0);
      assert.equal((await page.request.get(new URL(resource, url).href)).status(), 404);
      assert.deepEqual(errors, []);
      if (screenshots)
        await page.screenshot({
          path: join(screenshots, `${mode}-${sample.label}-disabled.png`),
          fullPage: true,
        });
      await page.goto("about:blank");
      await stop();
    },
  );
