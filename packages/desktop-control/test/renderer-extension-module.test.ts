import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Script } from "node:vm";
import { installHostExtension } from "@codexhost/harness-plugin-files";
import { afterEach, beforeEach, expect, it } from "vitest";
import { makeZip } from "../../../tests/fixtures/desktop-extension-zip.js";
import { linkRendererExtensionModule } from "../src/renderer-extension-module.js";

let dataDir: string;
beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "extension-linker-"));
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

async function install(id: string, files: Record<string, string>, widget?: string) {
  const text = { en: id, "zh-CN": id };
  return installHostExtension({
    dataDir,
    expectedDigest: null,
    source: {
      type: "zip",
      zipBuffer: makeZip([
        {
          name: "manifest.json",
          data: JSON.stringify({
            manifestVersion: 2,
            id,
            version: "1",
            name: text,
            description: text,
            page: { apiVersion: 1, entry: "page/index.mjs" },
            ...(widget ? { widget: { apiVersion: 1, entry: widget } } : {}),
            ...(files["backend/index.mjs"] !== undefined
              ? { backend: { apiVersion: 1, entry: "backend/index.mjs" } }
              : {}),
          }),
        },
        ...Object.entries(files).map(([name, data]) => ({ name, data })),
      ]),
    },
  });
}

async function execute(factory: string, globals = {}) {
  const script = new Script(`${factory}()`);
  return (
    await script.runInNewContext(
      { ...globals },
      { contextCodeGeneration: { strings: false, wasm: false } },
    )
  ).namespace;
}

it("links focus-pomodoro-style page and widget graphs with ../shared, re-exports, live bindings and one evaluation per module", async () => {
  const installed = await install(
    "focus-pomodoro",
    {
      "page/index.mjs": `
      import timer, { ticks } from "../shared/timer.mjs";
      import * as helpers from "./helpers.mjs";
      import "../shared/timer.mjs";
      export { ticks } from "../shared/timer.mjs";
      export * from "./helpers.mjs";
      export { default } from "../shared/timer.mjs";
      export function mount() { return [timer(), helpers.advance(), ticks, globalThis.loads]; }
    `,
      "page/helpers.mjs": `export { default as advance } from "../shared/timer.mjs";`,
      "widget/index.mjs": `import { ticks, default as timer } from "../shared/timer.mjs";
      export const mount = () => [timer(), ticks, globalThis.loads];`,
      "shared/timer.mjs": `globalThis.loads++;
      export const url = import.meta.url;
      export let ticks = 0;
      export default function timer() { return ++ticks; }`,
    },
    "widget/index.mjs",
  );
  const page = await execute(
    await linkRendererExtensionModule(dataDir, installed, "page/index.mjs"),
    { loads: 0 },
  );
  expect(page.ticks).toBe(0);
  expect(page.mount()).toEqual([1, 2, 2, 1]);
  expect(page.ticks).toBe(2);
  expect(page.default).toBe(page.advance);
  const widget = await execute(
    await linkRendererExtensionModule(dataDir, installed, "widget/index.mjs"),
    { loads: 0 },
  );
  expect(widget.mount()).toEqual([1, 1, 1]);
});

it("links a prompt-vault-style async mount while leaving its backend exclusively behind the API", async () => {
  const installed = await install("prompt-vault", {
    "page/index.mjs": `import { render } from "../shared/view.mjs";
      const ready = await Promise.resolve(true);
      export async function mount(root, api) {
        if (ready) render(root, await api.backend.invoke("list"));
      }`,
    "shared/view.mjs": `export const render = (root, items) => {
      root.textContent = items.join(", ");
      root.moduleUrl = new URL("./view.mjs", import.meta.url).href;
    };`,
    "backend/index.mjs": `throw Error("backend must not execute");`,
  });
  const result = await execute(
    await linkRendererExtensionModule(dataDir, installed, "page/index.mjs"),
    { URL },
  );
  const root = { textContent: "", moduleUrl: "" };
  await result.mount(root, {
    backend: { invoke: (name: string) => (name === "list" ? ["notes", "drafts"] : []) },
  });
  expect(root.textContent).toBe("notes, drafts");
  expect(root.moduleUrl).toBe(
    `codexhost-extension://prompt-vault/${installed.activationId}/${installed.digest}/shared/view.mjs`,
  );
});

it.each([
  ['import "../../outside.mjs"', /escapes the package/],
  ['export * from "../%2e%2e/outside.mjs"', /escapes the package/],
  ['import "../backend/index.mjs"', /Cannot import backend\.entry/],
  ['import "../BACKEND/index.mjs"', /Cannot import backend\.entry/],
  ['import "https://example.com/file.mjs"', /package-relative/],
  ['import("../shared/view.mjs")', /dynamic import/],
  ["export const broken = ;", /Unexpected token/],
])("rejects %s during linking", async (code, message) => {
  const installed = await install("invalid", {
    "page/index.mjs": code,
    "backend/index.mjs": "export function activate() {}",
  });
  await expect(linkRendererExtensionModule(dataDir, installed, "page/index.mjs")).rejects.toThrow(
    message,
  );
});

it("fails closed on digest mismatches, including for a transitive module", async () => {
  const installed = await install("damaged", {
    "page/index.mjs": 'export * from "../shared/view.mjs";',
    "shared/view.mjs": "export const mount = () => {};",
  });
  await writeFile(path.join(installed.directory, "shared/view.mjs"), "export const mount = 17;");
  await expect(linkRendererExtensionModule(dataDir, installed, "page/index.mjs")).rejects.toThrow(
    /digest|hash|modified|size/i,
  );
});
