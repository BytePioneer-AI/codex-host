import { expect, it, vi } from "vitest";
import { readRendererLocalDraftWorkspace } from "../src/renderer-draft-workspace.js";

const projects = [{ id: "one", label: "One", cwd: "/one" }];
function read(props: Record<string, unknown>, catalog = projects) {
  const editor = {
    querySelectorAll: () => [],
    __reactFiber$app: { memoizedProps: props, return: null },
  };
  return readRendererLocalDraftWorkspace(
    { querySelectorAll: () => [editor] },
    undefined,
    () => catalog,
  );
}
const draft = {
  executionTargetHostId: "local",
  browserConversationId: "client-new-thread:test",
  selectedProject: { type: "local", projectId: "one" },
};
it("reads the workspace catalog once per call, then refreshes it on the next call", () => {
  const editor = () => ({
    querySelectorAll: () => [],
    __reactFiber$app: { memoizedProps: { ...draft }, return: null },
  });
  const root = { querySelectorAll: () => [editor(), editor()] };
  const catalog = vi.fn(() => projects);
  expect(readRendererLocalDraftWorkspace(root, undefined, catalog)).toBe("/one");
  expect(catalog).toHaveBeenCalledTimes(1);
  catalog.mockReturnValue([{ id: "one", label: "One", cwd: "/moved" }]);
  expect(readRendererLocalDraftWorkspace(root, undefined, catalog)).toBe("/moved");
  expect(catalog).toHaveBeenCalledTimes(2);
});
it.each([
  { ...draft, executionTargetHostId: "remote:one" },
  { ...draft, browserConversationId: "existing-thread" },
  { ...draft, selectedProject: null },
])("does not read the catalog without a selected local draft: %j", (props) => {
  const editor = { querySelectorAll: () => [], __reactFiber$app: { memoizedProps: props } };
  const catalog = vi.fn(() => projects);
  readRendererLocalDraftWorkspace({ querySelectorAll: () => [editor] }, undefined, catalog);
  expect(catalog).not.toHaveBeenCalled();
});
it("resolves the committed selection by project identity, including a renamed project", () => {
  expect(read(draft, [{ id: "one", cwd: "/one", label: "Renamed" }])).toBe("/one");
});
it("revokes paths for missing, nonlocal, and ambiguous project selections", () => {
  expect(read({ ...draft, selectedProject: null })).toBeNull();
  expect(read({ ...draft, selectedProject: { type: "remote", projectId: "one" } })).toBeNull();
  expect(read(draft, [])).toBeNull();
  expect(read(draft, [...projects, { id: "one", label: "Duplicate", cwd: "/other" }])).toBeNull();
});
it("never derives a local workspace from a remote Composer or an existing thread", () => {
  expect(read({ ...draft, executionTargetHostId: "remote:one" })).toBeUndefined();
  expect(read({ ...draft, browserConversationId: "existing-thread" })).toBeUndefined();
  expect(read({ ...draft, permissionsHostId: "remote:one" })).toBeUndefined();
});
it("rejects conflicting mounted local drafts instead of taking the first project", () => {
  const editors = ["one", "two"].map((projectId) => ({
    querySelectorAll: () => [],
    __reactFiber$app: {
      memoizedProps: { ...draft, selectedProject: { type: "local", projectId } },
      return: null,
    },
  }));
  expect(
    readRendererLocalDraftWorkspace({ querySelectorAll: () => editors }, undefined, () => [
      ...projects,
      { id: "two", label: "Two", cwd: "/two" },
    ]),
  ).toBeNull();
});
