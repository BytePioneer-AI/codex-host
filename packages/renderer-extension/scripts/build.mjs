import { build } from "esbuild";
import path from "node:path";

import { tailwindEsbuildPlugin } from "./tailwind-esbuild-plugin.mjs";

const packageRoot = path.resolve(import.meta.dirname, "..");
const entries = [
  { entry: "src/index.ts", format: "esm", outfile: "dist/index.js" },
  { entry: "src/production-entry.ts", format: "iife", outfile: "dist/production.js" },
  { entry: "src/probe-entry.ts", format: "iife", outfile: "dist/renderer-binding-probe.js" },
  { entry: "src/audit-entry.ts", format: "iife", outfile: "dist/contract-audit.js" },
];

for (const { entry, format, outfile } of entries) {
  await build({
    absWorkingDir: packageRoot,
    entryPoints: [entry],
    bundle: true,
    platform: "browser",
    format,
    target: "es2024",
    loader: { ".png": "dataurl", ".svg": "dataurl", ".css": "text" },
    plugins: [tailwindEsbuildPlugin()],
    outfile,
  });
}
