import { mkdir, mkdtemp, open, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import type * as FsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DelegationControlApi, DelegationThreadSnapshot } from "../src/delegation-types.js";
import { readThreadResultFile } from "../src/thread-result-file.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return { ...actual, open: vi.fn(actual.open) };
});

const actualFs = await vi.importActual<typeof FsPromises>("node:fs/promises");

describe("Thread result files", () => {
  let directory: string;
  let workspace: string;
  let snapshot: DelegationThreadSnapshot;
  const read = vi.fn(async () => snapshot);
  const api = { read } as unknown as DelegationControlApi;

  beforeEach(async () => {
    vi.mocked(open).mockImplementation(actualFs.open);
    directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "result-files-")));
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
    vi.mocked(open).mockReset();
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

  it.each([
    ["plot(1).png", "plot(1).png"],
    ["plot(1(nested)).png", "plot(1(nested)).png"],
    ["plot\\(1\\).png", "plot(1).png"],
    ["plot%281%29.png", "plot(1).png"],
  ])("exports balanced Markdown destination %s", async (link, filename) => {
    await writeFile(path.join(workspace, filename), "fixture bytes");
    snapshot.result.text = `[result](${link})`;
    await expect(
      readThreadResultFile(api, { threadId: "task-1", path: filename }),
    ).resolves.toMatchObject({ data: Buffer.from("fixture bytes").toString("base64") });
  });

  it.each(["plot(1.png", "https://example.test/plot(1).png", "../plot(1).png"])(
    "does not authorize malformed, remote or outside destination %s",
    async (link) => {
      await writeFile(path.join(workspace, "plot(1).png"), "fixture bytes");
      snapshot.result.text = `[result](${link})`;
      await expect(
        readThreadResultFile(api, { threadId: "task-1", path: "plot(1).png" }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    },
  );

  it.each([false, true])(
    "rejects a parent swapped before open, even if restored afterwards: %s",
    async (restore) => {
      const parent = path.join(workspace, "outputs");
      const saved = path.join(workspace, "saved");
      const outside = path.join(directory, "outside");
      await mkdir(parent);
      await mkdir(outside);
      await writeFile(path.join(parent, "result.txt"), "inside fixture");
      await writeFile(path.join(outside, "result.txt"), "outside fixture");
      snapshot.result.text = "[result](outputs/result.txt)";
      vi.mocked(open).mockImplementationOnce(async (...args) => {
        await rename(parent, saved);
        await symlink(outside, parent, process.platform === "win32" ? "junction" : "dir");
        const handle = await actualFs.open(...args);
        if (restore) {
          await rm(parent);
          await rename(saved, parent);
        }
        return handle;
      });
      await expect(
        readThreadResultFile(api, { threadId: "task-1", path: "outputs/result.txt" }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    },
  );

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
