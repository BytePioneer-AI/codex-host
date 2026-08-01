import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { build as esbuildBuild } from "esbuild";

const forbiddenInputFragments = [
  "/packages/adapters/claude-code/",
  "/node_modules/@anthropic-ai/",
  "/node_modules/@modelcontextprotocol/",
  "/test/",
  "/tests/",
  "/tools/",
];
const forbiddenBundleReferences = [
  "@anthropic-ai/",
  "@codexhost/adapter-claude-code",
  "claude-agent-sdk",
];
const allowedRuntimePackages = new Set(["diff", "zod"]);

function normalizedInputPath(value) {
  return `/${value.replaceAll("\\", "/").replace(/^\/+|\/+$/gu, "")}/`;
}

function packageNameFromInput(input) {
  const normalized = `/${input.replaceAll("\\", "/").replace(/^\/+/, "")}`;
  const marker = "/node_modules/";
  const markerIndex = normalized.lastIndexOf(marker);
  if (markerIndex < 0) return null;
  const segments = normalized.slice(markerIndex + marker.length).split("/");
  return segments[0]?.startsWith("@") ? segments.slice(0, 2).join("/") : (segments[0] ?? null);
}

export function auditHostBundleMetafile(metafile) {
  const inputs = Object.keys(metafile.inputs ?? {});
  const normalized = inputs.map(normalizedInputPath);
  const forbidden = normalized.filter((input) =>
    forbiddenInputFragments.some((fragment) => input.includes(fragment)),
  );
  if (forbidden.length > 0) {
    throw new Error(`release Host Bundle contains forbidden inputs: ${forbidden.join(", ")}`);
  }
  for (const required of [
    "/packages/host-runtime/src/release-main.ts/",
    "/packages/host-runtime/src/app-server-host.ts/",
    "/packages/adapters/pi/",
  ]) {
    if (!normalized.some((input) => input.includes(required))) {
      throw new Error(`release Host Bundle is missing required input: ${required}`);
    }
  }

  const runtimePackages = [
    ...new Set(inputs.map(packageNameFromInput).filter((name) => name !== null)),
  ].sort();
  const unexpectedPackages = runtimePackages.filter(
    (packageName) => !allowedRuntimePackages.has(packageName),
  );
  if (unexpectedPackages.length > 0) {
    throw new Error(
      `release Host Bundle contains unreviewed runtime packages: ${unexpectedPackages.join(", ")}`,
    );
  }
  return { inputs: inputs.sort(), runtimePackages };
}

export function auditHostBundleSource(source) {
  const forbidden = forbiddenBundleReferences.filter((reference) => source.includes(reference));
  if (forbidden.length > 0) {
    throw new Error(`release Host Bundle contains forbidden references: ${forbidden.join(", ")}`);
  }
}

export async function buildReleaseHostBundle({ repositoryRoot, outputPath }) {
  await mkdir(path.dirname(outputPath), { recursive: true });
  const result = await esbuildBuild({
    absWorkingDir: repositoryRoot,
    entryPoints: ["packages/host-runtime/src/release-main.ts"],
    outfile: outputPath,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    packages: "bundle",
    sourcemap: false,
    metafile: true,
    minify: false,
    treeShaking: true,
    charset: "utf8",
    legalComments: "none",
    logLevel: "silent",
  });
  if (!result.metafile) throw new Error("release Host Bundle build did not return a metafile");
  const audit = auditHostBundleMetafile(result.metafile);
  auditHostBundleSource(await readFile(outputPath, "utf8"));
  return audit;
}

function parseOutput(arguments_) {
  if (arguments_.length !== 2 || arguments_[0] !== "--output" || !arguments_[1]) {
    throw new Error("usage: node packages/host-runtime/scripts/build-release.mjs --output <file>");
  }
  return path.resolve(arguments_[1]);
}

const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invoked === import.meta.url) {
  const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
  buildReleaseHostBundle({ repositoryRoot, outputPath: parseOutput(process.argv.slice(2)) }).catch(
    (error) => {
      console.error(`codexhost Host Bundle: ${error instanceof Error ? error.message : error}`);
      process.exitCode = 1;
    },
  );
}
