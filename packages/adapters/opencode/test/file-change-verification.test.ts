import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { openCodeFileIdentity, verifiedOpenCodeWorktree } from "../src/file-change-verification.js";

const volumeRoot = path.parse(process.cwd()).root;
const worktree = path.join(volumeRoot, "codexhost-synthetic-worktree");
const directory = path.join(worktree, "packages", "app");

describe("OpenCode strict FileChange path verification", () => {
  it("uses authoritative worktree identity across absolute and relative paths", () => {
    const verified = verifiedOpenCodeWorktree(directory, { directory, worktree });
    expect(verified).toBe(worktree);
    if (!verified) throw new Error("Synthetic worktree was not verified");

    expect(openCodeFileIdentity(path.join(worktree, "src", "fixture.ts"), verified)).toBe(
      openCodeFileIdentity(path.join("src", "fixture.ts"), verified),
    );
  });

  it("keeps equal basenames in different worktree directories distinct", () => {
    expect(openCodeFileIdentity(path.join("src", "fixture.ts"), worktree)).not.toBe(
      openCodeFileIdentity(path.join("other", "fixture.ts"), worktree),
    );
  });

  it.skipIf(process.platform === "win32")(
    "canonicalizes directory aliases without collapsing a file symlink into its target",
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "codexhost-opencode-paths-"));
      const realWorktree = path.join(root, "real-worktree");
      const aliasWorktree = path.join(root, "alias-worktree");
      const outside = path.join(root, "outside");
      try {
        await fs.mkdir(realWorktree);
        await fs.mkdir(path.join(outside, "nested"), { recursive: true });
        await fs.writeFile(path.join(realWorktree, "target.ts"), "target\n", "utf8");
        await fs.writeFile(path.join(outside, "escape.ts"), "outside\n", "utf8");
        await fs.symlink(realWorktree, aliasWorktree);
        await fs.symlink("target.ts", path.join(realWorktree, "link.ts"));
        await fs.symlink(path.join(outside, "nested"), path.join(realWorktree, "outside-link"));

        const verified = verifiedOpenCodeWorktree(aliasWorktree, {
          directory: realWorktree,
          worktree: aliasWorktree,
        });
        const canonicalWorktree = await fs.realpath(realWorktree);
        expect(verified).toBe(canonicalWorktree);
        if (!verified) throw new Error("Aliased worktree was not verified");
        expect(openCodeFileIdentity(path.join(aliasWorktree, "link.ts"), verified)).toBe(
          path.join(canonicalWorktree, "link.ts"),
        );
        expect(openCodeFileIdentity(path.join(aliasWorktree, "target.ts"), verified)).toBe(
          path.join(canonicalWorktree, "target.ts"),
        );
        expect(
          openCodeFileIdentity(
            `${aliasWorktree}${path.sep}outside-link${path.sep}..${path.sep}escape.ts`,
            verified,
          ),
        ).toBeUndefined();
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );

  it.each([
    "../outside/fixture.ts",
    "src/../fixture.ts",
    path.join(path.dirname(worktree), "outside", "fixture.ts"),
    "bad\0path.ts",
    "bad\npath.ts",
  ])("rejects an invalid or out-of-worktree file path: %s", (file) => {
    expect(openCodeFileIdentity(file, worktree)).toBeUndefined();
  });

  it("rejects relative, mismatched, or out-of-worktree path metadata", () => {
    expect(
      verifiedOpenCodeWorktree("relative", { directory: "relative", worktree: "also-relative" }),
    ).toBeUndefined();
    expect(
      verifiedOpenCodeWorktree(directory, {
        directory: path.join(worktree, "different"),
        worktree,
      }),
    ).toBeUndefined();
    expect(
      verifiedOpenCodeWorktree(`${worktree}${path.sep}packages${path.sep}..${path.sep}app`, {
        directory,
        worktree,
      }),
    ).toBeUndefined();
    expect(
      verifiedOpenCodeWorktree(directory, {
        directory,
        worktree: path.join(worktree, "nested-root"),
      }),
    ).toBeUndefined();
  });
});
