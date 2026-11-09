// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { useTurnDiffs } from "../../../apps/web-ui/packages/client/ui-chat/src/client/chat/use-turn-diffs.ts";
import type { FileChange } from "../../../apps/web-ui/packages/client/ui-chat/src/client/chat/turn-file-changes.ts";

afterEach(() => vi.unstubAllGlobals());

it("requests only expanded missing files when two of three files are expanded together", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const files: FileChange[] = ["a.ts", "b.ts", "c.ts"].map((path) => ({
    path,
    added: 1,
    removed: 1,
    revision: "v1",
  }));
  let expanded = new Set(["a.ts", "b.ts"]);
  const load = vi.fn(async (turn: number, path?: string) => [
    { path: String(path), oldText: "old", newText: `full diff ${turn} ${path}` },
  ]);
  const host = document.createElement("div");
  const root = createRoot(host);
  function View() {
    const full = useTurnDiffs(12, files, expanded, load);
    return createElement("pre", null, JSON.stringify(files.map((file) => full.diffs(file))));
  }
  try {
    await act(async () => root.render(createElement(View)));
    expect(load.mock.calls).toEqual([
      [12, "a.ts"],
      [12, "b.ts"],
    ]);
    expect(host.textContent).toContain("full diff 12 a.ts");
    expect(host.textContent).toContain("full diff 12 b.ts");
    expect(host.textContent).not.toContain("full diff 12 c.ts");
    expanded = new Set(["b.ts", "c.ts"]);
    await act(async () => root.render(createElement(View)));
    expect(load.mock.calls).toEqual([
      [12, "a.ts"],
      [12, "b.ts"],
      [12, "c.ts"],
    ]);
  } finally {
    act(() => root.unmount());
  }
});

it("fetches only expanded files, retries failures, and refreshes equal-count content revisions", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let file: FileChange = { path: "a.ts", added: 1, removed: 1, revision: "v1" };
  let files = [file];
  let expanded = new Set<string>();
  const load = vi.fn(async () => [{ path: "a.ts", oldText: "old", newText: "first full diff" }]);
  load.mockRejectedValueOnce(new Error("Temporary diff error"));
  const host = document.createElement("div");
  const root = createRoot(host);
  function View() {
    const full = useTurnDiffs(12, files, expanded, load);
    return createElement(
      "div",
      null,
      createElement("pre", null, full.error ?? JSON.stringify(full.diffs(file))),
      createElement("button", { onClick: full.retry }, "retry"),
    );
  }
  try {
    await act(async () => root.render(createElement(View)));
    expect(load).not.toHaveBeenCalled();
    expanded = new Set(["a.ts"]);
    await act(async () => root.render(createElement(View)));
    expect(load).toHaveBeenLastCalledWith(12, "a.ts");
    expect(host.textContent).toContain("Temporary diff error");
    await act(async () => host.querySelector("button")?.click());
    expect(load).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain("first full diff");
    await act(async () => root.render(createElement(View)));
    expect(load).toHaveBeenCalledTimes(2);
    file = { ...file, revision: "v2" };
    files = [file];
    load.mockResolvedValueOnce([
      { path: "a.ts", oldText: "old", newText: "new full diff, same counts" },
    ]);
    await act(async () => root.render(createElement(View)));
    expect(load).toHaveBeenCalledTimes(3);
    expect(host.textContent).toContain("new full diff, same counts");
    expect(host.textContent).not.toContain("first full diff");
  } finally {
    act(() => root.unmount());
  }
});
