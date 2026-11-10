import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DelegationControlApi, DelegationThreadSnapshot } from "../src/delegation-types.js";
import { readThreadResultFile } from "../src/thread-result-file.js";

describe("Thread result files", () => {
  let directory: string;
  let workspace: string;
  let snapshot: DelegationThreadSnapshot;
  const read = vi.fn(async () => snapshot);
  const api = { read } as unknown as DelegationControlApi;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "result-files-"));
    workspace = path.join(directory, "workspace");
    await mkdir(workspace);
    snapshot = {
      threadId: "task-1",
      harnessId: "codex",
      cwd: workspace,
      status: "completed",
      turn: { turnId: "turn-1", status: "completed" },
      progress: [],
      result: { availability: "available", text: "" },
      nextCursor: null,
    };
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("exports linked binary files losslessly in revision-bound chunks", async () => {
    const filename = "骑鹈鹕 (final).png";
    const bytes = Buffer.from(Array.from({ length: 513 }, (_, index) => index % 256));
    await writeFile(path.join(workspace, filename), bytes);
    snapshot.result.text = `![成品](<${path.join(workspace, filename)}>)`;
    const chunks: Buffer[] = [];
    let offset = 0;
    let revision: string | undefined;
    for (;;) {
      const chunk = await readThreadResultFile(api, {
        threadId: "task-1",
        path: filename,
        offset,
        limit: 200,
        ...(revision ? { revision } : {}),
      });
      expect(chunk).toMatchObject({
        filename,
        size: bytes.length,
        mimeType: "image/png",
        encoding: "base64",
        offset,
      });
      chunks.push(Buffer.from(chunk.data, "base64"));
      offset = chunk.nextOffset;
      revision = chunk.revision;
      if (chunk.eof) break;
    }
    expect(Buffer.concat(chunks)).toEqual(bytes);
  });

  it("accepts relative links, file URIs and empty files", async () => {
    await writeFile(path.join(workspace, "empty.txt"), "");
    for (const link of ["empty.txt", pathToFileURL(path.join(workspace, "empty.txt")).href]) {
      snapshot.result.text = `[result](${link})`;
      await expect(
        readThreadResultFile(api, { threadId: "task-1", path: "empty.txt" }),
      ).resolves.toMatchObject({ size: 0, data: "", eof: true, nextOffset: 0 });
    }
  });

  it("rejects unlinked files and links outside the workspace", async () => {
    await writeFile(path.join(directory, "private.txt"), "private");
    await writeFile(path.join(workspace, "draft.txt"), "draft");
    snapshot.result.text = `[outside](../private.txt)`;
    for (const file of ["../private.txt", "draft.txt", path.join(directory, "private.txt")]) {
      await expect(
        readThreadResultFile(api, { threadId: "task-1", path: file }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
  });

  it("rejects workspace symlinks that escape and directories", async () => {
    const outside = path.join(directory, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "private.txt"), "private");
    await symlink(
      outside,
      path.join(workspace, "escape"),
      process.platform === "win32" ? "junction" : "dir",
    );
    snapshot.result.text = `[outside](escape/private.txt) [directory](escape)`;
    await expect(
      readThreadResultFile(api, { threadId: "task-1", path: "escape/private.txt" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    snapshot.result.text = `[folder](folder)`;
    await mkdir(path.join(workspace, "folder"));
    await expect(
      readThreadResultFile(api, { threadId: "task-1", path: "folder" }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it("refuses downloads without a final result or a known workspace", async () => {
    snapshot.result = { availability: "pending" };
    await expect(
      readThreadResultFile(api, { threadId: "task-1", path: "result.png" }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    snapshot.result = { availability: "available", text: "[result](result.png)" };
    delete snapshot.cwd;
    await expect(
      readThreadResultFile(api, { threadId: "task-1", path: "result.png" }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED" });
    snapshot.cwd = workspace;
    snapshot.hostId = "other-host";
    await expect(
      readThreadResultFile(api, { threadId: "task-1", path: "result.png" }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED" });
  });

  it("refuses to join chunks from different file revisions", async () => {
    const file = path.join(workspace, "report.txt");
    await writeFile(file, "first version");
    snapshot.result.text = "[report](report.txt)";
    const first = await readThreadResultFile(api, {
      threadId: "task-1",
      path: "report.txt",
      limit: 3,
    });
    await writeFile(file, "replacement version");
    await expect(
      readThreadResultFile(api, {
        threadId: "task-1",
        path: "report.txt",
        offset: first.nextOffset,
        revision: first.revision,
      }),
    ).rejects.toMatchObject({ code: "DELEGATION_FAILED" });
  });

  it("rejects invalid ranges and continuation without a revision", async () => {
    for (const options of [{ offset: -1 }, { limit: 0 }, { limit: 1048577 }, { offset: 1 }]) {
      await expect(
        readThreadResultFile(api, { threadId: "task-1", path: "result.png", ...options }),
      ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    }
  });
});
