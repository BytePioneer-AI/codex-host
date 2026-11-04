import { expect, test, type Page } from "@playwright/test";
import { build, type Plugin } from "esbuild";
import { readFileSync } from "node:fs";
import path from "node:path";

import type {
  mountComposerAgentControl,
  reconcileComposerNativeControls,
} from "../../packages/renderer-extension/src/renderer-composer-dom.js";
import { tailwindEsbuildPlugin } from "../../packages/renderer-extension/scripts/tailwind-esbuild-plugin.mjs";

type TestWindow = Window & {
  modelHidingTest: {
    mountComposerAgentControl: typeof mountComposerAgentControl;
    reconcileComposerNativeControls: typeof reconcileComposerNativeControls;
  };
};

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const browserExecutable = process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH;
if (browserExecutable) test.use({ launchOptions: { executablePath: browserExecutable } });

/**
 * The Composer controls import sibling workspaces (`@codexhost/shared-contracts`,
 * `@codexhost/desktop-control/renderer-bindings`), whose runtime exports point
 * at `dist/`. Those artifacts are gitignored and neither `test:e2e` nor the
 * Playwright config builds them, so a fresh checkout would fail to resolve them
 * here during collection. Map each package's published export back to the
 * source file that produces it instead of requiring a prior `build:typescript`.
 * Derived from the package manifests so a renamed or added export keeps
 * working without touching this file.
 */
function workspaceSourcePlugin(): Plugin {
  return {
    name: "codexhost-workspace-source",
    setup(builder) {
      builder.onResolve({ filter: /^@codexhost\// }, (args) => {
        const [scope, name, ...subpath] = args.path.split("/");
        if (!scope || !name) return null;
        const packageRoot = path.join(repositoryRoot, "packages", name);
        const manifestPath = path.join(packageRoot, "package.json");
        let manifest: { exports?: Record<string, { import?: string }> };
        try {
          manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        } catch {
          return null;
        }
        const key = subpath.length > 0 ? `./${subpath.join("/")}` : ".";
        const runtime = manifest.exports?.[key]?.import;
        if (!runtime) return null;
        // `./dist/foo.js` -> `<packageRoot>/src/foo.ts`
        const source = path.join(
          packageRoot,
          runtime.replace(/^\.\/dist\//, "src/").replace(/\.js$/, ".ts"),
        );
        return { path: source };
      });
    },
  };
}

const { outputFiles } = await build({
  stdin: {
    contents: `
      import { mountComposerAgentControl, reconcileComposerNativeControls } from "./packages/renderer-extension/src/renderer-composer-dom.ts";
      window.modelHidingTest = { mountComposerAgentControl, reconcileComposerNativeControls };
    `,
    resolveDir: repositoryRoot,
    loader: "ts",
  },
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2024",
  loader: { ".css": "text", ".png": "dataurl", ".svg": "dataurl" },
  plugins: [
    workspaceSourcePlugin(),
    // Runs after the resolver above, so settings CSS still compiles.
    tailwindEsbuildPlugin(),
  ],
  write: false,
});
const browserBundle = outputFiles[0]?.text;
if (!browserBundle) throw new Error("Native Model hiding bundle was not generated");

/**
 * Attaches a fake committed React Fiber chain to the trigger, shaped like the
 * owning component Codex actually renders in this Desktop generation. Only the
 * props `isNativeModelControlCandidate` reads are present.
 */
async function attachFiber(page: Page, generation: string): Promise<void> {
  await page.evaluate((which) => {
    const trigger = document.querySelector("#native-model");
    if (!trigger) throw new Error("Missing native Model fixture");
    // Desktop <= 26.1027 owning props.
    const legacy = {
      onSelectModel: () => undefined,
      onSelectReasoningEffort: () => undefined,
      reasoningEffort: "medium",
      fallbackPowerSelection: { id: "fallback" },
    };
    // Desktop 26.1029: the legacy pair is gone, power selection moved to
    // powerSelections / onCommitPower on the same owning component.
    const current = {
      onSelectModel: () => undefined,
      reasoningEffort: "high",
      powerSelections: [{ id: "gpt-6.1-terra:high" }],
      onCommitPower: () => undefined,
      selectionMode: "model",
      modelPickerTriggerConfig: { openLabel: "Model" },
    };
    const props = which === "current" ? current : legacy;
    Object.defineProperty(trigger, "__reactFiber$e2e", {
      value: { memoizedProps: props, return: null },
    });
  }, generation);
}

async function mountAndHide(
  page: Page,
): Promise<{ hidden: boolean | "until-found"; ariaHidden: string | null }> {
  return page.evaluate(() => {
    const api = (window as unknown as TestWindow).modelHidingTest;
    const composer = document.querySelector("form");
    const nativeModel = document.querySelector<HTMLButtonElement>("#native-model");
    const sendButton = document.querySelector<HTMLButtonElement>("#send");
    if (!composer || !nativeModel || !sendButton) throw new Error("Missing native fixture");
    const noop = () => {};
    const control = api.mountComposerAgentControl(
      composer,
      "composer-native-model",
      sendButton,
      ["codex", "pi"],
      noop,
      noop,
      noop,
      noop,
      noop,
      noop,
      noop,
    );
    // hideModel=true is what an external Harness Composer passes, see
    // rendererAgentPickerView().nativeModelHidden.
    api.reconcileComposerNativeControls(control, true, true);
    return { hidden: nativeModel.hidden, ariaHidden: nativeModel.getAttribute("aria-hidden") };
  });
}

const FIXTURE = `
  <form data-codex-composer-root>
    <div contenteditable="true" role="textbox">draft</div>
    <div>
      <button id="native-model" type="button" aria-haspopup="menu"
        data-composer-navigation-target="reasoning"
        data-selected-reasoning-effort="high">GPT-6.1 Terra 高</button>
      <button id="send" type="submit" aria-label="Send">Send</button>
    </div>
  </form>
`;

test.beforeEach(async ({ page }) => {
  await page.route("http://codexhost.test/", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><body></body>" }),
  );
  await page.goto("http://codexhost.test/");
});

test("hides the native Codex Model trigger from an external Harness Composer", async ({ page }) => {
  await page.setContent(FIXTURE);
  await page.addScriptTag({ content: browserBundle });
  await attachFiber(page, "current");
  await expect.poll(() => mountAndHide(page)).toEqual({ hidden: true, ariaHidden: "true" });
});

test("keeps hiding the native Model trigger on the pre-26.1029 props", async ({ page }) => {
  await page.setContent(FIXTURE);
  await page.addScriptTag({ content: browserBundle });
  await attachFiber(page, "legacy");
  await expect.poll(() => mountAndHide(page)).toEqual({ hidden: true, ariaHidden: "true" });
});

test("hides the native Model trigger when only the navigation marker identifies it", async ({
  page,
}) => {
  // No Fiber at all: 26.1029's semantic marker alone has to be enough, which is
  // the same contract the Permission trigger already relies on.
  await page.setContent(FIXTURE);
  await page.addScriptTag({ content: browserBundle });
  await expect.poll(() => mountAndHide(page)).toEqual({ hidden: true, ariaHidden: "true" });
});

test("leaves an unidentified menu button visible instead of hiding the wrong control", async ({
  page,
}) => {
  await page.setContent(`
    <form data-codex-composer-root>
      <div contenteditable="true" role="textbox">draft</div>
      <div>
        <button id="native-model" type="button" aria-haspopup="menu">Some other menu</button>
        <button id="send" type="submit" aria-label="Send">Send</button>
      </div>
    </form>
  `);
  await page.addScriptTag({ content: browserBundle });
  const result = await mountAndHide(page);
  expect(result.hidden).toBe(false);
});
