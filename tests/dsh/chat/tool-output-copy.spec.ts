// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { TerminalBlock } from "../../../apps/web-ui/packages/client/ui-primitives/src/TerminalBlock.tsx";

const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  vi.unstubAllGlobals();
});

it("uses the terminal card's single existing copy control to resolve full output before writing", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const writeText = vi.fn(async () => {});
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  const gate = Promise.withResolvers<string>();
  const read = vi.fn(() => gate.promise);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  cleanups.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  await act(async () =>
    root.render(
      createElement(TerminalBlock, {
        command: "diagnose",
        output: "preview",
        copyText: read,
        labels: {
          signal: String,
          exitCode: String,
          noExitCode: "none",
          running: "running",
          failed: "failed",
          done: "done",
          copy: "Copy",
          copied: "Copied",
          noOutput: "empty",
          collapseAria: "collapse",
          collapse: "collapse",
          expandAria: String,
          expand: String,
        },
      }),
    ),
  );
  const buttons = container.querySelectorAll("button");
  expect(buttons).toHaveLength(1);
  await act(async () => buttons[0]?.click());
  expect(read).toHaveBeenCalledTimes(1);
  expect(writeText).not.toHaveBeenCalled();
  await act(async () => {
    gate.resolve("complete output");
    await gate.promise;
  });
  expect(writeText).toHaveBeenCalledExactlyOnceWith("complete output");
  expect(container.querySelectorAll("button")).toHaveLength(1);
  expect(container.textContent).toContain("Copied");
});

it("does not copy preview text or show success when the async text read fails", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const writeText = vi.fn(async () => {});
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  cleanups.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  await act(async () =>
    root.render(
      createElement(TerminalBlock, {
        command: "diagnose",
        output: "preview",
        copyText: async () => {
          throw new Error("stale");
        },
        labels: {
          signal: String,
          exitCode: String,
          noExitCode: "none",
          running: "running",
          failed: "failed",
          done: "done",
          copy: "Copy",
          copied: "Copied",
          noOutput: "empty",
          collapseAria: "collapse",
          collapse: "collapse",
          expandAria: String,
          expand: String,
        },
      }),
    ),
  );
  await act(async () => container.querySelector("button")?.click());
  expect(writeText).not.toHaveBeenCalled();
  expect(container.textContent).not.toContain("Copied");
});
