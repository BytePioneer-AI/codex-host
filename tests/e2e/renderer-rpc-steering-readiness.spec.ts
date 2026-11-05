import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";
import { tailwindEsbuildPlugin } from "../../packages/renderer-extension/scripts/tailwind-esbuild-plugin.mjs";

const browserExecutable = process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH;
if (browserExecutable) test.use({ launchOptions: { executablePath: browserExecutable } });
const { outputFiles } = await build({
  stdin: {
    contents: `
      import {mountComposerAgentControl,renderComposerAgentControl} from "./packages/renderer-extension/src/renderer-composer-dom.ts";
      const composer=document.createElement('div');
      composer.setAttribute('data-codex-composer-root','true');
      const editor=document.createElement('div');editor.contentEditable='true';editor.setAttribute('role','textbox');
      const send=document.createElement('button');send.type='submit';send.id='send';send.textContent='Send';
      composer.append(editor,send);document.body.append(composer);
      const noop=()=>{};
      const control=mountComposerAgentControl(composer,'fixture',send,['codex','pi'],noop,noop,noop,noop,noop,noop,noop);
      globalThis.renderSteeringReadiness=(agent,state)=>renderComposerAgentControl(control,{agent,phase:'locked'},state,false,{pi:'ready'},
        {status:'ready',selected:{id:'fixture'},catalog:{models:[{ref:{id:'fixture'},label:'Fixture'}],thinkingOptions:[]}},
        {status:'unsupported'});
    `,
    resolveDir: path.resolve(import.meta.dirname, "../.."),
    loader: "ts",
  },
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2024",
  loader: { ".css": "text", ".png": "dataurl", ".svg": "dataurl" },
  plugins: [tailwindEsbuildPlugin()],
  write: false,
});
const bundle = outputFiles[0]?.text;
if (!bundle) throw new Error("Steering readiness fixture bundle is missing");

test("external submission waits for steering readiness without disabling official Codex", async ({
  page,
}) => {
  await page.setContent("<!doctype html><body></body>");
  await page.addScriptTag({ content: bundle });
  const render = (agent: string, state: string) =>
    page.evaluate(
      ([agent, state]) => Reflect.get(globalThis, "renderSteeringReadiness")(agent, state),
      [agent, state],
    );
  await render("pi", "installing");
  await expect(page.locator("#send")).toBeDisabled();
  await render("pi", "ready");
  await expect(page.locator("#send")).toBeEnabled();
  await render("pi", "installing");
  await expect(page.locator("#send")).toBeDisabled();
  await render("codex", "installing");
  await expect(page.locator("#send")).toBeEnabled();
});
