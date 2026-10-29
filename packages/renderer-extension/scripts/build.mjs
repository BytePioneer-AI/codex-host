import { build } from "esbuild";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { tailwindEsbuildPlugin } from "./tailwind-esbuild-plugin.mjs";

const defaultPackageRoot = path.resolve(import.meta.dirname, "..");
const entries = [
  { entry: "src/index.ts", format: "esm", outfile: "dist/index.js" },
  { entry: "src/production-entry.ts", format: "iife", outfile: "dist/production.js" },
  { entry: "src/probe-entry.ts", format: "iife", outfile: "dist/renderer-binding-probe.js" },
  { entry: "src/audit-entry.ts", format: "iife", outfile: "dist/contract-audit.js" },
  { entry: "src/console-entry.ts", format: "iife", outfile: "dist/console.js" },
];

export async function buildRendererBundles({ packageRoot = defaultPackageRoot } = {}) {
  const audits = [];
  for (const { entry, format, outfile } of entries) {
    const result = await build({
      absWorkingDir: packageRoot,
      entryPoints: [entry],
      bundle: true,
      platform: "browser",
      format,
      target: "es2024",
      loader: { ".png": "dataurl", ".svg": "dataurl", ".css": "text" },
      plugins: [tailwindEsbuildPlugin()],
      outfile,
      metafile: true,
    });
    audits.push({ outfile, inputs: Object.keys(result.metafile.inputs) });
  }
  return audits;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await buildRendererBundles();
}
