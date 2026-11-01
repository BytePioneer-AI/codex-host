import { readFile } from "node:fs/promises";

import tailwindcss from "@tailwindcss/postcss";
import postcss from "postcss";

// esbuild evaluates filters with Go regular expressions, which reject JavaScript flags.
const TAILWIND_ENTRY = /[\\/]renderer-extension[\\/]src[\\/]settings[\\/]tailwind\.css$/;
const LAYER_ORDER = "properties, theme, base, components, utilities";

/**
 * Chromium does not register `@property` rules inside shadow roots, so Tailwind utilities that
 * compose registered custom properties (rings, shadows, transforms, dividers) would read undefined
 * values. Declare the registered initial values in the lowest layer instead.
 */
export function addShadowRootPropertyDefaults(root) {
  const defaults = [];
  root.walkAtRules("property", (rule) => {
    rule.walkDecls("initial-value", (declaration) => {
      defaults.push(postcss.decl({ prop: rule.params.trim(), value: declaration.value }));
    });
  });
  if (defaults.length === 0) return root;
  root.append(
    postcss
      .atRule({ name: "layer", params: "properties" })
      .append(postcss.rule({ selector: "*, ::before, ::after, ::backdrop" }).append(defaults)),
  );
  return root;
}

export async function compileSettingsTailwind(path) {
  const source = await readFile(path, "utf8");
  const result = await postcss([tailwindcss({ optimize: { minify: true } })]).process(source, {
    from: path,
  });
  // The optimizer drops the source order statement; shell.css `@layer base` must stay below utilities.
  result.root.prepend(postcss.atRule({ name: "layer", params: LAYER_ORDER }));
  return addShadowRootPropertyDefaults(result.root).toString();
}

/** Compiles the settings Tailwind entry into the same text import used by other settings CSS. */
export function tailwindEsbuildPlugin() {
  return {
    name: "codexhost-settings-tailwind",
    setup(build) {
      build.onLoad({ filter: TAILWIND_ENTRY }, async ({ path }) => ({
        contents: await compileSettingsTailwind(path),
        loader: "text",
      }));
    },
  };
}
