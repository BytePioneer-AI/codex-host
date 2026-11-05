/** node --import tsx packages/web-server/test/distribution/office-release-smoke.ts <npm-platform-package> */
import assert from "node:assert/strict";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { chromium } from "playwright";
import { FakeChChannel, startFakeChChannel } from "../support/ch-channel.ts";
import { startServer } from "../support/server.ts";

it(
  "previews DOCX and PPTX using an official engine download from a relocated release",
  { timeout: 240_000 },
  async (t) => {
    assert.ok(process.argv[2], "Pass the built npm platform package directory");
    const root = mkdtempSync(join(tmpdir(), "office-release-smoke-"));
    console.log(`Isolated evidence: ${root}`);
    const release = join(root, "package");
    cpSync(resolve(process.argv[2]), release, { recursive: true });
    const home = join(root, "home");
    const data = join(root, "data");
    const webData = join(root, "web");
    const workspace = join(home, "workspace");
    mkdirSync(workspace, { recursive: true });
    for (const name of ["sample.docx", "sample.pptx"])
      copyFileSync(join(import.meta.dirname, "../fixtures/office", name), join(workspace, name));
    const host = new FakeChChannel();
    const thread = host.add("office-thread", workspace, "Office release preview");
    thread.turns = [
      {
        id: "turn",
        status: "completed",
        items: [
          {
            id: "u",
            type: "userMessage",
            content: [{ type: "text", text: "Office release preview" }],
          },
          {
            id: "a",
            type: "agentMessage",
            text: "[sample.docx](sample.docx) [sample.pptx](sample.pptx)",
          },
        ],
      },
    ];
    const channel = await startFakeChChannel(host, join(data, "client-hosts"), "service");
    t.after(() => channel.close());
    // Only Thread metadata is fake. The release HTTP server, browser, download, conversion and PTY are real.
    const url = new URL(
      await startServer(
        t,
        release,
        [join(release, "app/web-server.mjs")],
        [
          "--port",
          "4470",
          "--data",
          webData,
          "--ch-data",
          data,
          "--ch-host-runtime",
          join(release, "app/host-runtime.mjs"),
          "--ch-launcher",
          join(root, "no-launcher"),
          "--adapters",
          join(release, "app/plugins"),
        ],
        {
          authenticated: true,
          environment: {
            HOME: home,
            CODEXHOST_DATA_DIR: data,
            CODEX_HOME: join(root, "codex"),
            CODEXHOST_CONSOLE_PORT: "4471",
            SSH_CONNECTION: "smoke",
            SHELL: "/bin/sh",
          },
        },
      ),
    );
    url.searchParams.set("session", "office-thread");
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const manifest = JSON.parse(
      readFileSync(join(release, "app/web-modules/office-engines.json"), "utf8"),
    );
    const target = process.platform === "linux" ? "wasm" : `${process.platform}-${process.arch}`;
    const artifact = manifest.find((entry: { name: string }) => entry.name.endsWith(`-${target}`));
    assert.ok(artifact.url.startsWith("https://registry.npmjs.org/"));
    assert.equal(existsSync(join(release, "app/web-modules/node_modules", artifact.name)), false);
    const installed = join(
      webData,
      "office-engine",
      artifact.version,
      "node_modules",
      artifact.name,
      "package.json",
    );
    const archive = join(webData, "office-engine/.download/engine.tgz");
    let downloadedAt: number | undefined;
    let installedAt: number | undefined;
    const monitor = setInterval(() => {
      if (!downloadedAt && existsSync(archive)) downloadedAt = Date.now();
      if (!installedAt && existsSync(installed)) installedAt = Date.now();
    }, 10);
    t.after(() => clearInterval(monitor));
    await page.goto(url.href);
    await page.getByText("Office release preview", { exact: true }).last().waitFor();
    const started = Date.now();
    await page.getByRole("button", { name: "sample.docx", exact: true }).click();
    await page.getByText(/正在下载 Office|Downloading the Office/u).waitFor();
    await page.goto("about:blank");
    const deadline = Date.now() + 150_000;
    while (!installedAt) {
      assert.ok(Date.now() < deadline, "download did not complete after leaving the page");
      await new Promise((done) => setTimeout(done, 50));
    }
    await page.goto(url.href);
    for (const name of ["sample.docx", "sample.pptx"]) {
      const converted = page.waitForResponse(
        (response) =>
          response.url().endsWith("/api/officeToPdf/render") &&
          response.request().postDataJSON().payload.args.path.endsWith(name) &&
          (response.headers()["content-type"] ?? "").startsWith("multipart/form-data"),
        { timeout: 60_000 },
      );
      await page.getByRole("button", { name, exact: true }).click();
      assert.match((await (await converted).body()).toString("latin1"), /%PDF-/u);
      await page.locator("[data-pdf-preview] [data-pdf-page]").waitFor({ timeout: 60_000 });
      await page.screenshot({ path: join(root, `${name}.png`) });
    }
    const installedVersion = JSON.parse(readFileSync(installed, "utf8"));
    assert.equal(installedVersion.version, artifact.version);
    // A fresh draft gets the guide, from which the real Web terminal can be opened.
    const terminal = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const terminalUrl = new URL(url);
    terminalUrl.searchParams.delete("session");
    await terminal.goto(terminalUrl.href);
    await terminal.locator("[data-sidebar-right-expand]").click();
    await terminal.locator('[data-sidebar-right-guide-entry="terminal"] button').first().click();
    const input = terminal.locator(".xterm-helper-textarea");
    await input.waitFor();
    await input.focus();
    const proof = join(home, "node-path-proof");
    await terminal.keyboard.insertText(`printf '%s' "\${NODE_PATH-unset}" > '${proof}'`);
    await terminal.keyboard.press("Enter");
    const terminalDeadline = Date.now() + 20_000;
    while (!existsSync(proof)) {
      assert.ok(Date.now() < terminalDeadline, "Web terminal did not write environment proof");
      await new Promise((done) => setTimeout(done, 50));
    }
    assert.equal(readFileSync(proof, "utf8"), "unset");
    assert.deepEqual(errors, []);
    const result = {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      source: artifact.url,
      downloadMs: downloadedAt && downloadedAt - started,
      installedMs: installedAt - started,
      docx: "rendered",
      pptx: "rendered",
      terminalNodePath: "unset",
    };
    writeFileSync(join(root, "result.json"), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  },
);
