import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { harnessIdSchema, hostThreadIdSchema } from "@codexhost/shared-contracts";
import { MappingStore } from "../src/index.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function setup(beforeReplace?: () => Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), "mapping-projectless-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const store = new MappingStore({ directory, ...(beforeReplace ? { beforeReplace } : {}) });
  cleanup.push(() => store.close());
  await store.initialize();
  const input = {
    hostThreadId: hostThreadIdSchema.parse("projectless-thread"),
    createRequestId: "first-submit",
    harnessId: harnessIdSchema.parse("pi"),
    cwd: path.join(directory, "execution"),
    transportModelId: "codexhost/pi-native",
    ephemeral: false,
    historyMode: "paginated" as const,
    projectlessWorkspace: {
      workspaceRoot: directory,
      outputDirectory: path.join(directory, "execution", "outputs"),
    },
  };
  return { store, directory, input };
}

it("does not admit a Thread when its no-project metadata cannot be published", async () => {
  const { store, directory, input } = await setup();
  const blocker = path.join(directory, "thread-metadata", `${input.hostThreadId}.json`);
  await mkdir(blocker);
  await writeFile(path.join(blocker, "keep"), "block atomic rename");
  await expect(store.createProvisional(input)).rejects.toMatchObject({ code: "IO_ERROR" });
  expect(await store.getThread(input.hostThreadId)).toBeNull();
  await expect(
    stat(path.join(directory, "threads", `${input.hostThreadId}.json`)),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

it("removes the prepublished sidecar if core record creation fails", async () => {
  const { store, directory, input } = await setup(async () => {
    throw new Error("Core write failed");
  });
  await expect(store.createProvisional(input)).rejects.toMatchObject({ code: "IO_ERROR" });
  expect(await store.getThread(input.hostThreadId)).toBeNull();
  expect(await readdir(path.join(directory, "thread-metadata"))).toEqual([]);
});
