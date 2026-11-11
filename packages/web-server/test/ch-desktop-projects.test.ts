import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { completeDesktopProjects } from "../src/ch-desktop-projects.ts";

it("supplements migrated Desktop projects without restarting or changing the Host's memberships", async () => {
  const root = await mkdtemp(join(tmpdir(), "web-desktop-projects-"));
  try {
    const selected = { id: "selected", name: "Selected", rootPaths: [join(root, "selected")] };
    const migrated = { id: "legacy", name: "Administrator", rootPaths: [join(root, "legacy")] };
    const hidden = { id: "hidden", name: "Hidden", rootPaths: [join(root, "hidden")] };
    const foreign = { id: "foreign", name: "Foreign", rootPaths: [join(root, "foreign")] };
    const text = JSON.stringify({
      "project-order": ["remote-project", "selected"],
      "local-projects": { selected, migrated, hidden, foreign },
      "app-server-project-id-by-legacy-project-id-by-host": {
        [`local:${resolve(root)}`]: { legacy: "native-id" },
        "remote-ssh:other": { foreign: "foreign-native-id" },
      },
      privateData: "not exposed",
    });
    const file = join(root, ".codex-global-state.json");
    await writeFile(file, text);
    const original = {
      projects: [selected],
      assignments: { thread: "legacy" },
      projectless: ["unselected"],
      pinned: [],
    };
    const result = await completeDesktopProjects(original, root);
    assert.deepEqual(result.projects, [selected, migrated]);
    assert.equal(result.assignments, original.assignments);
    assert.equal(result.projectless, original.projectless);
    assert.equal(await readFile(file, "utf8"), text);
    assert.equal("privateData" in result, false);
    assert.deepEqual((await completeDesktopProjects(result, root)).projects, result.projects);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("keeps the authoritative snapshot when Desktop metadata is absent or malformed", async () => {
  const root = await mkdtemp(join(tmpdir(), "web-desktop-projects-missing-"));
  try {
    const original = { projects: [], assignments: {}, projectless: [], pinned: [] };
    assert.equal(await completeDesktopProjects(original, root), original);
    await writeFile(join(root, ".codex-global-state.json"), "{invalid");
    assert.equal(await completeDesktopProjects(original, root), original);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
