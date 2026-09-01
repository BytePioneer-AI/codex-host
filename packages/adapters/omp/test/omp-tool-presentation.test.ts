import { describe, expect, it } from "vitest";

import { hostItemIdSchema } from "@codexhost/shared-contracts";

import { projectOmpToolItem } from "../src/omp-tool-presentation.js";

const itemId = hostItemIdSchema.parse("omp-tool-1");

describe("OMP Tool presentation", () => {
  it("reports text tools through the shared Command Execution type", () => {
    expect(
      projectOmpToolItem({
        itemId,
        toolName: "read",
        arguments: { path: "a.txt" },
        cwd: "/workspace",
      }),
    ).toEqual({
      type: "commandExecution",
      itemId,
      command: 'read {"path":"a.txt"}',
      cwd: "/workspace",
    });
  });

  it("preserves the native Bash command", () => {
    expect(
      projectOmpToolItem({
        itemId,
        toolName: "bash",
        arguments: { command: "printf done", cwd: "/workspace" },
        cwd: "/workspace",
      }),
    ).toMatchObject({ type: "commandExecution", command: "printf done", cwd: "/workspace" });
  });
});
