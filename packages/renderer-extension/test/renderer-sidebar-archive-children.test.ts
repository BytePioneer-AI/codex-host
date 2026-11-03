import { hostThreadIdSchema, type HostThreadId } from "@codexhost/shared-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ArchiveChildrenMode } from "../src/renderer-archive-children-preference.js";
import {
  archiveActionFromSidebarRowElement,
  archiveChildrenMessages,
  createArchiveChildrenCascade,
  type ArchiveChildFailure,
  type ArchiveChildrenChoice,
} from "../src/renderer-sidebar-archive-children.js";

const id = (value: string): HostThreadId => hostThreadIdSchema.parse(value);

function harness(options: {
  mode?: ArchiveChildrenMode;
  children?: string[];
  choice?: ArchiveChildrenChoice;
  active?: boolean;
  /** Children whose row has no archive action. */
  unavailable?: string[];
  /** Children whose archive starts but never confirms. */
  stuck?: string[];
}) {
  let mode: ArchiveChildrenMode = options.mode ?? "ask";
  const listed = new Set(options.children ?? []);
  const archived: string[] = [];
  const asked: string[][] = [];
  const failures: ArchiveChildFailure[][] = [];
  const cascade = createArchiveChildrenCascade({
    mode: () => mode,
    setMode: (next) => {
      mode = next;
    },
    isActive: () => options.active ?? true,
    descendants: () => [...listed].map(id),
    ask: async ({ children }) => {
      asked.push([...children]);
      return options.choice ?? { archiveChildren: true, remember: false };
    },
    archive: (hostId, threadId) => {
      if (options.unavailable?.includes(threadId)) return false;
      archived.push(threadId);
      if (!options.stuck?.includes(threadId)) {
        // Desktop removes the row and then broadcasts `thread/archived`.
        queueMicrotask(() => {
          listed.delete(threadId);
          cascade.threadArchived(hostId, threadId);
        });
      }
      return true;
    },
    isListed: (_hostId, threadId) => listed.has(threadId),
    reportFailures: (_hostId, failed) => failures.push([...failed]),
    confirmTimeoutMs: 1_000,
    pollMs: 100,
  });
  return { cascade, archived, asked, failures, mode: () => mode };
}

describe("archive children cascade", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("asks, then archives every live child once through the native action", async () => {
    const test = harness({ children: ["child", "grandchild"] });
    test.cascade.threadArchived("local", id("root"));
    await vi.runAllTimersAsync();

    expect(test.asked).toEqual([["child", "grandchild"]]);
    expect(test.archived).toEqual(["child", "grandchild"]);
    expect(test.failures).toEqual([]);
    expect(test.mode()).toBe("ask");
  });

  it("archives only the parent when the user declines, and remembers the choice", async () => {
    const test = harness({
      children: ["child"],
      choice: { archiveChildren: false, remember: true },
    });
    test.cascade.threadArchived("local", id("root"));
    await vi.runAllTimersAsync();

    expect(test.archived).toEqual([]);
    expect(test.mode()).toBe("never");
  });

  it("remembers always and stops asking", async () => {
    const test = harness({
      children: ["child"],
      choice: { archiveChildren: true, remember: true },
    });
    test.cascade.threadArchived("local", id("root"));
    await vi.runAllTimersAsync();
    expect(test.mode()).toBe("always");
    expect(test.asked).toHaveLength(1);
  });

  it("follows the configured mode without asking", async () => {
    const always = harness({ mode: "always", children: ["child"] });
    always.cascade.threadArchived("local", id("root"));
    await vi.runAllTimersAsync();
    expect(always.asked).toEqual([]);
    expect(always.archived).toEqual(["child"]);

    const never = harness({ mode: "never", children: ["child"] });
    never.cascade.threadArchived("local", id("root"));
    await vi.runAllTimersAsync();
    expect(never.asked).toEqual([]);
    expect(never.archived).toEqual([]);
  });

  it("ignores Threads without children and windows the user did not archive from", async () => {
    const leaf = harness({ children: [] });
    leaf.cascade.threadArchived("local", id("root"));
    const background = harness({ children: ["child"], active: false });
    background.cascade.threadArchived("local", id("root"));
    await vi.runAllTimersAsync();
    expect(leaf.asked).toEqual([]);
    expect(background.asked).toEqual([]);
    expect(background.archived).toEqual([]);
  });

  it("reports children it could not archive without stopping the others", async () => {
    const test = harness({
      mode: "always",
      children: ["missing", "stuck", "child"],
      unavailable: ["missing"],
      stuck: ["stuck"],
    });
    test.cascade.threadArchived("local", id("root"));
    await vi.runAllTimersAsync();

    expect(test.archived).toEqual(["stuck", "child"]);
    expect(test.failures).toEqual([
      [
        { threadId: "missing", reason: "unavailable" },
        { threadId: "stuck", reason: "timeout" },
      ],
    ]);
  });
});

describe("archiveActionFromSidebarRowElement", () => {
  const attributes = {
    "data-app-action-sidebar-thread-row": "",
    "data-app-action-sidebar-thread-id": "local:thread",
    "data-app-action-sidebar-thread-host-id": "local",
  };
  const row = (fiber: unknown): HTMLElement => {
    const element = {
      getAttribute: (name: string) => (attributes as Record<string, string>)[name] ?? null,
    };
    Object.defineProperty(element, "__reactFiber$test", { value: fiber, enumerable: false });
    return element as unknown as HTMLElement;
  };

  it("calls the row's own onArchive matched by its data attributes", () => {
    const onArchive = vi.fn();
    const other = vi.fn();
    const action = archiveActionFromSidebarRowElement(
      row({
        memoizedProps: {},
        return: {
          memoizedProps: {
            onArchive: other,
            dataAttributes: { ...attributes, "data-app-action-sidebar-thread-id": "local:other" },
          },
          return: { memoizedProps: { onArchive, dataAttributes: attributes } },
        },
      }),
    );
    action?.();
    expect(onArchive).toHaveBeenCalledOnce();
    expect(other).not.toHaveBeenCalled();
  });

  it("returns null when no matching archive handler exists", () => {
    expect(archiveActionFromSidebarRowElement(row({ memoizedProps: {} }))).toBeNull();
  });
});

describe("archiveChildrenMessages", () => {
  it("localizes the dialog in Chinese", () => {
    const messages = archiveChildrenMessages("zh-CN");
    expect(messages.title).toBe("同时归档子会话？");
    expect(messages.archiveAll(2)).toBe("同时归档 2 个子会话");
    expect(messages.remember).toBe("记住我的选择");
    expect(archiveChildrenMessages("en").archiveAll(1)).toBe("Also archive 1 child");
  });
});
