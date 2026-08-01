import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, copyFile, lstat, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { NODE_DIST_BASE_URL } from "./targets.mjs";

function errorCode(error) {
  return typeof error === "object" && error !== null && typeof error.code === "string"
    ? error.code
    : undefined;
}

export async function sha256File(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function isFile(filePath) {
  try {
    return (await lstat(filePath)).isFile();
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

export async function verifyNodeArchive(archivePath, expectedSha256) {
  const actual = await sha256File(archivePath);
  if (actual !== expectedSha256) {
    throw new Error(
      `Node.js archive SHA-256 mismatch for '${path.basename(archivePath)}': expected ${expectedSha256}, got ${actual}`,
    );
  }
  return actual;
}

export async function ensureNodeArchive({
  target,
  cacheDirectory,
  fetchImpl = fetch,
  baseUrl = NODE_DIST_BASE_URL,
}) {
  await mkdir(cacheDirectory, { recursive: true });
  const archivePath = path.join(cacheDirectory, target.nodeArchive);
  if (await isFile(archivePath)) {
    await verifyNodeArchive(archivePath, target.nodeArchiveSha256);
    return archivePath;
  }

  const temporaryPath = `${archivePath}.download-${process.pid}-${Date.now()}`;
  try {
    const response = await fetchImpl(`${baseUrl}/${target.nodeArchive}`);
    if (!response.ok) {
      throw new Error(
        `Node.js archive download failed with HTTP ${response.status}: ${target.nodeArchive}`,
      );
    }
    if (response.body === null) throw new Error("Node.js archive response has no body");
    await pipeline(Readable.from(response.body), createWriteStream(temporaryPath, { flags: "wx" }));
    await verifyNodeArchive(temporaryPath, target.nodeArchiveSha256);
    await rename(temporaryPath, archivePath);
    return archivePath;
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

export function nodeExtractionCommand(target, archivePath, outputDirectory) {
  if (target.nodeArchiveFormat === "tar.gz") {
    return { command: "tar", args: ["-xzf", archivePath, "-C", outputDirectory] };
  }
  if (target.nodeArchiveFormat === "zip") {
    return { command: "tar.exe", args: ["-xf", archivePath, "-C", outputDirectory] };
  }
  throw new Error(`unsupported Node.js archive format: ${target.nodeArchiveFormat}`);
}

function runExtractionCommand(command, arguments_) {
  const result = spawnSync(command, arguments_, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = result.stderr.trim();
    throw new Error(
      `Node.js archive extraction failed with status ${result.status}${detail ? `: ${detail}` : ""}`,
    );
  }
}

async function requireRegularFile(filePath, label) {
  const metadata = await lstat(filePath).catch((error) => {
    throw new Error(`${label} is missing from the Node.js archive: ${error.message}`);
  });
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label} is not a regular file in the Node.js archive`);
  }
}

export async function extractNodeRuntime({
  target,
  archivePath,
  payloadRoot,
  runCommand = runExtractionCommand,
}) {
  await mkdir(path.dirname(payloadRoot), { recursive: true });
  const extractionDirectory = await mkdtemp(path.join(path.dirname(payloadRoot), ".node-extract-"));
  try {
    const extraction = nodeExtractionCommand(target, archivePath, extractionDirectory);
    await runCommand(extraction.command, extraction.args);
    const archiveRoot = path.join(extractionDirectory, target.nodeArchiveRoot);
    const sourceNode = path.join(archiveRoot, ...target.nodeExecutable.split("/"));
    const sourceLicense = path.join(archiveRoot, "LICENSE");
    await requireRegularFile(sourceNode, "Node.js executable");
    await requireRegularFile(sourceLicense, "Node.js LICENSE");

    const destinationNode = path.join(payloadRoot, "runtime", `node${target.executableSuffix}`);
    await mkdir(path.dirname(destinationNode), { recursive: true });
    await mkdir(path.join(payloadRoot, "licenses"), { recursive: true });
    await copyFile(sourceNode, destinationNode);
    if (target.hostPlatform === "darwin") await chmod(destinationNode, 0o755);
    await copyFile(sourceLicense, path.join(payloadRoot, "licenses", "Node.js-LICENSE.txt"));
    return destinationNode;
  } finally {
    await rm(extractionDirectory, { recursive: true, force: true });
  }
}
