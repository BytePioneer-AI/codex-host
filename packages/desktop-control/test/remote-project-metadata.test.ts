import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRemoteProjectMetadata } from "../src/remote-project-metadata.js";
describe("Desktop remote project metadata", () => {
  it("exports only explicit ordered remote projects and matching assignments", async () => {
    const dir = await mkdtemp(join(tmpdir(), "remote-projects-"));
    try {
      const file = join(dir, "state.json");
      await writeFile(
        file,
        JSON.stringify({
          "project-order": ["p"],
          "remote-projects": [
            {
              id: "p",
              hostId: "remote-ssh-discovered:mac",
              label: "playcodex",
              remotePath: "/Users/test/work",
            },
            { id: "removed", hostId: "remote-control:other", label: "old", remotePath: "/tmp" },
          ],
          "thread-project-assignments": {
            t: { projectKind: "remote", projectId: "p" },
            local: { projectKind: "local", projectId: "p" },
          },
          secret: "must not cross boundary",
        }),
      );
      expect(await readRemoteProjectMetadata(file)).toEqual([
        {
          id: "p",
          hostId: "remote-ssh-discovered:mac",
          name: "playcodex",
          path: "/Users/test/work",
          threadIds: ["t"],
        },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
