import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { build as esbuildBuild } from "esbuild";

const forbiddenInputFragments = [
  "/packages/adapters/claude-code/",
  "/node_modules/@anthropic-ai/",
  "/test/",
  "/tests/",
  "/tools/",
];

function normalizedInputPath(value) {
  return `/${value.replaceAll("\\", "/").replace(/^\/+|\/+$/gu, "")}/`;
}

export function auditDesktopControllerMetafile(metafile) {
  const inputs = Object.keys(metafile.inputs ?? {});
  const normalized = inputs.map(normalizedInputPath);
  const forbidden = normalized.filter((input) =>
    forbiddenInputFragments.some((fragment) => input.includes(fragment)),
  );
  if (forbidden.length > 0) {
    throw new Error(`Desktop Controller Bundle contains forbidden inputs: ${forbidden.join(", ")}`);
  }
  for (const required of [
    "/packages/desktop-control/src/release-main.ts/",
    "/packages/desktop-control/src/production-controller.ts/",
    "/packages/desktop-control/src/renderer-control-session.ts/",
    "/packages/desktop-control/src/controller-attachment-server.ts/",
    "/packages/desktop-control/src/main-process-title-policy.ts/",
    "/packages/desktop-control/src/renderer-draft-prewarm-policy.ts/",
  ]) {
    if (!normalized.some((input) => input.includes(required))) {
      throw new Error(`Desktop Controller Bundle is missing required input: ${required}`);
    }
  }
  return { inputs: inputs.sort() };
}

export async function buildDesktopControllerBundle({ repositoryRoot, outputPath }) {
  await mkdir(path.dirname(outputPath), { recursive: true });
  const result = await esbuildBuild({
    absWorkingDir: repositoryRoot,
    entryPoints: ["packages/desktop-control/src/release-main.ts"],
    outfile: outputPath,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    packages: "bundle",
    sourcemap: false,
    metafile: true,
    minify: false,
    treeShaking: true,
    charset: "utf8",
    legalComments: "none",
    logLevel: "silent",
  });
  if (!result.metafile) throw new Error("Desktop Controller build did not return a metafile");
  const audit = auditDesktopControllerMetafile(result.metafile);
  const source = await readFile(outputPath, "utf8");
  for (const forbidden of ["@anthropic-ai/", "@codexhost/adapter-claude-code"]) {
    if (source.includes(forbidden)) {
      throw new Error(`Desktop Controller Bundle contains forbidden reference: ${forbidden}`);
    }
  }
  return audit;
}

function parseOutput(arguments_) {
  if (arguments_.length !== 2 || arguments_[0] !== "--output" || !arguments_[1]) {
    throw new Error(
      "usage: node packages/desktop-control/scripts/build-release.mjs --output <file>",
    );
  }
  return path.resolve(arguments_[1]);
}

const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invoked === import.meta.url) {
  const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
  buildDesktopControllerBundle({
    repositoryRoot,
    outputPath: parseOutput(process.argv.slice(2)),
  }).catch((error) => {
    console.error(
      `codexhost Desktop Controller Bundle: ${error instanceof Error ? error.message : error}`,
    );
    process.exitCode = 1;
  });
}
