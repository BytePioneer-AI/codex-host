/**
 * Apply the imported DSH dependency patches after `npm install`.
 *
 * npm installs the pinned packages, then this script applies the small upstream
 * patches for document preview, terminal helpers, and Markdown URL boundaries.
 * A patch already present is skipped so
 * repeated installs stay idempotent.
 */

import { chmodSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repositoryRoot = resolve(import.meta.dirname, "..");

/** Patch file and the installed package root it applies to. */
const patches = [
  ["patches/@fortune-sheet__core@1.0.4.patch", "node_modules/@fortune-sheet/core"],
  ["patches/@fortune-sheet__react@1.0.4.patch", "node_modules/@fortune-sheet/react"],
  ["patches/exceljs@4.4.0.patch", "node_modules/exceljs"],
  ["patches/node-pty@1.2.0-beta.15.patch", "node_modules/node-pty"],
  [
    "patches/mdast-util-gfm-autolink-literal@2.0.1.patch",
    "node_modules/mdast-util-gfm-autolink-literal",
  ],
  [
    "patches/micromark-extension-gfm-autolink-literal@2.1.0.patch",
    "node_modules/micromark-extension-gfm-autolink-literal",
  ],
];

/**
 * Run `git apply` with one patch and a package-relative target.
 * @param {string} patch - absolute patch path.
 * @param {string} directory - target directory relative to the repository root.
 * @param {boolean} reverse - check the reverse application instead of applying.
 * @returns {boolean} whether the command succeeded.
 */
function apply(patch, directory, reverse = false) {
  const result = spawnSync(
    "git",
    ["apply", "--directory", directory, "-p1", ...(reverse ? ["--reverse", "--check"] : []), patch],
    { cwd: repositoryRoot, stdio: "pipe", encoding: "utf8" },
  );
  return result.status === 0;
}

for (const [patchFile, directory] of patches) {
  const patch = resolve(repositoryRoot, patchFile);
  if (!existsSync(resolve(repositoryRoot, directory))) {
    throw new Error(`apply-dependency-patches: ${directory} is not installed`);
  }
  const content = readFileSync(patch, "utf8");
  if (content.length === 0) throw new Error(`apply-dependency-patches: ${patchFile} is empty`);
  if (apply(patch, directory, true)) continue;
  if (!apply(patch, directory)) {
    throw new Error(`apply-dependency-patches: ${patchFile} does not apply to ${directory}`);
  }
  console.log(`apply-dependency-patches: ${patchFile}`);
}

// npm strips the executable bit from node-pty's prebuilt spawn helper.
for (const helper of [
  `node_modules/node-pty/prebuilds/${process.platform}-${process.arch}/spawn-helper`,
  "node_modules/node-pty/build/Release/spawn-helper",
]) {
  const path = resolve(repositoryRoot, helper);
  if (existsSync(path)) chmodSync(path, 0o755);
}
