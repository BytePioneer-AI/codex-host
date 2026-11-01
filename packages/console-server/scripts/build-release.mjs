import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { build as esbuildBuild } from "esbuild";

const forbiddenInputFragments = [
  "/packages/adapters/",
  "/packages/host-runtime/",
  "/node_modules/@anthropic-ai/",
  "/test/",
  "/tests/",
  "/tools/",
];

function normalizedInputPath(value) {
  return `/${value.replaceAll("\\", "/").replace(/^\/+|\/+$/gu, "")}/`;
}

export function auditConsoleServerMetafile(metafile) {
  const inputs = Object.keys(metafile.inputs ?? {});
  const normalized = inputs.map(normalizedInputPath);
  const forbidden = normalized.filter((input) =>
    forbiddenInputFragments.some((fragment) => input.includes(fragment)),
  );
  if (forbidden.length > 0) {
    throw new Error(`Console Server Bundle contains forbidden inputs: ${forbidden.join(", ")}`);
  }
  for (const required of [
    "/packages/console-server/src/main.ts/",
    "/packages/console-server/src/server.ts/",
    "/packages/console-server/src/page.ts/",
    "/packages/update-manager/",
  ]) {
    if (!normalized.some((input) => input.includes(required))) {
      throw new Error(`Console Server Bundle is missing required input: ${required}`);
    }
  }
  return { inputs: inputs.sort() };
}

export async function buildConsoleServerBundle({ repositoryRoot, outputPath }) {
  await mkdir(path.dirname(outputPath), { recursive: true });
  const result = await esbuildBuild({
    absWorkingDir: repositoryRoot,
    entryPoints: ["packages/console-server/src/main.ts"],
    outfile: outputPath,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    packages: "bundle",
    sourcemap: false,
    metafile: true,
    // The page script is served from its own function source; keep it readable.
    minify: false,
    treeShaking: true,
    charset: "utf8",
    legalComments: "none",
    logLevel: "silent",
  });
  if (!result.metafile) throw new Error("Console Server build did not return a metafile");
  const audit = auditConsoleServerMetafile(result.metafile);
  const source = await readFile(outputPath, "utf8");
  for (const forbidden of ["@anthropic-ai/", "@codexhost/adapter-"]) {
    if (source.includes(forbidden)) {
      throw new Error(`Console Server Bundle contains forbidden reference: ${forbidden}`);
    }
  }
  return audit;
}

function parseOutput(arguments_) {
  if (arguments_.length !== 2 || arguments_[0] !== "--output" || !arguments_[1]) {
    throw new Error(
      "usage: node packages/console-server/scripts/build-release.mjs --output <file>",
    );
  }
  return path.resolve(arguments_[1]);
}

const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invoked === import.meta.url) {
  const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
  buildConsoleServerBundle({
    repositoryRoot,
    outputPath: parseOutput(process.argv.slice(2)),
  }).catch((error) => {
    console.error(
      `codexhost Console Server Bundle: ${error instanceof Error ? error.message : error}`,
    );
    process.exitCode = 1;
  });
}
