// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  filterDelegationCommands,
  filterDelegationTargets,
  findDelegationTrigger,
  harnessCommandDisplayName,
  installRendererDelegationMention,
} from "../src/renderer-delegation-mention.js";
import { mutationMayAffectComposer } from "../src/renderer-binding-probe.js";

describe("delegation mention trigger", () => {
  it("detects # at a word start or after CJK text before the caret", () => {
    expect(findDelegationTrigger("#")).toEqual({ query: "", start: 0 });
    expect(findDelegationTrigger("please #cla")).toEqual({ query: "cla", start: 7 });
    for (const [text, query, start] of [
      ["请#", "", 1],
      ["帮我，#cla", "cla", 3],
      ["「#cla", "cla", 1],
      ["カタカナで#cla", "cla", 5],
      ["ラー#cla", "cla", 2],
      ["\u{20000}#cla", "cla", 2],
      ["＃", "", 0],
      ["请＃cla", "cla", 1],
      ["```py\nx\n```\n#cla", "cla", 12],
      ["```foo```\n#cla", "cla", 10],
      ["```foo``` #cla", "cla", 10],
      ["use `a` #cla", "cla", 8],
      ["use \\` literal #cla", "cla", 15],
      ["use \\\\\\` literal #cla", "cla", 17],
      ["`a\\` #cla", "cla", 5],
      ["`alpha\nbeta` #cla", "cla", 13],
      ["`alpha\n\n#cla", "cla", 8],
      ["`alpha\n```py\n```\n#cla", "cla", 17],
    ] as const) {
      expect(findDelegationTrigger(text), text).toEqual({ query, start });
    }
  });

  it("ignores # inside words, issue numbers, finished tokens and Markdown code", () => {
    expect(findDelegationTrigger("a#cla")).toBeNull();
    expect(findDelegationTrigger("fix #123")).toBeNull();
    expect(findDelegationTrigger("#claude ")).toBeNull();
    for (const text of [
      "C#",
      "issue#12",
      "&#39;",
      "x/#a",
      "한국어#cla",
      "Ａ#cla",
      "１#cla",
      "·#cla",
      "##",
      "＃＃",
      "#＃",
      "＃#",
      "fix ＃123",
      "```py\n#cla",
      "~~~\n#",
      "~~~foo~~~\n#cla",
      "```#",
      "use `#cla",
      "use \\\\`code #cla",
      "`alpha\n#cla",
      "`alpha\n  #cla",
    ]) {
      expect(findDelegationTrigger(text), text).toBeNull();
    }
  });
});

describe("delegation target filtering", () => {
  const targets = [
    { agent: "codex", label: "Codex" },
    { agent: "claude-code", label: "Claude Code" },
    { agent: "omp", label: "Oh My Pi" },
  ] as const;

  it("prefers prefix matches over substring matches", () => {
    expect(filterDelegationTargets(targets, "c").map(({ agent }) => agent)).toEqual([
      "codex",
      "claude-code",
    ]);
    expect(filterDelegationTargets(targets, "pi").map(({ agent }) => agent)).toEqual(["omp"]);
    expect(filterDelegationTargets(targets, "")).toHaveLength(3);
    expect(filterDelegationTargets(targets, "zzz")).toEqual([]);
  });
});

describe("delegation command filtering", () => {
  const commands = [
    { id: "compact", invocation: "/compact", label: "Compact", argumentMode: "text" },
    { id: "init", invocation: "/init", label: "Init", argumentMode: "none" },
    { id: "recap", invocation: "/recap", label: "Session recap", argumentMode: "none" },
  ] as unknown as Parameters<typeof filterDelegationCommands>[0];

  it("matches invocations with or without the slash and labels", () => {
    expect(filterDelegationCommands(commands, "").map(({ id }) => id)).toEqual([
      "compact",
      "init",
      "recap",
    ]);
    expect(filterDelegationCommands(commands, "/in").map(({ id }) => id)).toEqual(["init"]);
    expect(filterDelegationCommands(commands, "session").map(({ id }) => id)).toEqual(["recap"]);
    expect(filterDelegationCommands(commands, "c").map(({ id }) => id)).toEqual([
      "compact",
      "recap",
    ]);
  });
});

describe("Harness command display names", () => {
  it("humanizes slugs and keeps readable labels", () => {
    expect(harnessCommandDisplayName("/skill:writing-for-agents")).toBe("Writing For Agents");
    expect(harnessCommandDisplayName("frontend-design:frontend-design")).toBe("Frontend Design");
    expect(harnessCommandDisplayName("code_review")).toBe("Code Review");
    expect(harnessCommandDisplayName("Initialize CLAUDE.md")).toBe("Initialize CLAUDE.md");
    expect(harnessCommandDisplayName("压缩上下文")).toBe("压缩上下文");
  });
});

describe("installRendererDelegationMention hot-path optimizations", () => {
  const disposers: (() => void)[] = [];

  afterEach(() => {
    for (const dispose of disposers.splice(0)) dispose();
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  function setupEditor(text: string) {
    const element = document.createElement("div");
    element.setAttribute("contenteditable", "true");
    element.textContent = text;
    document.body.append(element);
    const node = element.firstChild as Text;
    const selection = document.getSelection();
    if (!selection) throw new Error("Missing selection");
    selection.setBaseAndExtent(node, text.length, node, text.length);
    return { element, node };
  }

  it("coalesces same-frame input/selectionchange, skips DOM rebuild on sameQuery with unchanged catalog, and only scrolls on activeIndex change", () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });

    const rafCallbacks: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});

    const { element } = setupEditor("#c");
    const targets = [
      { agent: "codex" as const, label: "Codex" },
      { agent: "claude-code" as const, label: "Claude Code" },
    ];
    let currentTargets = targets;

    const menu = installRendererDelegationMention(document, {
      readTargets: () => currentTargets.map((item) => ({ ...item })),
      isComposerEditor: () => true,
      readLocale: () => "en",
      anchorForEditor: () => element,
      readCommands: () => null,
    });
    disposers.push(() => menu.dispose());

    const listbox = document.querySelector(
      "[data-codexhost-delegation-mention-menu] [role=listbox]",
    );
    if (!listbox) throw new Error("Missing listbox");
    const replaceSpy = vi.spyOn(listbox, "replaceChildren");

    // Initial input renders once; initial activeIndex stays 0 so scrollIntoView is not called.
    element.dispatchEvent(new Event("input", { bubbles: true }));
    expect(replaceSpy).toHaveBeenCalledTimes(1);
    expect(scrollIntoView).not.toHaveBeenCalled();

    // Same-frame selectionchange coalesces into the scheduled frame, and when flushed
    // with the same query and unchanged catalog it skips rebuilding DOM completely.
    document.dispatchEvent(new Event("selectionchange"));
    document.dispatchEvent(new Event("selectionchange"));
    expect(replaceSpy).toHaveBeenCalledTimes(1);
    for (const cb of rafCallbacks.splice(0)) cb(16);
    expect(replaceSpy).toHaveBeenCalledTimes(1);

    // Explicit refresh with unchanged catalog also skips render.
    menu.refresh();
    expect(replaceSpy).toHaveBeenCalledTimes(1);

    // Catalog change with sameQuery does re-render.
    currentTargets = [...targets, { agent: "claude-code" as const, label: "Claude Code 2" }];
    menu.refresh();
    expect(replaceSpy).toHaveBeenCalledTimes(2);
    expect(scrollIntoView).not.toHaveBeenCalled();

    // Keyboard navigation changes activeIndex -> scrollIntoView runs once.
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", cancelable: true }));
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });
});

describe("mutationMayAffectComposer delegation mention filtering", () => {
  afterEach(() => {
    document.body.replaceChildren();
    document.head.replaceChildren();
  });

  it("ignores mutations inside or mounting the injected delegation mention menu and style", () => {
    const menu = document.createElement("div");
    menu.setAttribute("data-codexhost-delegation-mention-menu", "true");
    const option = document.createElement("div");
    option.setAttribute("role", "option");
    menu.append(option);
    document.body.append(menu);

    const style = document.createElement("style");
    style.setAttribute("data-codexhost-delegation-mention-style", "true");
    document.head.append(style);

    const makeMutation = (overrides: Partial<MutationRecord>): MutationRecord =>
      ({
        type: "childList",
        target: menu,
        addedNodes: [] as unknown as NodeList,
        removedNodes: [] as unknown as NodeList,
        attributeName: null,
        ...overrides,
      }) as MutationRecord;

    expect(mutationMayAffectComposer(makeMutation({ target: menu }))).toBe(false);
    expect(
      mutationMayAffectComposer(
        makeMutation({ target: option, type: "attributes", attributeName: "aria-selected" }),
      ),
    ).toBe(false);
    expect(mutationMayAffectComposer(makeMutation({ target: style, type: "childList" }))).toBe(
      false,
    );
    expect(
      mutationMayAffectComposer(
        makeMutation({
          target: document.body,
          addedNodes: [menu] as unknown as NodeList,
        }),
      ),
    ).toBe(false);

    // Unrelated DOM nodes on document.body still trigger Composer checks.
    const unrelated = document.createElement("div");
    expect(
      mutationMayAffectComposer(
        makeMutation({
          target: document.body,
          addedNodes: [unrelated] as unknown as NodeList,
        }),
      ),
    ).toBe(true);
  });
});
