import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  ensureNodeArchive,
  extractNodeRuntime,
  nodeExtractionCommand,
  sha256File,
} from "../../scripts/release/node-runtime.mjs";
import { releaseTarget } from "../../scripts/release/targets.mjs";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function temporaryDirectory() {
  return mkdtemp(path.join(os.tmpdir(), "codexhost-node-runtime-"));
}

function extractionDirectory(arguments_) {
  const directory = arguments_.at(-1);
  if (!directory) throw new Error("extraction directory argument is missing");
  return directory;
}

describe("fixed Node.js Runtime", () => {
  it("hashes files and reuses only a valid cache entry", async () => {
    const directory = await temporaryDirectory();
    try {
      const bytes = Buffer.from("valid archive");
      const target = { ...releaseTarget("macos-arm64"), nodeArchiveSha256: sha256(bytes) };
      const archive = path.join(directory, target.nodeArchive);
      await writeFile(archive, bytes);
      expect(await sha256File(archive)).toBe(target.nodeArchiveSha256);
      expect(
        await ensureNodeArchive({
          target,
          cacheDirectory: directory,
          fetchImpl: () => {
            throw new Error("valid cache must not download");
          },
        }),
      ).toBe(archive);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a modified cache without downloading a replacement", async () => {
    const directory = await temporaryDirectory();
    try {
      const target = releaseTarget("macos-arm64");
      await writeFile(path.join(directory, target.nodeArchive), "modified");
      let downloaded = false;
      await expect(
        ensureNodeArchive({
          target,
          cacheDirectory: directory,
          fetchImpl: () => {
            downloaded = true;
            throw new Error("must not download");
          },
        }),
      ).rejects.toThrow("SHA-256 mismatch");
      expect(downloaded).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("downloads, verifies, and atomically caches a missing archive", async () => {
    const directory = await temporaryDirectory();
    try {
      const bytes = Buffer.from("downloaded archive");
      const target = { ...releaseTarget("macos-arm64"), nodeArchiveSha256: sha256(bytes) };
      const archive = await ensureNodeArchive({
        target,
        cacheDirectory: directory,
        fetchImpl: async () => new Response(bytes, { status: 200 }),
        baseUrl: "https://release.invalid",
      });
      expect(await readFile(archive)).toEqual(bytes);
      expect((await readdir(directory)).filter((name) => name.includes(".download-"))).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("builds platform-specific extraction commands", () => {
    expect(nodeExtractionCommand(releaseTarget("macos-x64"), "/node.tgz", "/out")).toEqual({
      command: "tar",
      args: ["-xzf", "/node.tgz", "-C", "/out"],
    });
    expect(
      nodeExtractionCommand(releaseTarget("windows-arm64"), "C:\\node.zip", "C:\\out"),
    ).toEqual({
      command: "tar.exe",
      args: ["-xf", "C:\\node.zip", "-C", "C:\\out"],
    });
  });

  it("copies only Node and its license then cleans extraction files", async () => {
    const directory = await temporaryDirectory();
    try {
      const target = releaseTarget("macos-arm64");
      const payloadRoot = path.join(directory, "payload");
      const destinationNode = await extractNodeRuntime({
        target,
        archivePath: path.join(directory, target.nodeArchive),
        payloadRoot,
        async runCommand(_command, arguments_) {
          const archiveRoot = path.join(extractionDirectory(arguments_), target.nodeArchiveRoot);
          await mkdir(path.join(archiveRoot, "bin"), { recursive: true });
          await writeFile(path.join(archiveRoot, "bin/node"), "node");
          await writeFile(path.join(archiveRoot, "LICENSE"), "license");
          await writeFile(path.join(archiveRoot, "README.md"), "not released");
        },
      });
      expect(await readFile(destinationNode, "utf8")).toBe("node");
      expect(await readFile(path.join(payloadRoot, "licenses/Node.js-LICENSE.txt"), "utf8")).toBe(
        "license",
      );
      await expect(access(path.join(payloadRoot, "README.md"))).rejects.toThrow();
      expect(
        (await readdir(directory)).filter((name) => name.startsWith(".node-extract-")),
      ).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("cleans extraction files when required content is missing", async () => {
    const directory = await temporaryDirectory();
    try {
      const target = releaseTarget("windows-x64");
      await expect(
        extractNodeRuntime({
          target,
          archivePath: path.join(directory, target.nodeArchive),
          payloadRoot: path.join(directory, "payload"),
          async runCommand(_command, arguments_) {
            await mkdir(path.join(extractionDirectory(arguments_), target.nodeArchiveRoot), {
              recursive: true,
            });
          },
        }),
      ).rejects.toThrow("Node.js executable is missing");
      expect(
        (await readdir(directory)).filter((name) => name.startsWith(".node-extract-")),
      ).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
