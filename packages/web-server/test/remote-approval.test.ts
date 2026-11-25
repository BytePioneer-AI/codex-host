import assert from "node:assert/strict";
import { it } from "node:test";
import { remoteApprovalPresentation } from "../src/remote-approval.ts";
import { canReorderWorkspaces } from "@deepseek-ai/dsh-client-ui-workspace/src/client/rows/workspace-reorder.ts";

it("presents command and file approvals without private routing fields", () => {
  const command = remoteApprovalPresentation({
    method: "item/commandExecution/requestApproval",
    params: {
      command: "npm test",
      cwd: "/project",
      reason: "Run tests",
      threadId: "private-thread",
      itemId: "private-item",
    },
  });
  assert.match(command.reason, /npm test/);
  assert.match(command.reason, /\/project/);
  assert.match(command.displayReason.zh, /工作目录/);
  assert.doesNotMatch(JSON.stringify(command), /private-thread|private-item|threadId|itemId/);
  const file = remoteApprovalPresentation({
    method: "item/fileChange/requestApproval",
    params: {
      grantRoot: "/project/src",
      reason: "Update component",
      changes: { "/project/src/a.ts": {} },
      threadId: "private-thread",
    },
  });
  assert.match(file.reason, /\/project\/src\/a.ts/);
  assert.match(file.reason, /Update component/);
  assert.doesNotMatch(file.reason, /private-thread/);
});

it("allows mixed local and remote workspace reordering while rejecting invalid targets", () => {
  const rows = [
    { workspaceId: "a" },
    { workspaceId: "b" },
    { workspaceId: "mac", remote: { hostId: "mac" } },
    { workspaceId: "other", remote: { hostId: "other" } },
    { workspaceId: "sectioned" },
    { workspaceId: "child" },
  ];
  const context = {
    sectionOf: new Map([["sectioned", "sec-1"]]),
    parents: new Map<string, string | undefined>([
      ["a", undefined],
      ["b", undefined],
      ["mac", undefined],
      ["other", undefined],
      ["sectioned", undefined],
      ["child", "a"],
    ]),
  };
  for (const [source, target] of [
    ["a", "b"],
    ["a", "mac"],
    ["mac", "a"],
    ["mac", "other"],
  ] as const) {
    assert.equal(canReorderWorkspaces(rows, source, target, context), true);
  }
  for (const [source, target] of [
    ["a", "a"],
    ["missing", "a"],
    ["a", "missing"],
    ["sectioned", "a"],
    ["a", "sectioned"],
    ["child", "mac"],
    ["a", "child"],
  ] as const) {
    assert.equal(canReorderWorkspaces(rows, source, target, context), false);
  }
});

it("uses the matching pending file-change item when approval params omit paths", () => {
  const shown = remoteApprovalPresentation(
    { method: "item/fileChange/requestApproval", params: { itemId: "chosen" } },
    {
      turns: [
        {
          items: [
            { id: "other", changes: [{ path: "/unrelated" }] },
            { id: "chosen", changes: [{ path: "/project/change.ts" }] },
          ],
        },
      ],
    },
  );
  assert.match(shown.reason, /\/project\/change.ts/);
  assert.doesNotMatch(shown.reason, /unrelated|chosen/);
});
