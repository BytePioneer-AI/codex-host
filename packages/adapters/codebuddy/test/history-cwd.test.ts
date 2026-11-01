import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, it, expect } from "vitest";
import { codeBuddyNativeHistory } from "../src/history.js";
import { CODEBUDDY_ID } from "../src/common.js";
describe("historical CodeBuddy workspace ownership", () => {
  it("reports an unavailable historical cwd without calling an existing requested cwd missing", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cb-cwd-"));
    try {
      const project = path.join(root, "config/projects/fixture"),
        cwd = path.join(root, "current");
      await mkdir(project, { recursive: true });
      await mkdir(cwd);
      await writeFile(
        path.join(project, "native.jsonl"),
        JSON.stringify({
          type: "message",
          role: "user",
          id: "u",
          sessionId: "native",
          cwd: path.join(root, "removed"),
          content: "hello",
        }),
      );
      await expect(
        codeBuddyNativeHistory(
          cwd,
          { harnessId: CODEBUDDY_ID, nativeSessionId: "native", formatVersion: 1 },
          { CODEBUDDY_CONFIG_DIR: path.join(root, "config") },
        ),
      ).rejects.toMatchObject({
        code: "invalidRequest",
        message: expect.stringContaining("historical working directory"),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
